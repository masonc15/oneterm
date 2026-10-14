import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { closeTerminals, listTabs, type Tab } from "./ghostty.ts";
import { alive, foreground, livePis, snapshot } from "./procs.ts";
import {
	ACK_DIR,
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
	/** Tabs it would leave open, and why. */
	kept: { title: string; reason: string }[];
}

/** What "stash all" and "stash others" would do right now, from one look at Ghostty. */
export function countTabs(): { all: TabCounts; others: TabCounts; open: number } {
	const tabs = listTabs();
	const procs = snapshot();
	const live = livePis();
	const counted = tabs.map((tab) => ({ tab, c: classifyTab(tab, procs, live, false) }));
	const tally = (list: typeof counted): TabCounts => ({
		tabs: list.filter((x) => !x.c.skip).length,
		kept: list.filter((x) => x.c.skip).map((x) => ({ title: x.c.title, reason: x.c.skip! })),
	});
	const current = tabs.find((t) => t.windowIndex === 0 && t.selected);
	return { all: tally(counted), others: tally(counted.filter((x) => x.tab !== current)), open: tabs.length };
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
function classifyTab(tab: Tab, procs: ReturnType<typeof snapshot>, live: ReturnType<typeof livePis>, force: boolean): Classified {
	const title = stripGlyph(tab.name);
	const tabItems: Item[] = [];
	let skip: string | null = null;
	for (const term of tab.terminals) {
		const fg = foreground(term.tty, procs, live);
		const base = { id: newId("i"), title, cwd: term.cwd, tabKey: tab.id, terminalId: term.id };
		if (fg.kind === "shell") tabItems.push({ ...base, kind: "shell", status: "stashed", title: displayCwd(term.cwd) });
		else if (fg.kind === "ssh") tabItems.push({ ...base, kind: "ssh", status: "stashed", command: fg.command });
		else if (fg.kind === "pi") {
			tabItems.push({
				...base,
				kind: "pi",
				status: "pending",
				cwd: fg.live.cwd,
				title: stripGlyph(fg.live.name || title),
				name: fg.live.name ?? undefined,
				sessionId: fg.live.sessionId,
				sessionFile: fg.live.sessionFile ?? undefined,
				pid: fg.pid,
			});
		} else if (fg.kind === "pi-unregistered") {
			skip = "pi started before oneterm was installed (run /reload-all)";
		} else if (force) {
			tabItems.push({ ...base, kind: "command", status: "stashed", command: fg.command });
		} else {
			skip = `running ${fg.command.split(/\s+/)[0]}`;
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
		const { title, tabItems, skip } = classifyTab(tab, procs, live, Boolean(opts.force));
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
		rmSync(join(ACK_DIR, `${pid}.json`), { force: true });
		writeAtomic(join(REQUEST_DIR, `${pid}.json`), JSON.stringify({ groupId: group.id, itemId: item.id, timeoutMs }));
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
 * Background half of a stash: wait for each pi to acknowledge and exit, record its
 * snapshot, and close its terminal. A pi that never exits keeps its tab and leaves the list.
 */
export async function reap(groupId: string, timeoutMs: number) {
	const deadline = Date.now() + timeoutMs + 20_000;
	for (;;) {
		const group = load().groups.find((g) => g.id === groupId);
		const pending = group?.items.filter((i) => i.status === "pending") ?? [];
		if (!pending.length) return;

		const done: string[] = [];
		const finished: { item: Item; ack: Ack | null }[] = [];
		for (const item of pending) {
			if (alive(item.pid!)) continue;
			finished.push({ item, ack: readJson<Ack>(join(ACK_DIR, `${item.pid}.json`)) });
			done.push(item.terminalId!);
		}
		if (finished.length) {
			update((s) => {
				const g = s.groups.find((x) => x.id === groupId);
				if (!g) return;
				for (const { item, ack } of finished) {
					const target = g.items.find((i) => i.id === item.id);
					if (!target) continue;
					// pi writes nothing until the first message; like a blank browser tab, it isn't worth keeping.
					const file = ack?.sessionFile ?? target.sessionFile;
					if (!file || !existsSync(file)) {
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
				}
			});
			for (const { item } of finished) rmSync(join(ACK_DIR, `${item.pid}.json`), { force: true });
			closeTerminals(done);
		}

		if (Date.now() > deadline) {
			// Whatever is still running stays open; drop it from the stash.
			update((s) => {
				const g = s.groups.find((x) => x.id === groupId);
				if (g) g.items = g.items.filter((i) => i.status !== "pending");
			});
			for (const item of pending) rmSync(join(REQUEST_DIR, `${item.pid}.json`), { force: true });
			logHistory("reap-timeout", { groupId, items: pending.map((i) => i.id) });
			return;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
}
