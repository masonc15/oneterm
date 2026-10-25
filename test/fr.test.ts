import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A stand-in fr that logs its arguments and answers from a fixed list.
const dir = mkdtempSync(join(tmpdir(), "oneterm-fr-"));
const log = join(dir, "calls.log");
const fake = join(dir, "fr");
writeFileSync(fake, `#!/bin/sh
echo "$*" >> ${JSON.stringify(log)}
[ -f ${JSON.stringify(join(dir, "fail"))} ] && exit 1
cat <<'EOF'
{"schema_version":1,"sessions":[
 {"id":"s1","agent":"pi","title":"Witness Steam Deck deploy","summary":"Build works; Deck check left."},
 {"id":"s2","agent":"codex","title":"Same id, other agent","summary":null},
 {"id":"nuada:s3","agent":"claude","title":"Remote session"}],"meta":{}}
EOF
`);
chmodSync(fake, 0o755);
process.env.ONETERM_FR = fake;
const { clearFrCache, withFrInfo } = await import("../src/fr.ts");

const calls = () => readFileSync(log, "utf8").trim().split("\n");
const items = [
	{ kind: "pi" as const, title: "Witns Deck", sessionId: "s1" },
	{ kind: "pi" as const, title: "Kept label", sessionId: "s2" },
	{ kind: "claude" as const, title: "remote", sessionId: "s3", remote: { host: "nuada", argv: [], localCwd: "/" } },
	{ kind: "shell" as const, title: "~" },
];

test("titles and summaries come from fr, matched by agent and host", () => {
	clearFrCache();
	writeFileSync(log, "");
	const found = withFrInfo(items);
	assert.deepEqual(found.map((i) => i.title), ["Witness Steam Deck deploy", "Kept label", "Remote session", "~"]);
	assert.deepEqual(found.map((i) => i.summary), ["Build works; Deck check left.", undefined, undefined, undefined]);
	assert.equal("summary" in found[2], false);
	assert.deepEqual(calls(), ["--json --id s1 --id s2 --id nuada:s3"]);
});

test("answers are reused instead of running fr again", () => {
	writeFileSync(log, "");
	withFrInfo(items);
	assert.equal(readFileSync(log, "utf8"), "");
});

test("when fr fails, the tab titles stay", () => {
	clearFrCache();
	writeFileSync(join(dir, "fail"), "");
	writeFileSync(log, "");
	assert.deepEqual(withFrInfo(items.slice(0, 1)).map((i) => i.title), ["Witns Deck"]);
	// It tried with a refresh, then without one.
	assert.deepEqual(calls(), ["--json --id s1", "--json --no-refresh --id s1"]);
});
