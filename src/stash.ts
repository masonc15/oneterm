import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { closeTerminals, listTabs, type Tab } from "./ghostty.ts";
import { alive, foreground, livePis, snapshot } from "./procs.ts";
import { agentFileExists, cancelAgent, pollAgent, remoteAgent, requestAgent } from "./agents.ts";
import {
	ACK_DIR,
	config,
	displayCwd,
	ensureDirs,
	type Group,
	load,
	type Item,
	logHistory,
	newId,
	REQUEST_DIR,
	readJson,
	update,
	writeAtomic,
} from "./store.ts";

export type Scope = "all" | "others" | "this";

export interface StashOptions {
	scope: Scope;
	/** pid of a process inside "this" tab (the pi that ran /oneterm); defaults to the selected tab. */
	fromPid?: number;
	/** Also stash tabs running other programs, saving the command line to retype on restore. */
	force?: boolean;
	note?: string;
	/** Only these tab ids (testing). */
	tabIds?: string[];
	timeoutMs?: number;
	/** Report what would happen without saving or closing anything. */
	dryRun?: boolean;
}

export interface StashResult {
	groupId: string | null;
	stashed: string[];
	pending: string[];
	skipped: { title: string; reason: string }[];
	/** Tabs that were (or, in a dry run, would be) closed. */
	tabs: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function stripGlyph(title: string) {
	// Drop status glyphs and pi's "π " prefix in front, and the shell's "·<tty>" suffix.
	const clean = title.replace(/^[^\p{L}\p{N}~/.]+/u, "").replace(/^π\s+(-\s+)?/u, "").replace(/·\d+$/, "").trim();
	return clean || title;
}

export interface TabCounts {
	/** Tabs a stash would close. */
	tabs: number;
	/** Their titles, and what is in them (a tab with any pi counts as pi). */
	stash: { title: string; kind: Item["kind"] }[];
	/** Tabs it would leave open, and why. */
	kept: { title: string; reason: string }[];
}

/** One open tab, for the page's tab picker. */
export interface TabRow {
	/** "tabId/terminalId", what the page sends back as StashOptions.picked. */
	key: string;
	title: string;
	kind: Item["kind"];
	/** Why a stash would leave it open, if it would. */
	kept: string | null;
	/** The selected tab of the front Ghostty window. */
	front: boolean;
}

/** What "stash all" would do right now, and every open tab, from one look at Ghostty. */
export function countTabs(): { all: TabCounts; list: TabRow[]; open: number; cap: number } {
	const tabs = listTabs();
	const procs = snapshot();
	const live = livePis();
	const counted = tabs.map((tab) => ({ tab, c: classifyTab(tab, procs, live, false) }));
	// A tab with any pi counts as pi, and is named after it.
	const label = (c: Classified) => {
		const kinds = c.tabItems.map((i) => i.kind);
		const kind = (["pi", "claude", "codex", "ssh", "command"] as const).find((k) => kinds.includes(k)) ?? "shell";
		return { title: c.tabItems.find((i) => i.kind === kind)?.title ?? c.title, kind };
	};
	const all: TabCounts = {
		tabs: counted.filter((x) => !x.c.skip).length,
		stash: counted.filter((x) => !x.c.skip).map((x) => label(x.c)),
		kept: counted.filter((x) => x.c.skip).map((x) => ({ title: x.c.title, reason: x.c.skip! })),
	};
	const list = counted.map(({ tab, c }): TabRow => ({
		key: `${tab.id}/${tab.terminals[0]?.id}`,
		...(c.skip ? { title: c.title, kind: "command" as const } : label(c)),
		kept: c.skip,
		front: tab.windowIndex === 0 && tab.selected,
	}));
	return { all, list, open: tabs.length, cap: config().tabCap };
}

/** The tab holding the tty of `pid` (or its nearest ancestor with a tty). */
function tabOfPid(tabs: Tab[], pid: number, procs: ReturnType<typeof snapshot>): Tab | undefined {
	const byPid = new Map(procs.map((p) => [p.pid, p]));
	let p = byPid.get(pid);
	while (p && (p.tty === "??" || !p.tty)) p = byPid.get(p.ppid);
	if (!p) return undefined;
	return tabs.find((t) => t.terminals.some((x) => x.tty.replace(/^\/dev\//, "") === p!.tty));
}

function pickTabs(tabs: Tab[], opts: StashOptions, procs: ReturnType<typeof snapshot>): Tab[] {
	if (opts.tabIds?.length) return tabs.filter((t) => opts.tabIds!.includes(t.id));
	if (opts.scope === "all") return tabs;
	const current = opts.fromPid ? tabOfPid(tabs, opts.fromPid, procs) : tabs.find((t) => t.windowIndex === 0 && t.selected);
	if (!current) throw new Error("oneterm: could not tell which tab is the current one");
	return opts.scope === "this" ? [current] : tabs.filter((t) => t.id !== current.id);
}

interface Classified {
	title: string;
	tabItems: Item[];
	/** Why the tab stays open, if it does. */
	skip: string | null;
}

/** Turn one tab's terminals into stash items, or say why the tab has to stay open. */
function classifyTab(tab: Tab, procs: ReturnType<typeof snapshot>, live: ReturnType<typeof livePis>, force: boolean, fresh = false): Classified {
	const title = stripGlyph(tab.name);
	const waiting = new Set(load().groups.flatMap((g) => g.items.filter((i) => i.status === "pending").map((i) => i.terminalId)));
	if (tab.terminals.some((t) => waiting.has(t.id))) return { title, tabItems: [], skip: "already stashing" };
	const tabItems: Item[] = [];
	let skip: string | null = null;
	for (const term of tab.terminals) {
		const fg = foreground(term.tty, procs, live);
		const base = { id: newId("i"), title, cwd: term.cwd, tabKey: tab.id, terminalId: term.id };
		if (fg.kind === "shell") tabItems.push({ ...base, kind: "shell", status: "stashed", title: displayCwd(term.cwd) });
		else if (fg.kind === "ssh") {
			const r = remoteAgent(fg.pid, fg.command, term.cwd, fresh);
			if (r.skip) skip = r.skip;
			else if (r.live) {
				const a = r.live;
				tabItems.push({ ...base, kind: a.kind, status: "pending", cwd: a.cwd,
					title: a.name ?? `${a.kind} on ${r.remote.host}: ${a.cwd}`, name: a.name ?? undefined,
					sessionId: a.sessionId, sessionFile: a.sessionFile ?? undefined, pid: a.pid, identity: a.identity, remote: r.remote });
			} else if (r.cwd) tabItems.push({ ...base, kind: "shell", status: "stashed", cwd: r.cwd,
				title: `${r.remote.host}: ${r.cwd}`, remote: r.remote });
			else skip = "SSH helper returned no terminal";
		}
		else if (fg.kind === "pi" || fg.kind === "claude" || fg.kind === "codex") {
			tabItems.push({
				...base,
				kind: fg.kind,
				status: "pending",
				cwd: fg.live.cwd,
				// An unnamed pi's tab title is just its folder name; say what it is.
				title: fg.live.name ? stripGlyph(fg.live.name) : `${fg.kind} in ${displayCwd(fg.live.cwd)}`,
				name: fg.live.name ?? undefined,
				sessionId: fg.live.sessionId,
				sessionFile: fg.live.sessionFile ?? undefined,
				pid: fg.pid,
				identity: fg.live.identity,
			});
		} else if (fg.kind === "pi-unregistered") {
			skip = "pi needs /reload-all";
		} else if (fg.kind === "agent-unregistered") {
			skip = fg.agent === "codex" ? "Codex needs trusted /hooks and --no-daemon" : "Claude Code needs oneterm hooks";
		} else if (force) {
			tabItems.push({ ...base, kind: "command", status: "stashed", command: fg.command });
		} else {
			skip = `running ${fg.command.split(/\s+/)[0].split("/").pop()}`;
		}
	}
	return { title, tabItems, skip };
}

export function stash(opts: StashOptions): StashResult {
	ensureDirs();
	const tabs = listTabs();
	const procs = snapshot();
	const live = livePis();
	const chosen = pickTabs(tabs, opts, procs);
	const result: StashResult = { groupId: null, stashed: [], pending: [], skipped: [], tabs: 0 };

	const items: Item[] = [];
	const closeNow: string[] = [];
	const requests: { pid: number; item: Item }[] = [];

	for (const tab of chosen) {
		const { title, tabItems, skip } = classifyTab(tab, procs, live, Boolean(opts.force), true);
		if (skip) {
			result.skipped.push({ title, reason: skip });
			continue;
		}
		result.tabs++;
		for (const item of tabItems) {
			items.push(item);
			if (item.status === "pending") {
				requests.push({ pid: item.pid!, item });
				result.pending.push(item.title);
			} else {
				closeNow.push(item.terminalId!);
				result.stashed.push(item.title);
			}
		}
	}

	if (!items.length || opts.dryRun) return result;

	const group: Group = { id: newId("g"), createdAt: new Date().toISOString(), items };
	if (opts.note) group.note = opts.note;
	result.groupId = group.id;
	update((s) => {
		s.groups.push(group);
	});
	logHistory("stash", group);

	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	for (const { pid, item } of requests) {
		if (item.remote || item.kind !== "pi") {
			try { requestAgent(item, group.id, timeoutMs); }
			catch {
				update((s) => { const g = s.groups.find((g) => g.id === group.id); if (g) g.items = g.items.filter((i) => i.id !== item.id); });
				result.pending = result.pending.filter((t) => t !== item.title);
				result.skipped.push({ title: item.title, reason: "agent changed or helper unavailable; left open" });
			}
		} else {
			rmSync(join(ACK_DIR, `${pid}.json`), { force: true });
			writeAtomic(join(REQUEST_DIR, `${pid}.json`), JSON.stringify({ groupId: group.id, itemId: item.id, timeoutMs, sessionId: item.sessionId, identity: item.identity, expiresAt: Date.now() / 1000 + timeoutMs / 1000 }));
		}
	}
	if (requests.length) spawnReaper(group.id, timeoutMs);
	closeTerminals(closeNow);
	return result;
}

function spawnReaper(groupId: string, timeoutMs: number) {
	const child = spawn(process.execPath, [new URL("./cli.ts", import.meta.url).pathname, "_reap", groupId, String(timeoutMs)], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

interface Ack {
	itemId: string;
	sessionId: string;
	sessionFile: string | null;
	cwd: string;
	name: string | null;
	interrupted: boolean;
	lastUser: string;
	lastAssistant: string;
}

/**
 * Background half of a stash: wait for an exit or confirmed native thread end,
 * record the acknowledgement, then close the terminal. Unconfirmed stops stay open.
 */
export async function reap(groupId: string, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs + 20_000;
	for (;;) {
		const group = load().groups.find((g) => g.id === groupId);
		const pending = group?.items.filter((i) => i.status === "pending") ?? [];
		if (!pending.length) return;

		const done: string[] = [];
		const finished: { item: Item; ack: Ack | null }[] = [];
		const failed = new Set<string>();
		for (const item of pending) {
			if (item.remote || item.kind !== "pi") {
				try {
					const p = pollAgent(item);
					if (p.failed) { failed.add(item.id); continue; }
					if (!p.done || !p.ack) continue;
					if (p.ack.sessionFile && !agentFileExists({ ...item, sessionFile: p.ack.sessionFile })) { failed.add(item.id); continue; }
					finished.push({ item, ack: p.ack as Ack });
				} catch { continue; } // A network error is not proof of process exit.
			} else {
				if (alive(item.pid!)) continue;
				finished.push({ item, ack: readJson<Ack>(join(ACK_DIR, `${item.pid}.json`)) });
			}
			done.push(item.terminalId!);
		}
		if (failed.size) {
			update((s) => { const g = s.groups.find((g) => g.id === groupId); if (g) g.items = g.items.filter((i) => !failed.has(i.id)); });
			for (const item of pending.filter((i) => failed.has(i.id))) { try { cancelAgent(item); } catch {} }
			logHistory("reap-failed", { groupId, items: [...failed] });
		}
		if (finished.length) {
			update((s) => {
				const g = s.groups.find((x) => x.id === groupId);
				if (!g) return;
				for (const { item, ack } of finished) {
					const target = g.items.find((i) => i.id === item.id);
					if (!target) continue;
					// pi writes nothing until the first message; like a blank browser tab, it isn't worth keeping.
					const file = ack ? ack.sessionFile : target.sessionFile;
					if (!file || (!target.remote && !existsSync(file))) {
						g.items = g.items.filter((i) => i !== target);
						continue;
					}
					target.status = "stashed";
					if (ack) {
						target.sessionId = ack.sessionId;
						target.sessionFile = ack.sessionFile ?? target.sessionFile;
						target.cwd = ack.cwd;
						if (ack.name) target.title = target.name = ack.name;
						target.lastUser = ack.lastUser || undefined;
						target.lastAssistant = ack.lastAssistant || undefined;
						target.interrupted = ack.interrupted || undefined;
					}
					delete target.pid;
					delete target.identity;
				}
			});
			for (const { item } of finished) {
				if (item.remote || item.kind !== "pi") { try { cancelAgent(item); } catch {} }
				else rmSync(join(ACK_DIR, `${item.pid}.json`), { force: true });
			}
			closeTerminals(done);
		}

		if (Date.now() > deadline) {
			// Whatever is still running stays open; drop it from the stash.
			update((s) => {
				const g = s.groups.find((x) => x.id === groupId);
				if (g) g.items = g.items.filter((i) => i.status !== "pending");
			});
			for (const item of pending) {
				if (item.remote || item.kind !== "pi") { try { cancelAgent(item); } catch {} }
				else rmSync(join(REQUEST_DIR, `${item.pid}.json`), { force: true });
			}
			logHistory("reap-timeout", { groupId, items: pending.map((i) => i.id) });
			return;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
}
