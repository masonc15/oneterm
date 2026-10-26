import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { LIVE_DIR, readJson } from "./store.ts";
import { nativeAgents } from "./agents.ts";

export interface Proc {
	pid: number;
	ppid: number;
	pgid: number;
	tpgid: number;
	tty: string;
	args: string;
}

export interface LivePi {
	pid: number;
	sessionId: string;
	sessionFile: string | null;
	cwd: string;
	name: string | null;
	kind?: "pi" | "claude" | "codex";
	identity?: string;
	/** What the session is doing: "busy", "idle", and so on, from Claude Code's and Codex's hooks or pi's oneterm extension. */
	phase?: string;
	/** Claude Code and Codex only, from their hooks: the last exchange. */
	lastUser?: string;
	lastAssistant?: string;
}

export type Foreground =
	| { kind: "shell"; cwd?: string }
	| { kind: "pi"; pid: number; live: LivePi }
	| { kind: "claude"; pid: number; live: LivePi }
	| { kind: "codex"; pid: number; live: LivePi }
	| { kind: "pi-unregistered"; pid: number; command: string }
	| { kind: "agent-unregistered"; agent: "claude" | "codex"; command: string }
	| { kind: "ssh"; command: string; pid: number }
	| { kind: "command"; command: string; pid: number };

const SHELLS = new Set(["zsh", "bash", "fish", "sh", "dash", "nu", "login"]);

export function snapshot(): Proc[] {
	const out = execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,tpgid=,tty=,args="], { encoding: "utf8", maxBuffer: 32 << 20 });
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.*)$/);
			if (!m) return null;
			return { pid: +m[1], ppid: +m[2], pgid: +m[3], tpgid: +m[4], tty: m[5], args: m[6] };
		})
		.filter((p): p is Proc => p !== null);
}

export function livePis(): Map<number, LivePi> {
	const map = new Map<number, LivePi>();
	let files: string[] = [];
	try {
		files = readdirSync(LIVE_DIR);
	} catch {}
	for (const f of files) {
		if (!f.endsWith(".json")) continue;
		const live = readJson<LivePi>(join(LIVE_DIR, f));
		if (live && alive(live.pid)) map.set(live.pid, live);
	}
	for (const agent of nativeAgents()) map.set(agent.pid, agent);
	return map;
}

export function alive(pid: number) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function programName(args: string) {
	const first = args.split(/\s+/)[0] ?? "";
	return first.replace(/^-/, "").split("/").pop() ?? "";
}

/** What is in the foreground on a tty: an idle shell, a pi session, ssh, or some other program. */
export function foreground(tty: string, procs: Proc[], live: Map<number, LivePi>): Foreground {
	const name = tty.replace(/^\/dev\//, "");
	const onTty = procs.filter((p) => p.tty === name);
	const tpgid = onTty.find((p) => p.tpgid > 0)?.tpgid;
	const group = onTty.filter((p) => p.pgid === tpgid);
	// oneterm itself, run from a shell in this tab, counts as that shell.
	if (!group.length || group.some((p) => p.pid === process.pid)) return { kind: "shell" };

	const registered = group.find((p) => live.has(p.pid));
	if (registered) {
		const agent = live.get(registered.pid)!;
		return { kind: agent.kind ?? "pi", pid: registered.pid, live: agent };
	}

	const leader = group.find((p) => p.pid === tpgid) ?? group[0];
	const program = programName(leader.args);
	if (SHELLS.has(program)) return { kind: "shell" };
	if (program === "pi" || group.some((p) => programName(p.args) === "pi")) return { kind: "pi-unregistered", pid: leader.pid, command: leader.args };
	const native = group.map((p) => programName(p.args)).find((name) => name === "claude" || name === "claude.exe" || name === "codex");
	if (native) return { kind: "agent-unregistered", agent: native === "codex" ? "codex" : "claude", command: leader.args };
	if (program === "ssh" || program === "mosh") return { kind: "ssh", command: leader.args, pid: leader.pid };
	return { kind: "command", command: leader.args, pid: leader.pid };
}
