import { execFileSync } from "node:child_process";
import { config, type Item } from "./store.ts";
import type { LivePi } from "./procs.ts";

const SCRIPT = new URL("../support/agents.py", import.meta.url).pathname;
export interface Remote { host: string; argv: string[]; localCwd: string }
export interface AgentLive extends LivePi { kind: "pi" | "claude" | "codex"; identity: string }
export interface Poll { done?: boolean; failed?: boolean; pending?: boolean; ack?: AgentLive & { itemId: string; interrupted: boolean; lastUser?: string; lastAssistant?: string } }

/** Never send a request to a host implicitly: it must be opted into remoteHosts. */
export function rpc<T>(data: unknown, remote?: Remote): T {
	const command = remote ? "ssh" : "python3";
	const args = remote
		? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3", ...remote.argv.filter((x) => x !== "-t" && x !== "-tt"), "python3 ~/.oneterm/agents.py"]
		: [SCRIPT];
	return JSON.parse(execFileSync(command, args, { input: JSON.stringify(data), encoding: "utf8", timeout: 6_000, maxBuffer: 2 << 20 }));
}

export function nativeAgents(): AgentLive[] {
	try { return rpc<AgentLive[]>({ action: "list" }).filter((a) => a.kind !== "pi"); }
	catch { return []; }
}

export function parseSsh(command: string, localCwd: string): Remote | null {
	// ps gives a flattened argv. Restrict it to unambiguous, single-connection invocations.
	const words = command.trim().split(/\s+/);
	if (words.shift()?.split("/").pop() !== "ssh") return null;
	const argv: string[] = [];
	while (words[0]?.startsWith("-")) {
		const opt = words.shift()!;
		if (["-t", "-tt", "-4", "-6"].includes(opt)) argv.push(opt);
		else if (["-p", "-l", "-i"].includes(opt) && words[0] && /^[\w@%+=:,./-]+$/.test(words[0])) argv.push(opt, words.shift()!);
		else return null;
	}
	const host = words.shift();
	// Restores launch a known bash -lc body. Ignore that body: probe the actual remote
	// foreground process, not the command text, and save only connection options.
	const restored = words[0] === "bash" && words[1] === "-lc";
	if (!host || (words.length && !restored) || !/^[\w@.-]+$/.test(host) || !config().remoteHosts.includes(host)) return null;
	argv.push(host);
	return { host, argv, localCwd };
}

const cache = new Map<number, { at: number; result: RemoteProbe }>();
export type RemoteProbe = { remote: Remote; live?: AgentLive; cwd?: string; skip?: string };
export function remoteAgent(pid: number, command: string, cwd: string, fresh = false): RemoteProbe {
	const remote = parseSsh(command, cwd);
	if (!remote) return { remote: { host: "", argv: [], localCwd: cwd }, skip: "SSH needs a configured host and a simple ssh command" };
	const cached = cache.get(pid);
	if (!fresh && cached && Date.now() - cached.at < 2_000) return cached.result;
	let result: RemoteProbe;
	try {
		const sockets = execFileSync("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:ESTABLISHED", "-Fn"], { encoding: "utf8", timeout: 2_000 });
		const connections = sockets.split("\n").flatMap((s) => {
			const m = s.match(/^n(?:\[([^\]]+)\]|([^:]+)):(\d+)->/);
			return m ? [[m[1] ?? m[2], m[3]]] : [];
		});
		if (connections.length !== 1) throw new Error("ambiguous SSH connection");
		result = { remote, ...rpc<{ live?: AgentLive; cwd?: string; skip?: string }>({ action: "probe", connection: connections[0] }, remote) };
	} catch { result = { remote, skip: "SSH helper unavailable or connection ambiguous" }; }
	cache.set(pid, { at: Date.now(), result });
	return result;
}

export function requestAgent(item: Item, groupId: string, timeoutMs: number) {
	return rpc({ action: "request", item, groupId, timeoutMs }, item.remote);
}
export function pollAgent(item: Item): Poll {
	return rpc<Poll>({ action: "poll", item }, item.remote);
}
export function cancelAgent(item: Item) {
	return rpc({ action: "cancel", item }, item.remote);
}
export function agentFileExists(item: Item): boolean {
	if (!item.sessionFile) return false;
	try { return rpc<{ exists: boolean }>({ action: "exists", path: item.sessionFile }, item.remote).exists; }
	catch { return false; }
}
