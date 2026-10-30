import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
process.env.ONETERM_HOME = mkdtempSync(join(tmpdir(), "oneterm-unit-"));
const { foreground } = await import("../src/procs.ts");
const { restoreCommand, config } = await import("../src/store.ts");
const { parseSsh } = await import("../src/agents.ts");
import type { Item } from "../src/store.ts";

const item: Item = { id: "test", title: "test", kind: "claude", cwd: "/work/project with 'quotes'", status: "stashed", tabKey: "test", sessionId: "exact-id" };
test("exact resume commands", () => {
	assert.equal(restoreCommand(item), "claude --resume exact-id");
	assert.equal(restoreCommand({ ...item, kind: "codex" }), "codex --no-daemon resume exact-id");
	assert.equal(restoreCommand({ ...item, kind: "pi", sessionFile: "/work/session.jsonl" }), "pi --session /work/session.jsonl");
});
test("SSH is opt-in and does not guess a flattened command", () => {
	assert.equal(parseSsh("ssh devbox", "/tmp"), null);
	writeFileSync(join(process.env.ONETERM_HOME!, "config.json"), JSON.stringify({ remoteHosts: ["devbox"] }));
	assert.deepEqual(parseSsh("ssh -t -p 2222 devbox", "/tmp")?.argv, ["-t", "-p", "2222", "devbox"]);
	for (const s of ["ssh devbox pi", "ssh -o ControlMaster=auto devbox", "mosh devbox", "ssh other", "ssh -L 123:foo:456 devbox"])
		assert.equal(parseSsh(s, "/tmp"), null);
});
test("remote resume quotes both shell layers", () => {
	const command = restoreCommand({ ...item, remote: { host: "devbox", argv: ["-t", "devbox"], localCwd: "/tmp" } });
	assert.ok(command?.startsWith("ssh -t devbox 'bash -lc "));
	assert.ok(command?.includes("claude --resume exact-id"));
	assert.ok(command?.includes("cd -- "));
});
test("registered foreground keeps its agent kind", () => {
	const p = { pid: 123, ppid: 1, pgid: 123, tpgid: 123, tty: "ttys999", args: "codex" };
	const live = { pid: 123, kind: "codex" as const, sessionId: "exact", sessionFile: "/s", cwd: "/tmp", name: null, identity: "start" };
	assert.equal(foreground("/dev/ttys999", [p], new Map([[123, live]])).kind, "codex");
	assert.equal(foreground("/dev/ttys999", [p], new Map()).kind, "agent-unregistered");
	assert.equal(foreground("/dev/ttys999", [{ ...p, args: "ssh devbox" }], new Map()).kind, "ssh");
	assert.equal(config().remoteHosts[0], "devbox");
});
test("a headless agent run by another program is just that program", () => {
	const tool = { pid: 200, ppid: 1, pgid: 200, tpgid: 200, tty: "ttys999", args: "bun /bin/engineering-notebook summarize --all" };
	for (const args of ["claude --safe-mode -p --model x", "codex exec do it", "pi --print hi"]) {
		const child = { ...tool, pid: 201, ppid: 200, args };
		assert.equal(foreground("/dev/ttys999", [tool, child], new Map()).kind, "command");
	}
	const session = { ...tool, pid: 201, ppid: 200, args: "claude --resume x" };
	assert.equal(foreground("/dev/ttys999", [tool, session], new Map()).kind, "agent-unregistered");
});
