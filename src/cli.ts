import { spawnSync } from "node:child_process";
import { groupItemIds, move, remove, restore } from "./restore.ts";
import { reap, type Scope, stash } from "./stash.ts";
import { displayCwd, findItem, type Item, load, restoreCommand } from "./store.ts";

const HELP = `oneterm: OneTab for Ghostty tabs and agents

  oneterm stash [--all|--others|--this] [--force] [--note TEXT] [--dry-run]
      Save tabs to the stash and close them. Busy agent sessions finish their
      current step first. Tabs running other programs stay open unless --force.
  oneterm restore            Pick stashed terminals with fzf (Tab to multi-select)
  oneterm restore ID...      Restore items by id; g-prefixed ids restore a whole group
  oneterm ls [--json]        List the stash
  oneterm rm ID...           Delete items (or groups) without restoring
  oneterm mv ID... GROUP     Move items into another group
  oneterm agent              Sync with the hub (launchd runs this)
  oneterm open               Open the hub page`;

function flag(args: string[], name: string) {
	const i = args.indexOf(name);
	if (i === -1) return undefined;
	args.splice(i, 1);
	return true;
}

function option(args: string[], name: string) {
	const i = args.indexOf(name);
	if (i === -1) return undefined;
	const [, value] = args.splice(i, 2);
	return value;
}

function expandIds(ids: string[]) {
	return ids.flatMap((id) => (id.startsWith("g") ? groupItemIds(id) : [id]));
}

const kindLabel: Record<Item["kind"], string> = { pi: "π", claude: "C", codex: "X", shell: "$", ssh: "⇄", command: "▸" };

function itemLine(item: Item, createdAt: string) {
	const when = new Date(createdAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
	const flags = item.status === "pending" ? " (stashing…)" : item.interrupted ? " (stopped mid-task)" : "";
	const cwd = displayCwd(item.cwd);
	return `${when.padEnd(16)} ${kindLabel[item.kind]} ${item.title}${flags}${item.title === cwd ? "" : `  ${cwd}`}`;
}

function printList(json: boolean) {
	const stash = load();
	if (json) return console.log(JSON.stringify(stash, null, 2));
	if (!stash.groups.length) return console.log("Nothing stashed.");
	for (const g of [...stash.groups].reverse()) {
		const when = new Date(g.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
		console.log(`${g.id}  ${when}${g.note ? ` — ${g.note}` : ""}`);
		for (const i of g.items) {
			const cwd = displayCwd(i.cwd);
			console.log(`  ${i.id}  ${kindLabel[i.kind]} ${i.title}${i.title === cwd ? "" : `  ${cwd}`}${i.status === "pending" ? " (stashing…)" : ""}`);
		}
	}
}

function preview(id: string) {
	const found = findItem(load(), id);
	if (!found) return;
	const { item } = found;
	const out = [item.title, displayCwd(item.cwd), ""];
	const cmd = restoreCommand(item);
	if (cmd) out.push(`$ ${cmd}`, "");
	if (item.interrupted) out.push("Stopped mid-task at a safe point; say \"continue\" after resuming.", "");
	if (item.lastUser) out.push(`You: ${item.lastUser}`, "");
	if (item.lastAssistant) out.push(`${item.kind}: ${item.lastAssistant}`);
	console.log(out.join("\n"));
}

function pick(): string[] {
	const stash = load();
	const lines = [...stash.groups]
		.reverse()
		.flatMap((g) => g.items.filter((i) => i.status === "stashed").map((i) => `${i.id}\t${itemLine(i, g.createdAt)}`));
	if (!lines.length) {
		console.log("Nothing stashed.");
		return [];
	}
	const self = `${process.execPath} ${new URL(import.meta.url).pathname}`;
	const res = spawnSync(
		"fzf",
		[
			"--multi",
			"--delimiter=\t",
			"--with-nth=2..",
			"--prompt=restore> ",
			"--header=Enter restores · Tab selects several · Ctrl-D deletes",
			`--preview=${self} _preview {1}`,
			"--preview-window=down,40%,wrap",
			`--bind=ctrl-d:execute-silent(${self} rm {+1})+reload(${self} _lines)`,
		],
		{ input: lines.join("\n"), stdio: ["pipe", "pipe", "inherit"], encoding: "utf8" },
	);
	return (res.stdout || "")
		.split("\n")
		.filter(Boolean)
		.map((l) => l.split("\t")[0]);
}

function lines() {
	for (const g of [...load().groups].reverse())
		for (const i of g.items) if (i.status === "stashed") console.log(`${i.id}\t${itemLine(i, g.createdAt)}`);
}

async function main() {
	const args = process.argv.slice(2);
	const cmd = args.shift();
	switch (cmd) {
		case "stash": {
			const scope: Scope = flag(args, "--others") ? "others" : flag(args, "--this") ? "this" : (flag(args, "--all"), "all");
			const fromPid = option(args, "--from-pid");
			const tabs = option(args, "--tabs");
			const timeout = option(args, "--timeout");
			const json = flag(args, "--json");
			const dryRun = flag(args, "--dry-run");
			const r = stash({
				dryRun,
				scope,
				force: flag(args, "--force"),
				note: option(args, "--note"),
				fromPid: fromPid ? Number(fromPid) : undefined,
				tabIds: tabs?.split(","),
				timeoutMs: timeout ? Number(timeout) * 1000 : undefined,
			});
			if (json) return console.log(JSON.stringify(r));
			const n = r.stashed.length + r.pending.length;
			const parts = [n ? `${dryRun ? "Would stash" : "Stashed"} ${n} terminal${n === 1 ? "" : "s"}` : "Nothing to stash"];
			if (r.pending.length) parts.push(`${r.pending.length} agents finishing current step`);
			const reasons = new Map<string, number>();
			for (const s of r.skipped) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
			for (const [reason, count] of reasons) parts.push(`kept ${count} open: ${reason}`);
			return console.log(parts.join(" · "));
		}
		case "_reap":
			return reap(args[0], Number(args[1]));
		case "restore": {
			const all = flag(args, "--all");
			const ids = all ? load().groups.flatMap((g) => g.items.map((i) => i.id)) : args.length ? expandIds(args) : pick();
			if (!ids.length) return;
			const r = restore(ids);
			if (r.restored.length) console.log(`Restored ${r.restored.join(", ")}`);
			if (r.missing.length) console.log(`Session file missing for ${r.missing.join(", ")}`);
			return;
		}
		case "mv": {
			const group = args.pop();
			if (!group || !args.length) throw new Error("usage: oneterm mv ID... GROUP");
			return console.log(`Moved ${move(expandIds(args), group)}`);
		}
		case "rm":
			return console.log(`Deleted ${remove(expandIds(args))}`);
		case "ls":
			return printList(Boolean(flag(args, "--json")));
		case "_preview":
			return preview(args[0]);
		case "_lines":
			return lines();
		case "agent": {
			const { agent } = await import("./agent.ts");
			return agent();
		}
		case "open": {
			const { hubConfig } = await import("./agent.ts");
			const config = hubConfig();
			if (!config) throw new Error("oneterm: no hub configured in ~/.oneterm/hub.json");
			spawnSync("open", [`${config.url}/`]);
			return;
		}
		default:
			console.log(HELP);
			if (cmd && cmd !== "help" && cmd !== "--help" && cmd !== "-h") process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exitCode = 1;
});
