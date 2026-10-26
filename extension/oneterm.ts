/**
 * oneterm: lets the `oneterm` CLI stash this pi session and close its Ghostty tab.
 *
 * While pi runs, this extension keeps ~/.oneterm/live/<pid>.json up to date so the
 * CLI can map a terminal's foreground process to a session file, and show whether
 * the session is working. When the CLI drops
 * ~/.oneterm/requests/<pid>.json, the session winds down at the next safe point:
 *
 *   idle                 stash right away
 *   waiting on a prompt  cancel the prompt, then stash
 *   working              let the running tool call finish, block tool calls that
 *                        have not started, stop before the next model request
 *
 * then writes ~/.oneterm/acks/<pid>.json with a short snapshot and exits pi. A hard
 * timeout aborts whatever is still running so a stuck tool can't keep the tab open.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawn } from "node:child_process";
import { type FSWatcher, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.ONETERM_HOME || join(homedir(), ".oneterm");
const LIVE_DIR = join(HOME, "live");
const REQUEST_DIR = join(HOME, "requests");
const ACK_DIR = join(HOME, "acks");
const DEFAULT_TIMEOUT_MS = 120_000;
const SNIPPET_CHARS = 280;
const CLI = join(homedir(), "workspace", "oneterm", "bin", "oneterm");
const PROC_STAT = process.platform === "linux" ? readFileSync(`/proc/${process.pid}/stat`, "utf8") : null;
const PROCESS_IDENTITY = PROC_STAT
	? PROC_STAT.slice(PROC_STAT.lastIndexOf(")") + 1).trim().split(/\s+/)[19]
	: execFileSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" }).trim();

interface StashRequest {
	groupId: string;
	itemId: string;
	timeoutMs?: number;
	sessionId?: string;
	identity?: string;
	expiresAt?: number;
}

function writeAtomic(path: string, data: unknown) {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2));
	renameSync(tmp, path);
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b && typeof b === "object" && (b as { type?: string }).type === "text")
		.map((b) => (b as { text: string }).text)
		.join("\n");
}

function clip(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat;
}

/** The last thing the user asked and the last thing the assistant said, for the stash list. */
function snapshot(ctx: ExtensionContext) {
	let lastUser = "";
	let lastAssistant = "";
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = (entry as { message: { role: string; content: unknown } }).message;
		const text = textOf(message.content).trim();
		if (!text) continue;
		if (message.role === "user") lastUser = text;
		else if (message.role === "assistant") lastAssistant = text;
	}
	return { lastUser: clip(lastUser), lastAssistant: clip(lastAssistant) };
}

export default function oneterm(pi: ExtensionAPI) {
	const livePath = join(LIVE_DIR, `${process.pid}.json`);
	const requestName = `${process.pid}.json`;
	let watcher: FSWatcher | null = null;
	let promptOpen = false;
	/** A run is going: from agent_start until agent_settled. */
	let running = false;
	let stash: { request: StashRequest; at: number; midTask: boolean; timer: NodeJS.Timeout } | null = null;
	let finalized = false;

	const register = (ctx: ExtensionContext) => {
		mkdirSync(LIVE_DIR, { recursive: true });
		writeAtomic(livePath, {
			pid: process.pid,
			identity: PROCESS_IDENTITY,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			cwd: ctx.sessionManager.getCwd(),
			name: pi.getSessionName() ?? null,
			// The same words Claude Code's and Codex's hooks use, plus "prompt" for a question waiting on you.
			phase: !running ? "idle" : promptOpen ? "prompt" : "busy",
			updatedAt: new Date().toISOString(),
		});
	};

	const finalize = (ctx: ExtensionContext) => {
		if (finalized || !stash) return;
		finalized = true;
		clearTimeout(stash.timer);
		mkdirSync(ACK_DIR, { recursive: true });
		writeAtomic(join(ACK_DIR, `${process.pid}.json`), {
			pid: process.pid,
			groupId: stash.request.groupId,
			itemId: stash.request.itemId,
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			cwd: ctx.sessionManager.getCwd(),
			name: pi.getSessionName() ?? null,
			interrupted: stash.midTask,
			...snapshot(ctx),
			at: new Date().toISOString(),
		});
		if (ctx.hasUI) ctx.ui.setStatus("oneterm", undefined);
		ctx.shutdown();
	};

	const checkRequest = (ctx: ExtensionContext) => {
		if (stash || finalized) return;
		const path = join(REQUEST_DIR, requestName);
		let request: StashRequest;
		try {
			request = JSON.parse(readFileSync(path, "utf8"));
			rmSync(path, { force: true });
		} catch {
			return;
		}
		if ((request.sessionId && request.sessionId !== ctx.sessionManager.getSessionId()) ||
			(request.identity && request.identity !== PROCESS_IDENTITY) ||
			(request.expiresAt && request.expiresAt < Date.now() / 1000)) return;
		const idle = ctx.isIdle() && !promptOpen;
		const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const timer = setTimeout(() => {
			// The step outlived the grace period: stop it and stash anyway.
			ctx.abort();
			setTimeout(() => finalize(ctx), 3_000);
		}, timeoutMs);
		stash = { request, at: Date.now(), midTask: !idle, timer };
		if (idle) return finalize(ctx);
		if (ctx.hasUI) ctx.ui.setStatus("oneterm", "⏸ oneterm: stashing after this step");
		if (promptOpen) {
			// Nobody is there to answer; cancel the question and stash.
			ctx.abort();
			setTimeout(() => finalize(ctx), 3_000);
		}
	};

	pi.on("session_start", (_event, ctx) => {
		register(ctx);
		mkdirSync(REQUEST_DIR, { recursive: true });
		watcher?.close();
		watcher = watch(REQUEST_DIR, (_type, file) => {
			if (file === requestName) checkRequest(ctx);
		});
		checkRequest(ctx);
	});

	pi.on("session_info_changed", (_event, ctx) => register(ctx));
	pi.on("agent_start", (_event, ctx) => {
		running = true;
		register(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		running = false;
		register(ctx);
		if (stash) finalize(ctx);
	});

	pi.on("ui_prompt_start", (_event, ctx) => {
		promptOpen = true;
		register(ctx);
	});
	pi.on("ui_prompt_end", (_event, ctx) => {
		promptOpen = false;
		register(ctx);
	});

	// Tool calls that had not started when the stash arrived are skipped, and the run ends after this batch.
	pi.on("tool_call", () => {
		if (!stash) return;
		return {
			block: true,
			reason: "Not run: the user stashed this session with oneterm. Re-run this call if it is still needed after resuming.",
			terminate: true,
		};
	});

	// A turn's tool calls have all finished; stop before the next model request.
	pi.on("turn_end", (_event, ctx) => {
		if (stash) ctx.abort();
	});

	pi.on("session_shutdown", () => {
		watcher?.close();
		watcher = null;
	});

	process.once("exit", () => {
		rmSync(livePath, { force: true });
	});

	pi.registerCommand("oneterm", {
		description: "Stash Ghostty tabs with oneterm: all (default), others (keep this tab), or this",
		handler: async (args, ctx) => {
			const mode = args.trim() || "all";
			if (!["all", "others", "this"].includes(mode)) {
				ctx.ui.notify("Usage: /oneterm [all|others|this]", "warning");
				return;
			}
			const child = spawn(CLI, ["stash", `--${mode}`, "--from-pid", String(process.pid)], {
				detached: true,
				stdio: "ignore",
			});
			child.unref();
			ctx.ui.notify(`oneterm: stashing ${mode === "all" ? "all tabs" : mode === "others" ? "the other tabs" : "this tab"}`, "info");
		},
	});
}
