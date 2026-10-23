/**
 * oneterm hub: the always-on copy of the stash page, run on a server on your private network.
 *
 * The Mac stays the source of truth. Its agent (`oneterm agent`) pushes the stash here
 * whenever it changes and long-polls for actions clicked on the page. An action only
 * names item ids, so nothing sent from the page can make the Mac run a command it did
 * not save itself. Clicks made while the Mac is away wait in the queue until it is back.
 *
 * Needs only Node's standard library so it runs straight from source in node:24-alpine.
 */

import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

const PORT = Number(process.env.ONETERM_PORT || 7317);
const DATA = process.env.ONETERM_DATA || "/data";
const TOKEN = process.env.ONETERM_TOKEN || "";
const HOSTS = new Set(
	(process.env.ONETERM_HOSTS || `localhost:${PORT},127.0.0.1:${PORT}`).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
);
const PAGE = process.env.ONETERM_PAGE || new URL("../web/index.html", import.meta.url).pathname;
const STATE_FILE = join(DATA, "hub.json");

/** The Mac counts as online if it checked in this recently (its long poll lasts 25 s). */
const ONLINE_MS = 45_000;
/** How long a click waits for the Mac before answering "queued". */
const CLICK_WAIT_MS = 8_000;
/** A sent action with no reply this long is sent again. */
const RESEND_MS = 60_000;
/** While the page is open, ask the Mac to recount its tabs this often. */
const COUNT_EVERY_MS = 2_000;
/** Tab counts older than this are not shown. */
const COUNT_FRESH_MS = 30_000;
/** Queued restores older than this are dropped instead of opening tabs out of nowhere. */
const RESTORE_TTL_MS = 24 * 3600_000;

type ActionType = "restore" | "delete" | "stash" | "count" | "move";

interface Action {
	id: string;
	type: ActionType;
	itemIds?: string[];
	scope?: "all" | "others";
	picked?: string[];
	groupId?: string;
	beforeId?: string;
	createdAt: number;
	sentAt?: number;
	doneAt?: number;
	result?: unknown;
}

interface Item {
	id: string;
	status: string;
	[key: string]: unknown;
}

interface Group {
	id: string;
	createdAt: string;
	items: Item[];
	[key: string]: unknown;
}

interface HubState {
	groups: Group[];
	syncedAt: number | null;
	agentSeenAt: number | null;
	actions: Action[];
	/** The Mac's last count of its open tabs (not persisted). */
	tabs?: { counts: unknown; at: number };
}

let state: HubState = { groups: [], syncedAt: null, agentSeenAt: null, actions: [] };
try {
	state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
} catch {}

function save() {
	mkdirSync(DATA, { recursive: true });
	const tmp = `${STATE_FILE}.tmp`;
	writeFileSync(tmp, JSON.stringify({ ...state, tabs: undefined }));
	renameSync(tmp, STATE_FILE);
}

function newId() {
	return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

let recount = false;

// Anyone waiting on the queue or on one action's result.
const queueWaiters = new Set<() => void>();
const doneWaiters = new Map<string, Set<() => void>>();

function wakeQueue() {
	for (const wake of queueWaiters) wake();
	queueWaiters.clear();
}

function prune() {
	const now = Date.now();
	state.actions = state.actions.filter((a) => {
		if (a.doneAt) return now - a.doneAt < 60_000;
		if (a.type === "restore") return now - a.createdAt < RESTORE_TTL_MS;
		// A stash or a count only makes sense right away; never replay it later.
		if (a.type === "stash" || a.type === "count") return now - a.createdAt < 30_000;
		return true;
	});
}

function pending() {
	return state.actions.filter((a) => !a.doneAt);
}

function macOnline() {
	return state.agentSeenAt !== null && Date.now() - state.agentSeenAt < ONLINE_MS;
}

function itemsOf(groupId: string) {
	return state.groups.find((g) => g.id === groupId)?.items.map((i) => i.id) ?? [];
}

/** The stash as the page should see it: the Mac's last copy with clicks it hasn't handled yet applied. */
function view() {
	const tabs = macOnline() && state.tabs && Date.now() - state.tabs.at < COUNT_FRESH_MS ? state.tabs.counts : null;
	const deleted = new Set(pending().flatMap((a) => (a.type === "delete" ? a.itemIds ?? [] : [])));
	const restoring = new Map<string, string>();
	for (const a of pending()) if (a.type === "restore") for (const id of a.itemIds ?? []) restoring.set(id, a.id);
	let groups = state.groups.map((g) => ({
		...g,
		items: g.items.filter((i) => !deleted.has(i.id)).map((i) => (restoring.has(i.id) ? { ...i, queuedAction: restoring.get(i.id) } : i)),
	}));
	// Show moves the Mac hasn't made yet, in the order they were dropped (same rules as restore.ts move()).
	for (const a of pending()) {
		if (a.type !== "move") continue;
		const target = groups.find((g) => g.id === a.groupId);
		if (!target) continue;
		const want = new Set(a.itemIds ?? []);
		const moving = groups.flatMap((g) => g.items.filter((i) => want.has(i.id) && i.status === "stashed"));
		groups = groups.map((g) => ({ ...g, items: g.items.filter((i) => !moving.includes(i)) }));
		const t = groups.find((g) => g.id === a.groupId)!;
		const at = a.beforeId ? t.items.findIndex((i) => i.id === a.beforeId) : -1;
		t.items.splice(at === -1 ? t.items.length : at, 0, ...moving);
	}
	groups = groups.filter((g) => g.items.length);
	return { groups, tabs, mac: { online: macOnline(), seenAt: state.agentSeenAt, syncedAt: state.syncedAt } };
}

function enqueue(action: Omit<Action, "id" | "createdAt">) {
	const full: Action = { ...action, id: newId(), createdAt: Date.now() };
	state.actions.push(full);
	save();
	wakeQueue();
	return full;
}

function waitDone(action: Action, ms: number): Promise<boolean> {
	if (action.doneAt) return Promise.resolve(true);
	return new Promise((resolve) => {
		const set = doneWaiters.get(action.id) ?? new Set();
		const finish = () => {
			clearTimeout(timer);
			set.delete(finish);
			resolve(Boolean(action.doneAt));
		};
		const timer = setTimeout(finish, ms);
		set.add(finish);
		doneWaiters.set(action.id, set);
	});
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json") {
	res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
	res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	let raw = "";
	for await (const chunk of req) {
		raw += chunk;
		if (raw.length > 8_000_000) throw new Error("body too large");
	}
	return raw ? JSON.parse(raw) : {};
}

function ids(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function agentAuthorized(req: IncomingMessage) {
	const given = Buffer.from(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
	const want = Buffer.from(TOKEN);
	return TOKEN.length > 0 && given.length === want.length && timingSafeEqual(given, want);
}

function setGroups(groups: unknown) {
	if (!Array.isArray(groups)) return;
	state.groups = groups as Group[];
	state.syncedAt = Date.now();
}

async function handleAgent(req: IncomingMessage, res: ServerResponse, url: URL) {
	if (!agentAuthorized(req)) return send(res, 401, { error: "unauthorized" });
	state.agentSeenAt = Date.now();

	if (req.method === "GET" && url.pathname === "/api/agent/next") {
		const take = () => {
			prune();
			const now = Date.now();
			const ready = pending().filter((a) => !a.sentAt || now - a.sentAt > RESEND_MS);
			for (const a of ready) a.sentAt = now;
			if (ready.length) save();
			return ready;
		};
		let ready = take();
		if (!ready.length) {
			const wait = Math.min(Number(url.searchParams.get("wait") || 25), 30) * 1000;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(done, wait);
				function done() {
					clearTimeout(timer);
					queueWaiters.delete(done);
					req.off("close", done);
					resolve();
				}
				queueWaiters.add(done);
				req.on("close", done);
			});
			state.agentSeenAt = Date.now();
			ready = take();
		}
		return send(res, 200, { actions: ready });
	}

	if (req.method !== "POST") return send(res, 404, { error: "not found" });
	const data = await readBody(req);
	if (url.pathname === "/api/agent/state") {
		setGroups(data.groups);
		save();
		return send(res, 200, { ok: true });
	}
	if (url.pathname === "/api/agent/done") {
		const action = state.actions.find((a) => a.id === data.actionId);
		if (action) {
			action.doneAt = Date.now();
			action.result = data.result;
			// A count that failed (say, a tab closed mid-query) keeps the last good one.
			if (action.type === "count") {
				const result = data.result as { error?: string } | undefined;
				if (result && !result.error) state.tabs = { counts: result, at: action.doneAt };
				else if (state.tabs) state.tabs.at = action.doneAt;
			}
			// Tabs just opened or closed; recount on the next look.
			else if (action.type === "stash" || action.type === "restore") recount = true;
		}
		setGroups(data.groups);
		save();
		if (action) for (const wake of doneWaiters.get(action.id) ?? []) wake();
		return send(res, 200, { ok: true });
	}
	return send(res, 404, { error: "not found" });
}

async function handlePage(req: IncomingMessage, res: ServerResponse, url: URL) {
	if (req.method === "GET" && url.pathname === "/") return send(res, 200, readFileSync(PAGE, "utf8"), "text/html; charset=utf-8");
	if (req.method === "GET" && url.pathname === "/api/state") {
		// Someone is looking: have the Mac recount its tabs for the stash buttons.
		const stale = recount || !state.tabs || Date.now() - state.tabs.at > COUNT_EVERY_MS;
		recount = false;
		if (macOnline() && stale && !pending().some((a) => a.type === "count")) enqueue({ type: "count" });
		return send(res, 200, view());
	}
	if (req.method !== "POST") return send(res, 404, { error: "not found" });

	// Any website can aim requests at this server; writes need a custom header a form can't send.
	const origin = req.headers.origin;
	if (req.headers["x-oneterm"] !== "1" || (origin && !HOSTS.has(origin.replace(/^https?:\/\//, "").toLowerCase())))
		return send(res, 403, { error: "forbidden" });

	const data = await readBody(req);
	const list = typeof data.groupId === "string" ? itemsOf(data.groupId) : ids(data.itemIds);
	switch (url.pathname) {
		case "/api/restore": {
			if (!list.length) return send(res, 200, { restored: [], missing: [] });
			const action = enqueue({ type: "restore", itemIds: list });
			if (macOnline() && (await waitDone(action, CLICK_WAIT_MS))) return send(res, 200, action.result);
			return send(res, 200, { queued: true, actionId: action.id, count: list.length });
		}
		case "/api/delete": {
			const action = enqueue({ type: "delete", itemIds: list });
			return send(res, 200, { deleted: list.length, queued: !macOnline(), actionId: action.id });
		}
		case "/api/move": {
			// Here groupId is the destination, so the items come only from itemIds.
			const moving = ids(data.itemIds);
			if (!moving.length || typeof data.groupId !== "string") return send(res, 400, { error: "itemIds and groupId are required" });
			const beforeId = typeof data.beforeId === "string" ? data.beforeId : undefined;
			const action = enqueue({ type: "move", itemIds: moving, groupId: data.groupId, beforeId });
			if (macOnline() && (await waitDone(action, CLICK_WAIT_MS))) return send(res, 200, action.result);
			return send(res, 200, { moved: moving.length, queued: true });
		}
		case "/api/cancel": {
			const before = state.actions.length;
			state.actions = state.actions.filter((a) => a.id !== data.actionId || a.doneAt || a.sentAt);
			save();
			return send(res, 200, { cancelled: before - state.actions.length });
		}
		case "/api/stash": {
			if (!macOnline()) return send(res, 409, { error: "the Mac is offline" });
			// From the tab picker: only these tabs. An empty pick must never fall through to every tab.
			const picked = data.picked === undefined ? undefined : ids(data.picked).slice(0, 500);
			if (picked && !picked.length) return send(res, 400, { error: "no tabs chosen" });
			const action = enqueue(picked ? { type: "stash", picked } : { type: "stash", scope: data.scope === "others" ? "others" : "all" });
			if (await waitDone(action, 20_000)) return send(res, 200, action.result);
			return send(res, 504, { error: "the Mac did not answer" });
		}
		default:
			return send(res, 404, { error: "not found" });
	}
}

const server = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://hub");
	if (url.pathname === "/healthz") return send(res, 200, { ok: true });
	// Reject other Host headers so a DNS-rebinding page can't pose as this one.
	if (!HOSTS.has(String(req.headers.host ?? "").toLowerCase())) return send(res, 403, { error: "bad host" });
	try {
		if (url.pathname.startsWith("/api/agent/")) return await handleAgent(req, res, url);
		return await handlePage(req, res, url);
	} catch (err) {
		if (!res.headersSent) send(res, 500, { error: err instanceof Error ? err.message : String(err) });
	}
});

if (!TOKEN) console.warn("oneterm hub: ONETERM_TOKEN is not set; the Mac agent can't connect");
server.listen(PORT, "0.0.0.0", () => console.log(`oneterm hub on :${PORT} (hosts: ${[...HOSTS].join(", ")})`));
