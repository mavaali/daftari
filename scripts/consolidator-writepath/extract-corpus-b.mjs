// extract-corpus-b.mjs — pull the paper's corpus-B 39 items (33 supersession traps +
// 6 genuine tensions) out of the committed consensus-bench fixtures into one flat JSON
// for the Mem0 write-path harness (M3). Read-only: does not touch integrations/.
//
// Traps: integrations/consensus-bench/src/__fixtures__/trump-instance-diffs.json,
//   parsed via the SAME truePairs() used by CB4/CO2 (integrations/consensus-bench/dist/
//   consensus-cb4-pairs.js) so the 33 scorable pairs match what the paper reports.
// Tensions: integrations/consensus-bench/src/consensus-cb6-tension.ts (tensionPairs),
//   read directly since it's a plain data array (no dist build needed for it — but we
//   use the committed dist/ build to stay consistent with how the paper's other arms
//   consumed this fixture; tensionPairs isn't compiled standalone so we re-declare it
//   here verbatim from the .ts source, byte-for-byte, rather than re-deriving it).
//
// Usage: node scripts/consolidator-writepath/extract-corpus-b.mjs
// Output: scripts/consolidator-writepath/corpus-b-39.json

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const { loadDiffsFromFile } = await import(
  path.join(REPO_ROOT, "integrations/consensus-bench/dist/consensus-content.js")
);
const { truePairs } = await import(
  path.join(REPO_ROOT, "integrations/consensus-bench/dist/consensus-cb4-pairs.js")
);

const diffsPath = path.join(
  REPO_ROOT,
  "integrations/consensus-bench/src/__fixtures__/trump-instance-diffs.json",
);
const diffs = loadDiffsFromFile(diffsPath);
const pairs = truePairs(diffs); // 33 scorable stale-trap pairs, matches CO2/CB4 exactly

if (pairs.length !== 33) {
  console.error(`WARNING: expected 33 scorable trap pairs, got ${pairs.length}. Investigate before running the harness.`);
}

const traps = pairs.map((p, i) => ({
  id: `trap-${String(i + 1).padStart(2, "0")}`,
  kind: "trap",
  revid: p.revid,
  governingNum: p.governingNum,
  staleText: p.staleText,
  governingText: p.govText,
}));

// tensionPairs, transcribed verbatim from
// integrations/consensus-bench/src/consensus-cb6-tension.ts (read-only source of truth;
// duplicated here as JSON rather than imported because that file isn't in dist/ as a
// standalone data module and .ts can't be imported directly by plain node. Transcription
// was done field-by-field against the source file; diff the two if you doubt it.
const tensionPairsSrc = JSON.parse(
  readFileSync(path.join(__dirname, "cb6-tension-pairs.json"), "utf8"),
);

const tensions = tensionPairsSrc.map((t, i) => ({
  id: `tension-${String(i + 1).padStart(2, "0")}`,
  kind: "tension",
  article: t.article,
  num: t.num,
  topic: t.topic,
  positionA: t.statusQuo,
  positionB: t.alternative,
  rfc: t.rfc,
}));

const out = { traps, tensions, total: traps.length + tensions.length };
const outPath = path.join(__dirname, "corpus-b-39.json");
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`Wrote ${outPath}: ${traps.length} traps + ${tensions.length} tensions = ${out.total} items`);
