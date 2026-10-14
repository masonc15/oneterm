import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = process.env.ONETERM_HOME || join(homedir(), ".oneterm");
export const LIVE_DIR = join(HOME, "live");
export const REQUEST_DIR = join(HOME, "requests");
export const ACK_DIR = join(HOME, "acks");
const STASH_FILE = join(HOME, "stash.json");
const MARKDOWN_FILE = join(HOME, "stash.md");
const HISTORY_FILE = join(HOME, "history.jsonl");
const LOCK_DIR = join(HOME, "stash.lock");

export type ItemKind = "pi" | "claude" | "codex" | "shell" | "ssh" | "command";
export type ItemStatus = "pending" | "stashed";

export interface Item {
	id: string;
	kind: ItemKind;
	title: string;
	cwd: string;
	status: ItemStatus;
	/** Ghostty tab this terminal shared with others; restore reopens them as splits. */
	tabKey: string;
	command?: string;
	sessionId?: string;
	sessionFile?: string;
	name?: string;
	lastUser?: string;
	lastAssistant?: string;
	/** The agent was mid-task and stopped at a safe point; say "continue" after resuming. */
	interrupted?: boolean;
	pid?: number;
	/** Process birth token, checked before any native or remote stop. */
	identity?: string;
	remote?: { host: string; argv: string[]; localCwd: string };
	terminalId?: string;
}

export interface Group {
	id: string;
	createdAt: string;
	note?: string;
	items: Item[];
}

export interface Stash {
	version: 1;
	groups: Group[];
}

export interface Config {
	/** Nudge when more than this many Ghostty tabs are open; 0 turns the nudge off. */
	tabCap: number;
	/** While still over the cap, nudge again after this many minutes. */
	nudgeRepeatMinutes: number;
	/** SSH aliases on which the oneterm helper is installed. */
	remoteHosts: string[];
}

const DEFAULT_CONFIG: Config = { tabCap: 6, nudgeRepeatMinutes: 30, remoteHosts: [] };

/** Settings from ~/.oneterm/config.json, with defaults for anything missing. */
export function config(): Config {
	const raw = readJson<Partial<Config>>(join(HOME, "config.json")) ?? {};
	const num = (v: unknown, fallback: number) => (typeof v === "number" && v >= 0 ? v : fallback);
	return {
		tabCap: num(raw.tabCap, DEFAULT_CONFIG.tabCap),
		nudgeRepeatMinutes: num(raw.nudgeRepeatMinutes, DEFAULT_CONFIG.nudgeRepeatMinutes),
		remoteHosts: Array.isArray(raw.remoteHosts) ? raw.remoteHosts.filter((h): h is string => typeof h === "string" && /^[\w@.-]+$/.test(h)) : [],
	};
}

export function ensureDirs() {
	for (const dir of [HOME, LIVE_DIR, REQUEST_DIR, ACK_DIR]) mkdirSync(dir, { recursive: true });
}

export function newId(prefix: string) {
	return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function readJson<T>(path: string): T | null {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return null;
	}
}

export function writeAtomic(path: string, data: string) {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, data);
	renameSync(tmp, path);
}

export function load(): Stash {
	return readJson<Stash>(STASH_FILE) ?? { version: 1, groups: [] };
}

function sleepSync(ms: number) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Read-modify-write the stash under a lock shared by the CLI, the reaper, and the web server. */
export function update<T>(fn: (stash: Stash) => T): T {
	ensureDirs();
	const deadline = Date.now() + 5_000;
	for (;;) {
		try {
			mkdirSync(LOCK_DIR);
			break;
		} catch {
			// A crashed writer can leave the lock behind; nothing holds it for more than a moment.
			try {
				if (Date.now() - statSync(LOCK_DIR).mtimeMs > 10_000) rmSync(LOCK_DIR, { recursive: true, force: true });
			} catch {}
			if (Date.now() > deadline) throw new Error("oneterm: stash is locked");
			sleepSync(25);
		}
	}
	try {
		const stash = load();
		const result = fn(stash);
		stash.groups = stash.groups.filter((g) => g.items.length > 0);
		writeAtomic(STASH_FILE, `${JSON.stringify(stash, null, 2)}\n`);
		writeAtomic(MARKDOWN_FILE, toMarkdown(stash));
		return result;
	} finally {
		rmSync(LOCK_DIR, { recursive: true, force: true });
	}
}

export function logHistory(event: string, data: unknown) {
	ensureDirs();
	appendFileSync(HISTORY_FILE, `${JSON.stringify({ at: new Date().toISOString(), event, data })}\n`);
}

export function findItem(stash: Stash, itemId: string): { group: Group; item: Item } | null {
	for (const group of stash.groups) {
		const item = group.items.find((i) => i.id === itemId);
		if (item) return { group, item };
	}
	return null;
}

export function restoreCommand(item: Item): string | undefined {
	let command: string | undefined;
	if (item.kind === "pi" && item.sessionFile) command = `pi --session ${shellQuote(item.sessionFile)}`;
	else if (item.kind === "claude" && item.sessionId) command = `claude --resume ${shellQuote(item.sessionId)}`;
	else if (item.kind === "codex" && item.sessionId) command = `codex --no-daemon resume ${shellQuote(item.sessionId)}`;
	else if (item.kind === "ssh" || item.kind === "command") command = item.command;
	if (item.remote) {
		// Login shell supplies the remote agent's PATH, even on hosts with lazy initialization.
		const body = `export PATH="$HOME/.local/bin:$PATH"; cd -- ${shellQuote(item.cwd)} && ${command ? `exec ${command}` : 'exec "$SHELL" -l'}`;
		const argv = item.remote.argv.filter((a) => a !== "-t" && a !== "-tt");
		return `ssh -t ${argv.map(shellQuote).join(" ")} ${shellQuote(`bash -lc ${shellQuote(body)}`)}`;
	}
	return command;
}

export function shellQuote(s: string) {
	return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function displayCwd(cwd: string) {
	const home = homedir();
	return cwd === home ? "~" : cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
}

export function sessionExists(item: Item) {
	return !item.sessionFile || existsSync(item.sessionFile);
}

function toMarkdown(stash: Stash): string {
	const lines = ["# oneterm stash", "", "Generated from stash.json. Edit through `oneterm`, not by hand.", ""];
	for (const group of [...stash.groups].reverse()) {
		const when = new Date(group.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
		lines.push(`## ${when} (${group.items.length} terminal${group.items.length === 1 ? "" : "s"})`, "");
		if (group.note) lines.push(`> ${group.note}`, "");
		for (const item of group.items) {
			const cmd = restoreCommand(item);
			lines.push(`- **${item.title}** in \`${displayCwd(item.cwd)}\`${cmd ? `: \`${cmd}\`` : ""}${item.status === "pending" ? " (stashing…)" : ""}`);
			if (item.lastAssistant) lines.push(`  - ${item.lastAssistant}`);
		}
		lines.push("");
	}
	return `${lines.join("\n")}\n`;
}
