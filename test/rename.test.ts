import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
process.env.ONETERM_HOME = mkdtempSync(join(tmpdir(), "oneterm-rename-"));
const { rename } = await import("../src/restore.ts");
const { load, update } = await import("../src/store.ts");

update((s) => {
	s.groups.push({ id: "g1", createdAt: "2026-10-24T12:00:00.000Z", items: [{ id: "i1", kind: "shell", title: "t", cwd: "/", status: "stashed", tabKey: "k" }] });
});

test("a name is tidied and saved", () => {
	assert.equal(rename("g1", "  Kobo   stuff \n"), true);
	assert.equal(load().groups[0].name, "Kobo stuff");
});

test("long names are cut", () => {
	rename("g1", "x".repeat(200));
	assert.equal(load().groups[0].name?.length, 80);
});

test("an empty name clears it", () => {
	rename("g1", "   ");
	assert.equal("name" in load().groups[0], false);
});

test("an unknown group is reported", () => {
	assert.equal(rename("nope", "x"), false);
});
