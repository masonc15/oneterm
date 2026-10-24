import { execFileSync } from "node:child_process";

export interface Terminal {
	id: string;
	tty: string;
	cwd: string;
}

export interface Tab {
	windowId: string;
	windowIndex: number;
	id: string;
	name: string;
	selected: boolean;
	terminals: Terminal[];
}

export interface OpenSpec {
	cwd: string;
	input?: string;
}

function jxa<T>(source: string, arg: unknown = null): T {
	const out = execFileSync("osascript", ["-l", "JavaScript", "-e", source, JSON.stringify(arg)], {
		encoding: "utf8",
		timeout: 20_000,
	});
	return JSON.parse(out) as T;
}

/**
 * The running Ghostty as "pid start-time", or null. Each launch gets a new one, so it
 * tells a relaunch apart from the same Ghostty. Checked through ps so asking never launches Ghostty.
 */
export function instance(): string | null {
	const out = execFileSync("ps", ["-axo", "pid=,comm="], { encoding: "utf8", maxBuffer: 32 << 20 });
	const pid = out.split("\n").find((l) => l.endsWith("/Ghostty.app/Contents/MacOS/ghostty"))?.trim().split(/\s+/)[0];
	if (!pid) return null;
	try {
		const start = execFileSync("ps", ["-p", pid, "-o", "lstart="], { encoding: "utf8" }).trim();
		return start ? `${pid} ${start}` : null;
	} catch {
		return null; // It exited between the two looks.
	}
}

export function isRunning(): boolean {
	return instance() !== null;
}

export function listTabs(): Tab[] {
	if (!isRunning()) return [];
	// One bulk Apple Event per property instead of one per terminal: about 0.3 s instead of 1.5 s.
	return jxa<Tab[]>(LIST_TABS_SCRIPT);
}

// Separate for a VM regression test: Apple Events can see a tab close between property reads.
export const LIST_TABS_SCRIPT = `
function run() {
	const W = Application("Ghostty").windows;
	for (let attempt = 0; attempt < 3; attempt++) {
		const wid = W.id(), tid = W.tabs.id(), xid = W.tabs.terminals.id();
		const name = W.tabs.name(), sel = W.tabs.selected();
		const tty = W.tabs.terminals.tty(), cwd = W.tabs.terminals.workingDirectory();
		if (JSON.stringify([wid, tid, xid]) !== JSON.stringify([W.id(), W.tabs.id(), W.tabs.terminals.id()])) continue;
		const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length;
		if (!same(wid, tid) || !same(tid, xid) || !same(tid, name) || !same(tid, sel) || !same(tid, tty) || !same(tid, cwd)) continue;
		const complete = tid.every((ts, wi) => same(ts, xid[wi]) && same(ts, name[wi]) && same(ts, sel[wi]) && same(ts, tty[wi]) && same(ts, cwd[wi]) &&
			ts.every((_, ti) => same(xid[wi][ti], tty[wi][ti]) && same(xid[wi][ti], cwd[wi][ti])));
		if (!complete) continue;
		const out = [];
		wid.forEach((w, wi) => tid[wi].forEach((t, ti) => out.push({
			windowId: w, windowIndex: wi, id: t, name: name[wi][ti], selected: sel[wi][ti],
			terminals: xid[wi][ti].map((x, k) => ({ id: x, tty: tty[wi][ti][k], cwd: cwd[wi][ti][k] })),
		})));
		return JSON.stringify(out);
	}
	throw new Error("Ghostty tabs changed during inspection; retry the stash");
}`;

/** Close terminals by id. A tab closes with its last terminal. Returns ids that no longer exist. */
export function closeTerminals(ids: string[]): string[] {
	if (!ids.length || !isRunning()) return [];
	return jxa<string[]>(
		`
function run(argv) {
	const want = new Set(JSON.parse(argv[0]));
	const g = Application("Ghostty");
	const missing = new Set(want);
	for (const w of g.windows()) for (const t of w.tabs()) for (const x of t.terminals()) {
		const id = x.id();
		if (want.has(id)) { g.close(x); missing.delete(id); }
	}
	return JSON.stringify([...missing]);
}`,
		ids,
	);
}

/**
 * Open each group of specs as one new tab: the first spec fills the tab and the rest
 * become splits beside it. Opens a window when Ghostty has none.
 */
export function openTabs(tabs: OpenSpec[][]): void {
	if (!tabs.length) return;
	jxa<boolean>(
		`
function run(argv) {
	const tabs = JSON.parse(argv[0]);
	const g = Application("Ghostty");
	g.activate();
	const cfg = (s) => {
		const c = { initialWorkingDirectory: s.cwd };
		if (s.input) c.initialInput = s.input;
		return c;
	};
	for (const specs of tabs) {
		let first;
		if (g.windows.length === 0) {
			const w = g.newWindow({ withConfiguration: cfg(specs[0]) });
			first = w.tabs[0].terminals[0];
		} else {
			const t = g.newTab({ in: g.windows[0], withConfiguration: cfg(specs[0]) });
			first = t.terminals[0];
		}
		for (const s of specs.slice(1)) g.split(first, { direction: "right", withConfiguration: cfg(s) });
	}
	return "true";
}`,
		tabs,
	);
}
