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

/** Checked through ps so asking never launches Ghostty. */
export function isRunning(): boolean {
	const out = execFileSync("ps", ["-axo", "comm="], { encoding: "utf8", maxBuffer: 32 << 20 });
	return out.split("\n").some((c) => c.endsWith("/Ghostty.app/Contents/MacOS/ghostty"));
}

export function listTabs(): Tab[] {
	if (!isRunning()) return [];
	return jxa<Tab[]>(`
function run() {
	const g = Application("Ghostty");
	const out = [];
	g.windows().forEach((w, wi) => {
		for (const t of w.tabs()) {
			out.push({
				windowId: w.id(), windowIndex: wi, id: t.id(), name: t.name(), selected: t.selected(),
				terminals: t.terminals().map((x) => ({ id: x.id(), tty: x.tty(), cwd: x.workingDirectory() })),
			});
		}
	});
	return JSON.stringify(out);
}`);
}

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
