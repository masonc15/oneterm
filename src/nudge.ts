/**
 * Tab-cap nudge: a notification when more than `tabCap` Ghostty tabs are open,
 * with buttons to stash the others or open the list. It fires when the count
 * goes over the cap, repeats every `nudgeRepeatMinutes` while it stays over, and
 * rearms once the count is back under.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stash } from "./stash.ts";
import { config, logHistory } from "./store.ts";

const NOTIFIER = ["/opt/homebrew/bin/terminal-notifier", "/usr/local/bin/terminal-notifier"].find((p) => existsSync(p)) ?? "";
// macOS shows a lone action as a button; two or more collapse into an "Options" menu.
const STASH_BUTTON = "Stash all tabs";

/** A plain notification; clicking it opens `url`. */
export function notify(subtitle: string, message: string, url: string | null) {
	if (!NOTIFIER) return;
	const args = ["-title", "oneterm", "-subtitle", subtitle, "-message", message];
	if (url) args.push("-open", url);
	spawn(NOTIFIER, args, { stdio: "ignore" }).unref();
}

/** Returns the check to run with the number of open tabs, whenever the agent counts them. */
export function startNudge(hubUrl: string | null, log: (m: string) => void): (open: number) => void {
	if (!NOTIFIER) {
		log("tab-cap nudge off: terminal-notifier not found");
		return () => {};
	}
	let lastNudge = 0;
	let showing: ChildProcess | null = null;

	const nudge = (open: number, cap: number) => {
		lastNudge = Date.now();
		const child = spawn(
			NOTIFIER,
			[
				"-title", "oneterm",
				"-subtitle", `${open} Ghostty tabs open`,
				"-message", `Your limit is ${cap}.`,
				"-group", "oneterm-tab-cap",
				"-action", STASH_BUTTON,
				"-timeout", "600",
			],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		showing = child;
		let out = "";
		child.stdout?.on("data", (d) => (out += d));
		child.on("exit", () => {
			showing = null;
			const choice = out.trim();
			if (choice === STASH_BUTTON) {
				const r = stash({ scope: "all" });
				log(`nudge: stashed ${r.tabs} tabs`);
			} else if (choice === "@ACTIONCLICKED") {
				// A click on the notification itself opens the list.
				if (hubUrl) spawn("open", [`${hubUrl}/`], { stdio: "ignore" });
			}
			logHistory("nudge", { open, cap, choice });
		});
	};

	return (open: number) => {
		const { tabCap, nudgeRepeatMinutes } = config();
		if (!tabCap) return;
		if (open <= tabCap) {
			lastNudge = 0;
			// Back under the cap: take down a nudge that is still on screen.
			if (showing) {
				showing.kill();
				spawn(NOTIFIER, ["-remove", "oneterm-tab-cap"], { stdio: "ignore" });
			}
			return;
		}
		if (showing) return;
		if (lastNudge && Date.now() - lastNudge < nudgeRepeatMinutes * 60_000) return;
		nudge(open, tabCap);
	};
}
