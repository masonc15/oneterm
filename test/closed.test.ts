import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
process.env.ONETERM_HOME = mkdtempSync(join(tmpdir(), "oneterm-closed-"));
const { closedItems, piTail } = await import("../src/closed.ts");
const { classifyTab } = await import("../src/stash.ts");
import type { Item, Stash } from "../src/store.ts";
import type { OpenTabs } from "../src/closed.ts";

const empty: Stash = { version: 1, groups: [] };
const files = new Set(["/s/pi.jsonl", "/s/claude.jsonl"]);
const exists = (p: string) => files.has(p);
const base = { title: "t", cwd: "/work", tabKey: "tab-1" };
const agent: Item = { ...base, id: "a", kind: "claude", status: "pending", terminalId: "T1", sessionId: "s-claude", sessionFile: "/s/claude.jsonl", pid: 42, identity: "start" };
const shell: Item = { ...base, id: "b", kind: "shell", status: "stashed", terminalId: "T2" };
const open = (items: Item[], previous: Item[] = []): OpenTabs => ({ ghostty: "1 start", seenAt: "2026-10-24T12:00:00.000Z", items, previous });

test("agents are saved ready to restore, without the dead process", () => {
	const [saved] = closedItems(open([agent]), empty, exists);
	assert.equal(saved.status, "stashed");
	assert.equal(saved.sessionId, "s-claude");
	assert.equal(saved.pid, undefined);
	assert.equal(saved.identity, undefined);
	assert.notEqual(saved.id, agent.id);
});

test("local shells are left to Ghostty's own window restore; remote ones are kept", () => {
	const remote: Item = { ...shell, terminalId: "T3", remote: { host: "devbox", argv: ["devbox"], localCwd: "/work" } };
	assert.deepEqual(closedItems(open([shell, remote]), empty, exists).map((i) => i.terminalId), ["T3"]);
});

test("agents with nothing on disk to resume are dropped, unless remote", () => {
	const blank: Item = { ...agent, kind: "pi", sessionFile: "/s/missing.jsonl" };
	const remote: Item = { ...blank, terminalId: "T9", sessionId: "s-remote", remote: { host: "devbox", argv: ["devbox"], localCwd: "/work" } };
	assert.deepEqual(closedItems(open([blank, remote]), empty, exists).map((i) => i.terminalId), ["T9"]);
});

test("a terminal missing from only the latest look is still saved", () => {
	const codex: Item = { ...agent, kind: "codex", terminalId: "T4", sessionId: "s-codex" };
	assert.deepEqual(closedItems(open([agent], [agent, codex]), empty, exists).map((i) => i.sessionId), ["s-claude", "s-codex"]);
});

test("the latest look wins: an agent that exited to its shell is not saved", () => {
	assert.deepEqual(closedItems(open([{ ...shell, terminalId: "T1" }], [agent]), empty, exists), []);
});

test("tabs already in the stash, or sessions saved twice, are saved once", () => {
	const stash: Stash = { version: 1, groups: [{ id: "g", createdAt: "x", items: [{ ...agent, status: "stashed" }] }] };
	assert.deepEqual(closedItems(open([agent]), stash, exists), []);
	assert.deepEqual(closedItems(open([{ ...agent, terminalId: "T7" }]), stash, exists), []);
	assert.equal(closedItems(open([agent], [{ ...agent, terminalId: "T8" }]), empty, exists).length, 1);
});

test("other programs keep their command line", () => {
	const vim: Item = { ...base, id: "c", kind: "command", status: "stashed", terminalId: "T5", command: "vim notes.md" };
	assert.equal(closedItems(open([vim]), empty, exists)[0].command, "vim notes.md");
});

test("the record keeps every terminal, and what the hooks last saw", () => {
	const tab = { windowId: "w", windowIndex: 0, id: "tab", name: "work", selected: true,
		terminals: [{ id: "X1", tty: "/dev/ttys901", cwd: "/work" }, { id: "X2", tty: "/dev/ttys902", cwd: "/work" }, { id: "X3", tty: "/dev/ttys903", cwd: "/work" }] };
	const procs = [
		{ pid: 1, ppid: 0, pgid: 1, tpgid: 1, tty: "ttys901", args: "codex" },
		{ pid: 2, ppid: 0, pgid: 2, tpgid: 2, tty: "ttys902", args: "claude" },
		{ pid: 3, ppid: 0, pgid: 3, tpgid: 3, tty: "ttys903", args: "npm run dev" },
	];
	const live = new Map([[1, { pid: 1, kind: "codex" as const, sessionId: "s", sessionFile: "/s", cwd: "/work", name: null, identity: "i", phase: "busy", lastUser: "go" }]]);
	const recorded = classifyTab(tab, procs, live, { record: true });
	assert.equal(recorded.skip, null);
	assert.deepEqual(recorded.tabItems.map((i) => [i.kind, i.command ?? i.sessionId, i.interrupted, i.lastUser]),
		[["codex", "s", true, "go"], ["command", "claude", undefined, undefined], ["command", "npm run dev", undefined, undefined]]);
	// A stash still leaves an agent it can't stop open, and records nothing about hooks.
	const stashed = classifyTab(tab, procs, live, { force: true });
	assert.equal(stashed.skip, "Claude Code needs oneterm hooks");
	assert.equal(stashed.tabItems[0].interrupted, undefined);
});

const line = (role: string, content: unknown, stopReason?: string) => JSON.stringify({ type: "message", message: { role, content, stopReason } });

test("pi's last exchange is read from the end of its session file", () => {
	const file = join(process.env.ONETERM_HOME!, "done.jsonl");
	writeFileSync(file, [
		JSON.stringify({ type: "session", id: "x" }),
		line("user", [{ type: "text", text: "fix   the\nbug" }]),
		line("assistant", [{ type: "text", text: "Looking." }, { type: "toolCall" }], "toolUse"),
		line("toolResult", [{ type: "text", text: "output" }]),
		line("assistant", [{ type: "thinking" }, { type: "text", text: "Fixed it." }], "stop"),
	].join("\n"));
	assert.deepEqual(piTail(file), { lastUser: "fix the bug", lastAssistant: "Fixed it.", interrupted: undefined });
});

test("a pi session cut off mid-turn is marked interrupted", () => {
	const file = join(process.env.ONETERM_HOME!, "busy.jsonl");
	writeFileSync(file, [line("user", "go"), line("assistant", [{ type: "toolCall" }], "toolUse"), line("toolResult", [{ type: "text", text: "ok" }])].join("\n"));
	assert.equal(piTail(file).interrupted, true);
	assert.deepEqual(piTail(join(process.env.ONETERM_HOME!, "nope.jsonl")), {});
});
