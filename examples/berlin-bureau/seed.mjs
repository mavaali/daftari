#!/usr/bin/env node
// Berlin Bureau demo seed — loads the showcase AMBER tension into a daftari vault.
//
// Pinned invocation surface (discovered 2026-07-31): daftari's CLI (dist/cli.js)
// exposes no `write`/`tension-log` subcommands — those are MCP/programmatic only.
// So this seed drives daftari via dist imports, the same pattern
// integrations/recall-bench uses. `addTension` writes .daftari/tensions.md and
// (unlike the vault_tension_log MCP tool) applies no read-access gate, so a seed
// can call it directly.
//
// Order is load-bearing (write -> index -> log): the field-report markdown is
// already present in this example vault (committed content); the seed copies it
// into the target, reindexes so the paths resolve, THEN logs the tension.
//
// Usage:
//   node seed.mjs                 # seeds a throwaway temp copy of this vault
//   node seed.mjs /path/to/vault  # seeds an existing vault (must contain the two field reports)
//
// Requires daftari to be built first (npm run build) so dist/ exists.

import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");

const { reindexVault } = await import(`${REPO}/dist/search/reindex.js`);
const { addTension } = await import(`${REPO}/dist/curation/tension.js`);

const A = "field-reports/fr-014-nightingale-amber-genuine.md";
const B = "field-reports/fr-021-magpie-amber-dangle.md";

// Resolve the target vault: an explicit path, or a throwaway temp copy of this
// example vault (so a demo run never mutates the committed content).
let target;
if (process.argv[2]) {
  target = resolve(process.argv[2]);
} else {
  target = mkdtempSync(join(tmpdir(), "berlin-bureau-"));
  cpSync(HERE, target, { recursive: true });
}
console.log(`[seed] target vault: ${target}`);

// (write already satisfied: the two field reports are present in the vault)
// index
const rr = await reindexVault(target);
if (!rr.ok) {
  console.error("[seed] reindex failed:", rr.error);
  process.exit(1);
}
console.log("[seed] reindexed");

// log the showcase tension
const res = await addTension(target, {
  title: "AMBER: genuine vs dangle",
  sourceA: A,
  claimA: "AMBER is a genuine defector (NIGHTINGALE, B2)",
  sourceB: B,
  claimB: "AMBER is a dangle/plant (MAGPIE, C3)",
  kind: "factual",
  loggedBy: "agent:berlin-bureau-seed",
});
if (!res.ok) {
  console.error("[seed] addTension failed:", res.error);
  process.exit(1);
}
console.log(`[seed] logged tension ${res.value.id} (factual, unresolved)`);

// self-check: the tension log names both sides and is factual/unresolved
const log = readFileSync(join(target, ".daftari", "tensions.md"), "utf-8");
const ok = log.includes(A) && log.includes(B) && /factual/i.test(log);
if (!ok) {
  console.error("[seed] ASSERTION FAILED: tension log missing a source path or kind");
  process.exit(1);
}
console.log("[seed] OK — tension holds both AMBER reports open for analyst arbitration");
console.log(`[seed] inspect: cat ${join(target, ".daftari", "tensions.md")}`);
