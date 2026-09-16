import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// off.1/MAV-154 SELECTIVE arm. The ceiling arm (edge-ceiling.mjs) proved one
// hop can REACH the missed docs (inject-ALL upper bound). This measures how
// much of that headroom the REAL, shipped selection realizes: the tau-floored,
// affinity-ranked, capped policy from src/search/graph-expansion.ts vs
// rank-extension at the SAME realized add budget. The honest comparison the
// bead's kill condition names — if selective expansion recall <= rank-extension
// recall at matched budget, the mechanism loses to just reading further down
// the ranked list.
//
// Subset is fixed to "trigger" (tensions + trigger-bearing derives_from), the
// ceiling winner. We sweep cap x tau and, per question type, report
// expansionRecall vs rankExtRecall plus distractor load (addedRelevant /
// addedDistractor / precision) so the chosen defaults are justified by numbers.
//
// Synthetic-corpus caveat (unchanged from the ceiling note): the edgehop
// vault's aligned edges are constructed, so a WIN here validates the harness +
// the selection policy, not wild alignment (bead off.6).

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const VAULT = process.env.EDGEHOP_VAULT ?? "/tmp/edgehop/vault";
const QFILE = process.env.EDGEHOP_QUERIES ?? "/tmp/edgehop/queries.jsonl";
const OUT = process.env.EDGEHOP_OUT ?? "/tmp/edgehop";
const SEED_LIMIT = 10;
const CAPS = (process.env.EDGEHOP_CAPS ?? "5,10,20").split(",").map(Number);
const TAUS = (process.env.EDGEHOP_TAUS ?? "0.2,0.3,0.4").split(",").map(Number);
// Strength ages with real time; pin `now` so a rerun months later classifies
// the same edges as trigger-bearing.
const NOW = new Date(process.env.EDGEHOP_NOW ?? "2026-08-17T00:00:00Z");

const { hybridSearch } = await import(join(ROOT, "dist/search/hybrid.js"));
const { openIndexForActiveProvider } = await import(join(ROOT, "dist/tools/search.js"));
const { listEdges } = await import(join(ROOT, "dist/curation/edges.js"));
const { listTensions } = await import(join(ROOT, "dist/curation/tension.js"));
const { topicEgoGraphFrom } = await import(join(ROOT, "dist/canon/topic.js"));
const { selectExpansion, maxChunkCosine } = await import(
  join(ROOT, "dist/search/graph-expansion.js")
);
const { embedQuery, getProvider } = await import(join(ROOT, "dist/search/vector.js"));

const opened = openIndexForActiveProvider(VAULT);
if (!opened.ok) {
  console.error("open index failed:", opened.error.message);
  process.exit(1);
}
const DB = opened.value;
const provider = getProvider();

// Trigger subset only (tensions + trigger-bearing derives_from), the ceiling winner.
const edgesRes = await listEdges(VAULT, { status: "trigger-bearing" }, NOW);
if (!edgesRes.ok) throw new Error(`listEdges: ${edgesRes.error.message}`);
const tensionsRes = await listTensions(VAULT);
if (!tensionsRes.ok) throw new Error(`listTensions: ${tensionsRes.error.message}`);
const tensions = tensionsRes.value.map((t) => ({ sourceA: t.sourceA, sourceB: t.sourceB }));
const edges = edgesRes.value
  .filter((e) => e.status !== "revoked")
  .map((e) => ({ fromPath: e.fromPath, toPath: e.toPath, status: e.status }));

const adjacency = (pairs) => {
  const m = new Map();
  const add = (a, b) => {
    let s = m.get(a);
    if (!s) {
      s = new Set();
      m.set(a, s);
    }
    s.add(b);
  };
  for (const [a, b] of pairs) {
    add(a, b);
    add(b, a);
  }
  return m;
};
const edgeNbrs = adjacency(edges.map((e) => [e.fromPath, e.toPath]));
const tensionNbrs = adjacency(tensions.map((t) => [t.sourceA, t.sourceB]));

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
  const relevantSet = new Set(q.relevant);

  const emb = await embedQuery(q.query);
  if (!emb.ok) throw new Error(`embedQuery failed on ${q.id}: ${emb.error.message}`);
  const qEmb = emb.value;

  // Build the neighbor candidate list ONCE (affinity is cap/tau-independent).
  const candidates = [];
  for (const seed of seeds) {
    for (const nbr of topicEgoGraphFrom(tensions, edges, seed, 1)) {
      if (nbr === seed || seedSet.has(nbr)) continue;
      const edgeType = edgeNbrs.get(seed)?.has(nbr)
        ? "derives_from"
        : tensionNbrs.get(seed)?.has(nbr)
          ? "tension"
          : "derives_from";
      candidates.push({ path: nbr, seed, edgeType, affinity: maxChunkCosine(DB, nbr, qEmb, provider) });
    }
  }

  const sweep = {};
  for (const cap of CAPS) {
    for (const tau of TAUS) {
      const chosen = selectExpansion(candidates, seedSet, { cap, tau });
      const budget = chosen.length;
      const expandedSet = new Set([...seeds, ...chosen.map((c) => c.path)]);
      // Rank-extension at the SAME realized add budget.
      const rankExtSet = new Set(ranked.slice(0, SEED_LIMIT + budget));
      const addedRelevant = chosen.filter((c) => relevantSet.has(c.path)).length;
      sweep[`cap${cap}_tau${tau}`] = {
        budget,
        expansionRecall: +recallOf(expandedSet, q.relevant).toFixed(4),
        rankExtRecall: +recallOf(rankExtSet, q.relevant).toFixed(4),
        addedRelevant,
        addedDistractor: budget - addedRelevant,
        precision: budget ? +(addedRelevant / budget).toFixed(4) : null,
      };
    }
  }
  perQ.push({
    id: q.id,
    type: q.type,
    seedRecall: +recallOf(seedSet, q.relevant).toFixed(4),
    sweep,
  });
}

const types = [...new Set(perQ.map((p) => p.type))];
const mean = (vals) =>
  vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : null;
const summary = {
  vectorUsed,
  now: NOW.toISOString(),
  seedLimit: SEED_LIMIT,
  subset: "trigger",
  caps: CAPS,
  taus: TAUS,
  byType: {},
};
for (const t of types) {
  const qs = perQ.filter((p) => p.type === t);
  summary.byType[t] = { n: qs.length, seedRecall: mean(qs.map((p) => p.seedRecall)), sweep: {} };
  for (const cap of CAPS) {
    for (const tau of TAUS) {
      const k = `cap${cap}_tau${tau}`;
      summary.byType[t].sweep[k] = {
        meanBudget: mean(qs.map((p) => p.sweep[k].budget)),
        expansionRecall: mean(qs.map((p) => p.sweep[k].expansionRecall)),
        rankExtRecall: mean(qs.map((p) => p.sweep[k].rankExtRecall)),
        delta: +(
          mean(qs.map((p) => p.sweep[k].expansionRecall)) -
          mean(qs.map((p) => p.sweep[k].rankExtRecall))
        ).toFixed(4),
        meanAddedRelevant: mean(qs.map((p) => p.sweep[k].addedRelevant)),
        meanAddedDistractor: mean(qs.map((p) => p.sweep[k].addedDistractor)),
        precision: mean(qs.map((p) => p.sweep[k].precision).filter((x) => x != null)),
      };
    }
  }
}

writeFileSync(join(OUT, "expansion-perq.json"), JSON.stringify(perQ, null, 2));
writeFileSync(join(OUT, "expansion-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log(`edge-expansion: ${perQ.length} questions -> ${OUT}`);
