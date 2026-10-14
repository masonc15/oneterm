/**
 * The Mac side of the oneterm hub: push the stash whenever it changes and carry out
 * restores, deletes, and stashes clicked on the hub page. Runs under launchd.
 */

import { statSync } from "node:fs";
import { join } from "node:path";
import { remove, restore } from "./restore.ts";
import { startNudge } from "./nudge.ts";
import { countTabs, stash } from "./stash.ts";
import { HOME, load, readJson } from "./store.ts";

interface HubConfig {
	url: string;
	token: string;
}

interface Action {
	id: string;
	type: "restore" | "delete" | "stash" | "count";
	itemIds?: string[];
	scope?: "all" | "others";
}

const STASH_FILE = join(HOME, "stash.json");
const HEARTBEAT_MS = 5 * 60_000;

export function hubConfig(): HubConfig | null {
	const config = readJson<HubConfig>(join(HOME, "hub.json"));
	return config?.url && config.token ? { url: config.url.replace(/\/$/, ""), token: config.token } : null;
}

function log(message: string) {
	console.log(`${new Date().toISOString()} ${message}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function agent() {
	const config = hubConfig();
	if (!config) throw new Error(`oneterm agent: write {"url", "token"} to ${join(HOME, "hub.json")} first`);

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
		await call("/api/agent/state", { method: "POST", body: JSON.stringify({ groups: load().groups }) });
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
				return stash({ scope: action.scope === "others" ? "others" : "all" });
			case "count":
				return countTabs();
		}
	};

	startNudge(config.url, log);
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
				await call("/api/agent/done", { method: "POST", body: JSON.stringify({ actionId: action.id, result, groups: load().groups }) });
			}
		} catch (err) {
			failures++;
			if (failures === 1 || failures % 60 === 0) log(`hub unreachable: ${(err as Error).message}`);
			await sleep(Math.min(5_000 * failures, 30_000));
		}
	}
}
