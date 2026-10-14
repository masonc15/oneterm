import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { LIST_TABS_SCRIPT } from "../src/ghostty.ts";

function app(unstable: boolean) {
	let reads = 0;
	const terminals = { id: () => [[['terminal']]], tty: () => [[['/dev/ttys999']]], workingDirectory: () => [[['/tmp']]] };
	const tabs = {
		id: () => { reads++; return unstable && reads === 1 ? [['closed', 'tab']] : [['tab']]; },
		name: () => [['Test']], selected: () => [[true]], terminals,
	};
	return { windows: { id: () => ['window'], tabs } };
}
test("tab closing between bulk reads retries a coherent snapshot", () => {
	const value = JSON.parse(runInNewContext(LIST_TABS_SCRIPT + '\nrun();', { Application: () => appInstance }));
	assert.equal(value.length, 1);
	assert.equal(value[0].id, 'tab');
	assert.equal(value[0].terminals[0].id, 'terminal');
});
const appInstance = app(true);
test("incomplete bulk properties cannot misidentify a terminal", () => {
	const broken = app(false);
	broken.windows.tabs.terminals.id = () => [];
	assert.throws(() => runInNewContext(LIST_TABS_SCRIPT + '\nrun();', { Application: () => broken }), /tabs changed during inspection/);
});
