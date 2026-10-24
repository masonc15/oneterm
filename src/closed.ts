/**
 * Tabs that went away with Ghostty. When Ghostty quits, crashes, or goes down with a
 * reboot, it can bring back its windows and their folders, but not the programs that
 * were running in them. The agent keeps a record of what is running in every open
 * tab, and once the Ghostty that held them is gone, it saves those tabs to the stash.
 * Closing a tab or a window yourself doesn't count; only Ghostty itself going away does.
 */

import { closeSync, existsSync, fstatSync, openSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import { instance, listTabs } from "./ghostty.ts";
import { livePis, snapshot } from "./procs.ts";
import { classifyTab } from "./stash.ts";
import { type Group, HOME, type Item, logHistory, newId, readJson, type Stash, update, writeAtomic } from "./store.ts";

const OPEN_FILE = join(HOME, "open.json");
/** Agents rarely change behind an SSH tab, and each look is an ssh round trip. */
const PROBE_AGE_MS = 60_000;
const SNIPPET_CHARS = 280;
export const CLOSED_NOTE = "Ghostty closed with these still open.";

export interface OpenTabs {
	/** The Ghostty these tabs are in, from instance(). */
	ghostty: string;
	seenAt: string;
	/** Every terminal in the latest look at Ghostty. */
	items: Item[];
	/**
	 * Every terminal in the look before it. Ghostty closes its windows a moment before it
	 * exits, so the latest look can catch it empty; a terminal only drops out of what
	 * gets saved once two looks in a row miss it.
	 */
	previous: Item[];
}

/**
 * Save the tabs of a Ghostty that is gone, then record what's open in the running
 * one. Returns the number of open tabs, or null if Ghostty couldn't be read, plus the
 * group it saved, if any.
 */
export function checkTabs(): { open: number | null; saved: Group | null } {
	const ghostty = instance();
	const last = readJson<OpenTabs>(OPEN_FILE);
	let saved: Group | null = null;
	if (last && last.ghostty !== ghostty) {
		saved = saveClosed(last);
		rmSync(OPEN_FILE, { force: true });
	}
	if (!ghostty) return { open: 0, saved };

	let tabs: ReturnType<typeof listTabs>;
	try {
		tabs = listTabs();
	} catch {
		return { open: null, saved };
	}
	const procs = snapshot();
	const live = livePis();
	// Ghostty quit while we looked: these tabs may be half gone. The next check saves the last full record.
	if (instance() !== ghostty) return { open: null, saved };
	const items = tabs.flatMap((tab) => classifyTab(tab, procs, live, { record: true, probeAgeMs: PROBE_AGE_MS }).tabItems);
	const open: OpenTabs = { ghostty, seenAt: new Date().toISOString(), items, previous: last?.ghostty === ghostty ? last.items : [] };
	writeAtomic(OPEN_FILE, `${JSON.stringify(open)}\n`);
	return { open: tabs.length, saved };
}

function saveClosed(open: OpenTabs): Group | null {
	const group = update((s) => {
		const items = closedItems(open, s);
		if (!items.length) return null;
		const g: Group = { id: newId("g"), createdAt: open.seenAt, note: CLOSED_NOTE, items };
		s.groups.push(g);
		return g;
	});
	if (group) logHistory("closed", group);
	return group;
}

/**
 * What to save from a closed Ghostty's tabs: anything oneterm can bring back that
 * Ghostty can't. Local shells come back with Ghostty's own window restore; agents
 * that never wrote a session file have nothing to resume; and anything already in
 * the stash, like a tab stashed just before Ghostty quit, stays where it is.
 */
export function closedItems(open: OpenTabs, stash: Stash, exists: (path: string) => boolean = existsSync): Item[] {
	// The latest look wins; the one before only adds terminals it missed.
	const byTerminal = new Map<string, Item>();
	for (const item of [...open.items, ...open.previous]) {
		const key = item.terminalId ?? item.id;
		if (!byTerminal.has(key)) byTerminal.set(key, item);
	}
	const stashed = stash.groups.flatMap((g) => g.items);
	const terminals = new Set(stashed.map((i) => i.terminalId));
	// A session restored just before Ghostty quit was in two terminals; save it once.
	const sessions = new Set(stashed.map((i) => i.sessionId).filter(Boolean));
	const agent = (i: Item) => i.kind === "pi" || i.kind === "claude" || i.kind === "codex";

	const out: Item[] = [];
	for (const item of byTerminal.values()) {
		if (terminals.has(item.terminalId) || (item.sessionId && sessions.has(item.sessionId))) continue;
		if (item.sessionId) sessions.add(item.sessionId);
		if (item.kind === "shell" && !item.remote) continue;
		if (agent(item) && !item.remote && !(item.sessionFile && exists(item.sessionFile))) continue;
		const { pid: _pid, identity: _identity, ...rest } = item;
		const saved: Item = { ...rest, id: newId("i"), status: "stashed" };
		if (item.kind === "pi" && !item.remote && item.sessionFile) Object.assign(saved, piTail(item.sessionFile));
		out.push(saved);
	}
	return out;
}

function clip(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat;
}

interface PiMessage {
	role?: string;
	stopReason?: string;
	content?: unknown;
}

/**
 * The last thing said on each side of a pi session, read from the end of its file,
 * and whether it stopped mid-turn. pi has no hooks to report this as it goes.
 */
export function piTail(file: string): Pick<Item, "lastUser" | "lastAssistant" | "interrupted"> {
	let text = "";
	try {
		const fd = openSync(file, "r");
		try {
			const size = fstatSync(fd).size;
			const length = Math.min(size, 512 << 10);
			const buf = Buffer.alloc(length);
			readSync(fd, buf, 0, length, size - length);
			text = buf.toString("utf8");
			// Starting partway into the file cuts its first line.
			if (length < size) text = text.slice(text.indexOf("\n") + 1);
		} finally {
			closeSync(fd);
		}
	} catch {
		return {};
	}
	let lastUser = "";
	let lastAssistant = "";
	let last: PiMessage | null = null;
	for (const line of text.split("\n")) {
		let entry: { type?: string; message?: PiMessage };
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		last = message;
		const said = Array.isArray(message.content)
			? message.content.filter((b) => b?.type === "text").map((b) => b.text).join("\n")
			: typeof message.content === "string" ? message.content : "";
		if (!said.trim()) continue;
		if (message.role === "user") lastUser = clip(said);
		else if (message.role === "assistant") lastAssistant = clip(said);
	}
	const finished = last?.role === "assistant" && last.stopReason !== "toolUse";
	return { lastUser: lastUser || undefined, lastAssistant: lastAssistant || undefined, interrupted: (last !== null && !finished) || undefined };
}
