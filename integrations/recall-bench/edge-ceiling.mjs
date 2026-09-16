import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// MAV-154's $0 reachability-ceiling arm: before any retrieval integration is
// built, measure whether one hop along the edge graph can even REACH the
// relevant docs the ranker missed — pure graph arithmetic, no model, no
// spend. The exact analog of the structural-ceiling computation that killed
// the coverage pass (2026-06-22) before its LLM arm ran.
//
// For each labeled question: seeds = top-K ranked hits; the expansion set is
// every doc within one hop of a seed over the chosen edge subset; the
// ceiling assumes expansion adds ALL of them (no selection policy — an
// upper bound by construction). The honest comparison is rank-extension at
// the SAME add budget: top-(K + |expansion|) by relevance. Three subsets:
//   all       — tensions + all non-revoked derives_from (what topicEgoGraph
//               traverses today, zero-strength candidates included)
//   trigger   — tensions + trigger-bearing derives_from only
//   tensions  — tension links only
// Kill reading (MAV-154): if ceilingRecall <= rankExtRecall at matched
// budget on the target corpus, edge expansion cannot win — retire before
// building. On the synthetic edgehop corpus the aligned edges are
// constructed, so a WIN there validates only the harness; a LOSS there
// would kill the mechanism outright.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const VAULT = process.env.EDGEHOP_VAULT ?? "/tmp/edgehop/vault";
const QFILE = process.env.EDGEHOP_QUERIES ?? "/tmp/edgehop/queries.jsonl";
const OUT = process.env.EDGEHOP_OUT ?? "/tmp/edgehop";
const SEED_LIMIT = 10;
// Strength ages with real time; pin `now` so a rerun months later classifies
// the same edges as trigger-bearing.
const NOW = new Date(process.env.EDGEHOP_NOW ?? "2026-08-17T00:00:00Z");

const { hybridSearch } = await import(join(ROOT, "dist/search/hybrid.js"));
const { openIndexForActiveProvider } = await import(join(ROOT, "dist/tools/search.js"));
const { listEdges } = await import(join(ROOT, "dist/curation/edges.js"));
const { listTensions } = await import(join(ROOT, "dist/curation/tension.js"));
const { topicEgoGraphFrom } = await import(join(ROOT, "dist/canon/topic.js"));

const opened = openIndexForActiveProvider(VAULT);
if (!opened.ok) {
  console.error("open index failed:", opened.error.message);
  process.exit(1);
}
const DB = opened.value;

const edgesRes = await listEdges(VAULT, {}, NOW);
if (!edgesRes.ok) throw new Error(`listEdges: ${edgesRes.error.message}`);
const tensionsRes = await listTensions(VAULT);
if (!tensionsRes.ok) throw new Error(`listTensions: ${tensionsRes.error.message}`);
const tensions = tensionsRes.value;
const nonRevoked = edgesRes.value.filter((e) => e.status !== "revoked");
const SUBSETS = {
  all: { tensions, edges: nonRevoked },
  trigger: { tensions, edges: nonRevoked.filter((e) => e.status === "trigger-bearing") },
  tensions: { tensions, edges: [] },
};

const queries = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const recallOf = (got, rel) => rel.filter((p) => got.has(p)).length / rel.length;

let vectorUsed = null;
const perQ = [];
for (const q of queries) {
  const res = await hybridSearch(DB, q.query, { limit: 180 });
  if (!res.ok) throw new Error(`search failed on ${q.id}: ${res.error.message}`);
  if (vectorUsed === null) vectorUsed = res.value.vectorUsed;
  else if (vectorUsed !== res.value.vectorUsed) throw new Error("vectorUsed flipped mid-run");
  const ranked = res.value.hits.map((h) => h.path);
  const seeds = ranked.slice(0, SEED_LIMIT);
  const seedSet = new Set(seeds);
  const seedRecall = recallOf(seedSet, q.relevant);

  const bySubset = {};
  for (const [name, { tensions: ts, edges }] of Object.entries(SUBSETS)) {
    const expansion = new Set();
    for (const seed of seeds) {
      for (const p of topicEgoGraphFrom(ts, edges, seed, 1)) {
        if (!seedSet.has(p)) expansion.add(p);
      }
    }
    const budget = expansion.size;
    const ceilingSet = new Set([...seeds, ...expansion]);
    const rankExtSet = new Set(ranked.slice(0, SEED_LIMIT + budget));
    const relevantSet = new Set(q.relevant);
    const expansionRelevant = [...expansion].filter((p) => relevantSet.has(p)).length;
    bySubset[name] = {
      budget,
      ceilingRecall: +recallOf(ceilingSet, q.relevant).toFixed(4),
      rankExtRecall: +recallOf(rankExtSet, q.relevant).toFixed(4),
      expansionPrecision: budget ? +(expansionRelevant / budget).toFixed(4) : null,
    };
  }
  perQ.push({ id: q.id, type: q.type, seedRecall: +seedRecall.toFixed(4), bySubset });
}

const types = [...new Set(perQ.map((p) => p.type))];
const mean = (vals) => (vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : null);
const summary = { vectorUsed, now: NOW.toISOString(), seedLimit: SEED_LIMIT, byType: {} };
for (const t of types) {
  const qs = perQ.filter((p) => p.type === t);
  summary.byType[t] = { n: qs.length, seedRecall: mean(qs.map((p) => p.seedRecall)) };
  for (const s of Object.keys(SUBSETS)) {
    summary.byType[t][s] = {
      meanBudget: mean(qs.map((p) => p.bySubset[s].budget)),
      ceilingRecall: mean(qs.map((p) => p.bySubset[s].ceilingRecall)),
      rankExtRecall: mean(qs.map((p) => p.bySubset[s].rankExtRecall)),
      expansionPrecision: mean(qs.map((p) => p.bySubset[s].expansionPrecision).filter((x) => x != null)),
    };
  }
}

writeFileSync(join(OUT, "ceiling-perq.json"), JSON.stringify(perQ, null, 2));
writeFileSync(join(OUT, "ceiling-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`edge-ceiling: ${perQ.length} questions -> ${OUT}`);
