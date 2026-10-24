/**
 * The always-on Mac side of oneterm, run by launchd. It watches Ghostty, saving tabs
 * that close with it and nudging when too many are open. With a hub configured, it
 * also pushes the stash whenever it changes and carries out restores, deletes, moves,
 * renames, and stashes clicked on the hub page.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { checkTabs } from "./closed.ts";
import { move, remove, rename, restore } from "./restore.ts";
import { notify, startNudge } from "./nudge.ts";
import { countTabs, stash } from "./stash.ts";
import { displayCwd, HOME, load, readJson, restoreCommand } from "./store.ts";

interface HubConfig {
	url: string;
	token: string;
}

interface Action {
	id: string;
	type: "restore" | "delete" | "stash" | "count" | "move" | "rename";
	itemIds?: string[];
	scope?: "all" | "others";
	picked?: string[];
	groupId?: string;
	beforeId?: string;
	name?: string;
}

const STASH_FILE = join(HOME, "stash.json");
const HEARTBEAT_MS = 5 * 60_000;
/** How often to look at Ghostty's tabs. Tabs closed this close to Ghostty quitting get saved too. */
const WATCH_MS = 15_000;

export function hubConfig(): HubConfig | null {
	const config = readJson<HubConfig>(join(HOME, "hub.json"));
	return config?.url && config.token ? { url: config.url.replace(/\/$/, ""), token: config.token } : null;
}

function log(message: string) {
	console.log(`${new Date().toISOString()} ${message}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The stash as the page shows it: newest group first, with display paths and restore commands. */
function pageGroups() {
	return [...load().groups].reverse().map((g) => ({
		...g,
		items: g.items.map((i) => ({ ...i, cwdShort: displayCwd(i.cwd), restoreCommand: restoreCommand(i) ?? null })),
	}));
}

/** Look at Ghostty's tabs every WATCH_MS, starting now, so tabs lost to a reboot are saved at login. */
function watchGhostty(hubUrl: string | null) {
	const nudge = startNudge(hubUrl, log);
	const check = () => {
		try {
			const { open, saved } = checkTabs();
			if (saved) {
				const n = new Set(saved.items.map((i) => i.tabKey)).size;
				const titles = saved.items.map((i) => i.title).join(", ");
				log(`saved ${saved.items.length} terminal(s) Ghostty closed: ${titles}`);
				notify(`Saved ${n} tab${n === 1 ? "" : "s"} Ghostty closed`, titles, hubUrl && `${hubUrl}/`);
			}
			if (open !== null) nudge(open);
		} catch (err) {
			log(`watch failed: ${(err as Error).message}`);
		}
	};
	check();
	setInterval(check, WATCH_MS);
}

export async function agent() {
	const config = hubConfig();
	watchGhostty(config?.url ?? null);
	if (!config) {
		log(`no hub in ${join(HOME, "hub.json")}; watching Ghostty only`);
		return;
	}

	const call = async (path: string, init: RequestInit = {}, timeoutMs = 15_000) => {
		const res = await fetch(`${config.url}${path}`, {
			...init,
			headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json", ...init.headers },
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
		return res.json();
	};

	// Push the stash when stash.json changes, and now and then regardless.
	let pushedMtime = -1;
	let pushedAt = 0;
	const pushIfChanged = async () => {
		let mtime = 0;
		try {
			mtime = statSync(STASH_FILE).mtimeMs;
		} catch {}
		if (mtime === pushedMtime && Date.now() - pushedAt < HEARTBEAT_MS) return;
		await call("/api/agent/state", { method: "POST", body: JSON.stringify({ groups: pageGroups() }) });
		pushedMtime = mtime;
		pushedAt = Date.now();
	};
	(async () => {
		for (;;) {
			try {
				await pushIfChanged();
			} catch (err) {
				log(`push failed: ${(err as Error).message}`);
			}
			await sleep(1_000);
		}
	})();

	const run = (action: Action): unknown => {
		switch (action.type) {
			case "restore":
				return restore(action.itemIds ?? []);
			case "delete":
				return { deleted: remove(action.itemIds ?? []) };
			case "stash":
				if (action.picked) return action.picked.length ? stash({ scope: "all", picked: action.picked }) : { error: "no tabs chosen" };
				return stash({ scope: action.scope === "others" ? "others" : "all" });
			case "count":
				return countTabs();
			case "move":
				return { moved: move(action.itemIds ?? [], action.groupId ?? "", action.beforeId) };
			case "rename":
				return { renamed: rename(action.groupId ?? "", action.name ?? "") };
		}
	};

	log(`connected to ${config.url}`);
	let failures = 0;
	for (;;) {
		try {
			const { actions } = (await call("/api/agent/next?wait=25", {}, 40_000)) as { actions: Action[] };
			failures = 0;
			for (const action of actions) {
				let result: unknown;
				try {
					result = run(action);
				} catch (err) {
					result = { error: (err as Error).message };
				}
				if (action.type !== "count") log(`${action.type} ${action.itemIds?.length ?? action.scope ?? ""}: ${JSON.stringify(result)}`);
				await call("/api/agent/done", { method: "POST", body: JSON.stringify({ actionId: action.id, result, groups: pageGroups() }) });
			}
		} catch (err) {
			failures++;
			if (failures === 1 || failures % 60 === 0) log(`hub unreachable: ${(err as Error).message}`);
			await sleep(Math.min(5_000 * failures, 30_000));
		}
	}
}
