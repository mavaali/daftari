#!/usr/bin/env node
// Berlin Bureau — Case 1 "HOLLOW KING" seed.
//
// Builds a live, playable case vault: copies this case-vault's field reports
// into a target, reindexes so paths resolve for search/read, then logs the
// sacred AMBER genuine-vs-dangle tension so vault_tension_log shows it OPEN.
//
// Mirrors daftari's examples/berlin-bureau/seed.mjs. One thing to note:
//   HERE is this case vault; the copy never includes the solution key
//   (case-01-solution.key.yaml lives ONE level up, outside this dir) so the
//   player vault can never leak the answer.
// The daftari repo (for dist imports) is resolved relative to this file's
// location inside the repo; $DAFTARI_REPO overrides it.
//
// daftari's CLI exposes no write/tension-log subcommands (they are MCP/
// programmatic only), so — like the demo seed and integrations/recall-bench —
// this drives daftari via dist imports. addTension writes .daftari/tensions.md
// and applies no read-access gate, so a seed may call it directly.
//
// Order is load-bearing (write -> index -> log): the field reports are already
// present as committed content; the seed copies them into the target,
// reindexes so the paths resolve, THEN logs the tension.
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

// The two field reports that hold the sacred AMBER tension open.
const A = "field-reports/fr-014-nightingale-amber-genuine.md";
const B = "field-reports/fr-021-magpie-amber-dangle.md";

// Resolve the target vault: an explicit path, or a throwaway temp copy of this
// case vault (so a demo run never mutates the committed content).
let target;
if (process.argv[2]) {
  target = resolve(process.argv[2]);
  cpSync(HERE, target, { recursive: true });
} else {
  target = mkdtempSync(join(tmpdir(), "berlin-bureau-case01-"));
  cpSync(HERE, target, { recursive: true });
}
console.log(`[seed] daftari repo: ${REPO}`);
console.log(`[seed] target vault: ${target}`);

// RBAC config (load-bearing): daftari resolves an unknown --role to the implicit
// "guest" with NO permissions, so without this file EVERY document is denied and
// the player sees an empty vault. It declares the roles the case is played under:
//   player — reads the whole case to investigate; writes only to a scratch
//            _notes collection (never mutates the case content).
//   admin  — for the GM / this seed (read+write everything).
mkdirSync(join(target, ".daftari"), { recursive: true });
writeFileSync(
  join(target, ".daftari", "config.yaml"),
  `version: 1
vault_name: berlin-bureau-case-01
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

// log the sacred tension (must stay OPEN — naming the mole shifts it, never closes it)
const res = await addTension(target, {
  title: "AMBER: genuine vs dangle",
  sourceA: A,
  claimA: "AMBER is a genuine defector (NIGHTINGALE, B2)",
  sourceB: B,
  claimB: "AMBER is a dangle/plant (MAGPIE, C3)",
  kind: "factual",
  loggedBy: "agent:berlin-bureau-case01-seed",
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
console.log("[seed] OK — AMBER tension holds both reports open for analyst arbitration");
console.log(`[seed] play: point a daftari MCP at this vault, e.g.`);
console.log(`[seed]   npx daftari --vault ${target} --user player --role analyst`);
console.log(`[seed] inspect: cat ${join(target, ".daftari", "tensions.md")}`);
