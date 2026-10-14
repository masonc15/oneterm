import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { type OpenSpec, openTabs } from "./ghostty.ts";
import { type Item, load, logHistory, restoreCommand, update } from "./store.ts";

export interface RestoreResult {
	restored: string[];
	missing: string[];
}

function spec(item: Item): OpenSpec {
	const cwd = existsSync(item.cwd) ? item.cwd : homedir();
	const cmd = restoreCommand(item);
	if (!cmd) return { cwd };
	// Programs other than pi and ssh are typed but not run; press Enter if you still want them.
	return { cwd, input: item.kind === "command" ? cmd : `${cmd}\n` };
}

/** Reopen items in Ghostty and remove them from the stash. Terminals that shared a tab share one again. */
export function restore(itemIds: string[]): RestoreResult {
	const want = new Set(itemIds);
	const picked: Item[] = [];
	for (const group of load().groups) for (const item of group.items) if (want.has(item.id) && item.status === "stashed") picked.push(item);
	const result: RestoreResult = { restored: [], missing: [] };
	if (!picked.length) return result;

	const byTab = new Map<string, Item[]>();
	for (const item of picked) {
		if (item.kind === "pi" && (!item.sessionFile || !existsSync(item.sessionFile))) {
			result.missing.push(item.title);
			continue;
		}
		byTab.set(item.tabKey, [...(byTab.get(item.tabKey) ?? []), item]);
	}
	const tabs = [...byTab.values()];
	openTabs(tabs.map((items) => items.map(spec)));

	const done = new Set(tabs.flat().map((i) => i.id));
	update((s) => {
		for (const g of s.groups) g.items = g.items.filter((i) => !done.has(i.id));
	});
	logHistory("restore", tabs.flat());
	result.restored = tabs.flat().map((i) => i.title);
	return result;
}

export function remove(itemIds: string[]): number {
	const want = new Set(itemIds);
	return update((s) => {
		let n = 0;
		for (const g of s.groups) {
			const removed = g.items.filter((i) => want.has(i.id) && i.status === "stashed");
			if (!removed.length) continue;
			logHistory("delete", removed);
			n += removed.length;
			g.items = g.items.filter((i) => !removed.includes(i));
		}
		return n;
	});
}

/**
 * Move items into another group, before `beforeId` or at the end. Moving within a
 * group reorders it. Groups left empty disappear. Returns how many items moved.
 */
export function move(itemIds: string[], groupId: string, beforeId?: string): number {
	const want = new Set(itemIds);
	return update((s) => {
		const target = s.groups.find((g) => g.id === groupId);
		if (!target) return 0;
		const moving: Item[] = [];
		for (const g of s.groups) {
			for (const item of g.items) if (want.has(item.id) && item.status === "stashed") moving.push(item);
			g.items = g.items.filter((i) => !moving.includes(i));
		}
		if (!moving.length) return 0;
		const at = beforeId ? target.items.findIndex((i) => i.id === beforeId) : -1;
		target.items.splice(at === -1 ? target.items.length : at, 0, ...moving);
		logHistory("move", { groupId, beforeId, items: moving.map((i) => i.id) });
		return moving.length;
	});
}

export function groupItemIds(groupId: string): string[] {
	return load().groups.find((g) => g.id === groupId)?.items.map((i) => i.id) ?? [];
}
