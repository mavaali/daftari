#!/usr/bin/env node
// Phase 3 assertions: the untouched consolidate loop ran over the imported
// vault; this script checks what the tension graph caught, against the
// planted ground truth. No LLM — pure readback of .daftari/tensions.md and
// the connected-component computation.
//
//   node assert-tensions.mjs [vaultRoot]
//
// Exit 1 if any REQUIRED assertion fails. Writes tension-report.json.

import { writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { listTensions } from "../../dist/curation/tension.js";
import { loadTensionClusters } from "../../dist/curation/tension-clusters.js";

const vaultRoot = resolve(process.argv[2] ?? "./vault");

// Plant signatures over NOTE FILE CONTENTS (same spirit as fixtures'
// PLANTS, retargeted at the derived markdown). Each maps to exactly one
// note path once resolved.
const PLANT_SIGS = {
  "NW-A": /(?=[\s\S]*500)(?=[\s\S]*(request|rps))/i,
  "NW-B": /(?=[\s\S]*(350|re-?shard))(?=[\s\S]*(request|rps))/i,
  "NW-C": /(?=[\s\S]*800)(?=[\s\S]*(request|rps))/i,
  "NW-D": /(?=[\s\S]*200)(?=[\s\S]*(request|rps|throttl))/i,
  PC1a: /us-east-1/i,
  PC1b: /eu-west-2/i,
  PC2a: /(?=[\s\S]*90)(?=[\s\S]*(day|retention))(?=[\s\S]*log)/i,
  PC2b: /(?=[\s\S]*log)(?=[\s\S]*(two\s*week|14\s*day|2\s*week))/i,
  PC3a: /(?=[\s\S]*platform team)(?=[\s\S]*(on.?call|pager))/i,
  PC3b: /(?=[\s\S]*application team)(?=[\s\S]*(incident|outage|page))/i,
  TT1a: /postgres(ql)?\s*13/i,
  TT1b: /(?=[\s\S]*postgres(ql)?\s*16)(?=[\s\S]*(eu|q3))/i,
  TT2a: /(?=[\s\S]*sha-?1\b)(?=[\s\S]*webhook)/i,
  TT2b: /(?=[\s\S]*sha-?256)(?=[\s\S]*(webhook|workspace))/i,
};

const EXPECTED_PAIRS = [
  ["PC1a", "PC1b"],
  ["PC2a", "PC2b"],
  ["PC3a", "PC3b"],
];
const NWAY = ["NW-A", "NW-B", "NW-C", "NW-D"];
const TEMPORAL_PAIRS = [
  ["TT1a", "TT1b"],
  ["TT2a", "TT2b"],
];

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

// ---- resolve each plant to its note path
const noteFiles = await walk(vaultRoot);
const plantPath = {};
for (const f of noteFiles) {
  const text = await readFile(f, "utf-8");
  const rel = f.slice(vaultRoot.length + 1);
  for (const [pid, rx] of Object.entries(PLANT_SIGS)) {
    if (rx.test(text)) (plantPath[pid] ??= []).push(rel);
  }
}
const failures = [];
const report = { plants: {}, pairwise: {}, nway: {}, temporal: {}, false_positives: {} };

// A plant may own SEVERAL notes: LangMem's extraction sometimes splits one
// fact (or fails to merge a near-dup), so each plant resolves to a note SET.
const pathsOf = {};
for (const pid of Object.keys(PLANT_SIGS)) {
  const hits = plantPath[pid] ?? [];
  report.plants[pid] = hits;
  if (hits.length === 0) failures.push(`plant ${pid}: no note matches its signature`);
  pathsOf[pid] = hits;
}
const plantedPaths = new Set(Object.values(pathsOf).flat());

// ---- read tensions
const tensions = await listTensions(vaultRoot);
if (!tensions.ok) {
  console.error("cannot read tensions:", tensions.error.message);
  process.exit(1);
}
const entries = tensions.value;
const touching = (path) =>
  entries.filter((t) => t.sourceA.includes(path) || t.sourceB.includes(path));
const linkedPair = (a, b) =>
  entries.some(
    (t) =>
      (t.sourceA.includes(a) && t.sourceB.includes(b)) ||
      (t.sourceA.includes(b) && t.sourceB.includes(a)),
  );
// linked over note SETS: any cross-pair counts
const linked = (pidA, pidB) =>
  (pathsOf[pidA] ?? []).some((a) => (pathsOf[pidB] ?? []).some((b) => linkedPair(a, b)));

// REQUIRED: each pairwise contradiction flagged as a tension between its two notes
for (const [a, b] of EXPECTED_PAIRS) {
  const hit = linked(a, b);
  report.pairwise[`${a}-${b}`] = hit;
  if (!hit) failures.push(`pairwise ${a}<->${b}: no tension links the two notes`);
}

// REQUIRED: the n-way set surfaces as ONE connected component containing all 4
const clusters = await loadTensionClusters(vaultRoot);
if (!clusters.ok) {
  console.error("cannot compute clusters:", clusters.error.message);
  process.exit(1);
}
report.cluster_count = clusters.value.cluster_count;
report.clusters = clusters.value.clusters.map((c) => ({
  id: c.id,
  size: c.size,
  documents: c.documents,
}));
const inCluster = (c, pid) =>
  (pathsOf[pid] ?? []).some((p) => c.documents.some((d) => d.includes(p)));
const containing = clusters.value.clusters.filter((c) => NWAY.some((pid) => inCluster(c, pid)));
const oneComponent = containing.length === 1 && NWAY.every((pid) => inCluster(containing[0], pid));
report.nway = {
  paths: Object.fromEntries(NWAY.map((pid) => [pid, pathsOf[pid]])),
  clusters_touching: containing.map((c) => c.id),
  one_component_with_all_4: oneComponent,
};
if (NWAY.some((pid) => (pathsOf[pid] ?? []).length === 0)) failures.push(`n-way: unresolved plant note`);
else if (!oneComponent)
  failures.push(
    `n-way: expected ONE component containing all 4 capacity notes, got ${containing.length} cluster(s)`,
  );

// REPORTED (not required): temporal traps flagged
for (const [a, b] of TEMPORAL_PAIRS) {
  report.temporal[`${a}-${b}`] = linked(a, b);
}

// REQUIRED: zero tensions touching filler-only notes (false-positive rate)
const fp = entries.filter((t) => {
  const aPlanted = [...plantedPaths].some((p) => t.sourceA.includes(p));
  const bPlanted = [...plantedPaths].some((p) => t.sourceB.includes(p));
  return !(aPlanted && bPlanted);
});
report.false_positives = {
  count: fp.length,
  rate: entries.length ? `${fp.length}/${entries.length}` : "0/0",
  entries: fp.map((t) => ({ title: t.title, a: t.sourceA, b: t.sourceB })),
};

report.tension_total = entries.length;
writeFileSync(join(process.cwd(), "tension-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (failures.length) {
  console.error("\nFAILURES:");
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log(
  `\nPASS: ${EXPECTED_PAIRS.length} pairwise linked; n-way is one ${containing[0]?.size}-doc component; ` +
    `false positives: ${report.false_positives.rate}`,
);
