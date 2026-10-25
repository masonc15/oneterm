/**
 * Session titles and summaries from fr (fast-resume), which names a session better
 * than its tab does: a name you set wins, then a title Claude Haiku wrote from the
 * whole chat, along with one line on where the session stands. Looked up by session
 * ID with `fr --json --id`, and kept for a short while so the page's frequent
 * recounts don't run fr every time.
 */

import { spawnSync } from "node:child_process";
import type { Item } from "./store.ts";

export interface FrInfo {
	title: string;
	summary?: string;
}

type Session = Pick<Item, "kind" | "sessionId" | "remote">;

/** How long an answer, or the lack of one, is reused. */
const TTL_MS = 30_000;
/** A lookup that waits on another fr's refresh gives up and serves the index as is. */
const TIMEOUT_MS = 3_000;
const AGENTS = new Set(["pi", "claude", "codex"]);

const cache = new Map<string, { info: FrInfo | null; at: number }>();

/** The ID fr indexes the session under: mirrored stores prefix the host. */
function frId(s: Session) {
	return s.remote ? `${s.remote.host}:${s.sessionId}` : s.sessionId!;
}

function key(s: Session) {
	return `${s.kind}::${frId(s)}`;
}

function run(ids: string[], refresh: boolean): { id: string; agent: string; title: string; summary?: string | null }[] | null {
	const args = ["--json", ...(refresh ? [] : ["--no-refresh"]), ...ids.flatMap((id) => ["--id", id])];
	const res = spawnSync(process.env.ONETERM_FR || "fr", args, { encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 8 << 20 });
	if (res.status !== 0 || !res.stdout) return null;
	try {
		return JSON.parse(res.stdout).sessions;
	} catch {
		return null;
	}
}

/** Look up any of these sessions not looked up lately. Without fr, nothing is found. */
function fetchMissing(sessions: Session[]) {
	const now = Date.now();
	const stale = new Map<string, Session>();
	for (const s of sessions) {
		if (!s.sessionId || !AGENTS.has(s.kind)) continue;
		const hit = cache.get(key(s));
		if (!hit || now - hit.at > TTL_MS) stale.set(key(s), s);
	}
	if (!stale.size) return;
	const ids = [...new Set([...stale.values()].map(frId))];
	const found = run(ids, true) ?? run(ids, false);
	// When fr fails, keep what it said before and wait out the TTL before asking again.
	for (const k of stale.keys()) cache.set(k, { info: found ? null : cache.get(k)?.info ?? null, at: now });
	if (!found) return;
	for (const s of found) {
		const k = `${s.agent}::${s.id}`;
		if (stale.has(k) && s.title) cache.set(k, { info: { title: s.title, summary: s.summary || undefined }, at: now });
	}
}

/** fr's view of each session it knows, by the session's position in the list. */
export function frInfo(sessions: Session[]): (FrInfo | null)[] {
	fetchMissing(sessions);
	return sessions.map((s) => (s.sessionId && AGENTS.has(s.kind) ? cache.get(key(s))?.info ?? null : null));
}

/** These items with fr's title and summary where it has them. */
export function withFrInfo<T extends Session & { title: string; summary?: string }>(items: T[]): T[] {
	const info = frInfo(items);
	return items.map((item, i) => {
		const found = info[i];
		return found ? { ...item, title: found.title, ...(found.summary ? { summary: found.summary } : {}) } : item;
	});
}

/** Forget every answer; for tests. */
export function clearFrCache() {
	cache.clear();
}
