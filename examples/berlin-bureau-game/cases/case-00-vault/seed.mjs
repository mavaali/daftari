#!/usr/bin/env node
// Berlin Bureau — Case 0 "The Dead Drop" (tutorial) seed.
//
// Builds a live, playable tutorial vault: writes the RBAC config, copies the
// field reports into a target, reindexes so paths resolve, then logs the
// site-7-vs-site-4 contradiction as a tension. Unlike Case 1's AMBER tension,
// this one is meant to RESOLVE (toward site-7) once the player finds the
// independent A2 corroborator — that IS the lesson.
//
// Mirrors case-01-vault/seed.mjs. The daftari repo (for dist imports) is
// resolved relative to this file's location inside the repo; $DAFTARI_REPO overrides.
//
// Usage:
//   node seed.mjs                 # seeds a throwaway temp copy of this vault
//   node seed.mjs /path/to/vault  # seeds an existing/target vault root
//
// Requires daftari to be built first (npm run build in $DAFTARI_REPO).

import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)); // this case vault
// This seed lives inside the daftari repo (examples/berlin-bureau-game/cases/<case>-vault/),
// so it resolves the repo root four levels up for the dist imports. $DAFTARI_REPO overrides.
const REPO = process.env.DAFTARI_REPO ? resolve(process.env.DAFTARI_REPO) : resolve(HERE, "../../../..");

const { reindexVault } = await import(`${REPO}/dist/search/reindex.js`);
const { addTension } = await import(`${REPO}/dist/curation/tension.js`);

// The two field reports that hold the (resolvable) site contradiction.
const A = "field-reports/fr-t01-sparrow-site7.md";
const B = "field-reports/fr-t02-wren-site4.md";

let target;
if (process.argv[2]) {
  target = resolve(process.argv[2]);
  cpSync(HERE, target, { recursive: true });
} else {
  target = mkdtempSync(join(tmpdir(), "berlin-bureau-case00-"));
  cpSync(HERE, target, { recursive: true });
}
console.log(`[seed] daftari repo: ${REPO}`);
console.log(`[seed] target vault: ${target}`);

// RBAC config (load-bearing): an unknown --role resolves to a no-permission guest,
// so without this file the player sees an empty vault. See case-01-vault/seed.mjs.
mkdirSync(join(target, ".daftari"), { recursive: true });
writeFileSync(
  join(target, ".daftari", "config.yaml"),
  `version: 1
vault_name: berlin-bureau-case-00
roles:
  player:
    read: ["*"]
    write: [_notes]
  admin:
    read: ["*"]
    write: ["*"]
    promote: true
    ratify: true
`,
);
console.log("[seed] wrote RBAC config (roles: player, admin)");

// index
const rr = await reindexVault(target);
if (!rr.ok) {
  console.error("[seed] reindex failed:", rr.error);
  process.exit(1);
}
console.log("[seed] reindexed");

// log the (resolvable) tension
const res = await addTension(target, {
  title: "Tonight's drop: site-7 vs site-4",
  sourceA: A,
  claimA: "the drop is site-7 (SPARROW, B2)",
  sourceB: B,
  claimB: "the drop is site-4 (WREN, D4)",
  kind: "factual",
  loggedBy: "agent:berlin-bureau-case00-seed",
});
if (!res.ok) {
  console.error("[seed] addTension failed:", res.error);
  process.exit(1);
}
console.log(`[seed] logged tension ${res.value.id} (factual, unresolved)`);

// self-check
const log = readFileSync(join(target, ".daftari", "tensions.md"), "utf-8");
const ok = log.includes(A) && log.includes(B) && /factual/i.test(log);
if (!ok) {
  console.error("[seed] ASSERTION FAILED: tension log missing a source path or kind");
  process.exit(1);
}
console.log("[seed] OK — site contradiction held open for the analyst to corroborate and resolve");
console.log(`[seed] play: node ${REPO}/dist/cli.js --vault ${target} --user player --role player`);
