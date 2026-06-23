import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = "/Users/mihirwagle/projects/daftari";
const QFILE = `${ROOT}/integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`;
const VAULT = "/tmp/cov-recall/vault";
const OUT = "/tmp/cov-recall";
const LIMIT = 10;
const SHIPPED_MAXADD = 5;
const GEN_LIMIT = 180; // whole vault — bounded; lets us read top-(LIMIT+m) for any m
const SMOKE = process.argv.includes("--smoke");

const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { applyCoveragePass, DEFAULT_COVERAGE_OPTIONS } = await import(`${ROOT}/dist/search/coverage.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);

const db = openIndexForActiveProvider(VAULT);
if (!db.ok) {
  console.error("open index failed:", db.error.message);
  process.exit(1);
}
const DB = db.value;

const dayOf = (p) => {
  const m = /day-(\d+)/.exec(p || "");
  return m ? Number(m[1]) : null;
};
const daysOf = (hits) => [...new Set(hits.map((h) => dayOf(h.path)).filter((x) => x !== null))];
const recall = (got, rel) => (rel.length ? rel.filter((d) => got.includes(d)).length / rel.length : null);

const recs = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const cases = SMOKE ? recs.slice(0, 25) : recs;

let vectorUsed = null;
const perQ = [];
let faithChecked = false;

for (const r of cases) {
  const q = r.qa.question;
  const rel = r.qa.relevantDays || [];
  const res = await hybridSearch(DB, q, { limit: GEN_LIMIT });
  if (!res.ok) {
    console.error("search failed:", res.error.message);
    continue;
  }
  // Vector-half parity: must be identical across every retrieval.
  if (vectorUsed === null) vectorUsed = res.value.vectorUsed;
  else if (vectorUsed !== res.value.vectorUsed)
    throw new Error(`vectorUsed flipped (${vectorUsed} -> ${res.value.vectorUsed}); pin the provider`);

  const ranked = res.value.hits;
  const seeds = ranked.slice(0, LIMIT);
  const widened = applyCoveragePass(DB, seeds, { ...DEFAULT_COVERAGE_OPTIONS, maxAdd: 1e9 });
  const added = widened.filter((h) => h.viaCoverage); // full ordered candidate list (created-DESC), uncapped
  const seedDays = daysOf(seeds);

  // Faithfulness assert (once): slicing the precomputed list == the real feature at maxAdd=5.
  if (!faithChecked) {
    const real5 = applyCoveragePass(DB, seeds, { ...DEFAULT_COVERAGE_OPTIONS, maxAdd: SHIPPED_MAXADD })
      .filter((h) => h.viaCoverage)
      .map((h) => h.path);
    const sliced5 = added.slice(0, SHIPPED_MAXADD).map((h) => h.path);
    if (JSON.stringify(real5) !== JSON.stringify(sliced5))
      throw new Error(`faithfulness FAIL: sliced!=applyCoveragePass@5\n${JSON.stringify({ real5, sliced5 })}`);
    faithChecked = true;
  }

  const sweepMax = added.length; // uncapped end = full window
  const curve = [];
  for (let m = 0; m <= sweepMax; m++) {
    const covDays = [...new Set([...seedDays, ...daysOf(added.slice(0, m))])];
    const rankExtDays = daysOf(ranked.slice(0, LIMIT + m));
    const addedRelevant = added
      .slice(0, m)
      .map((h) => dayOf(h.path))
      .filter((d) => rel.includes(d)).length;
    curve.push({
      m,
      covRecall: recall(covDays, rel),
      rxRecall: recall(rankExtDays, rel),
      addedRelevant,
      covRealized: covDays.length,
    });
  }
  perQ.push({ id: r.qa.id, relLen: rel.length, rel, seedDays, addedDays: daysOf(added), curve });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/recall-perq.json`, JSON.stringify({ vectorUsed, smoke: SMOKE, perQ }, null, 2));
console.log(`recall-runner: ${perQ.length} questions, vectorUsed=${vectorUsed}, faithfulness=OK -> ${OUT}/recall-perq.json`);

// --- aggregate: curves split by single vs multi-day, conditioned on relevantDays length ---
function curveAt(qset, key) {
  // mean over questions of recall at each m, padding short curves with their last value (uncapped plateau)
  const maxM = Math.max(...qset.map((p) => p.curve.length - 1), 0);
  const out = [];
  for (let m = 0; m <= maxM; m++) {
    const vals = qset
      .map((p) => (p.curve[Math.min(m, p.curve.length - 1)] || {})[key])
      .filter((x) => x != null);
    out.push(vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : null);
  }
  return out;
}
const multi = perQ.filter((p) => p.relLen > 1);
const single = perQ.filter((p) => p.relLen === 1);
const atShipped = (qset, key) =>
  +qset
    .map((p) => (p.curve[Math.min(SHIPPED_MAXADD, p.curve.length - 1)] || {})[key])
    .filter((x) => x != null)
    .reduce((a, b, _, arr) => a + b / arr.length, 0)
    .toFixed(4);

const lenDist = {};
for (const p of multi) lenDist[p.relLen] = (lenDist[p.relLen] || 0) + 1;

const summary = {
  counts: { total: perQ.length, single: single.length, multi: multi.length },
  multiDayLengthDistribution: lenDist,
  multiDay: {
    covRecallCurve: curveAt(multi, "covRecall"),
    rankExtRecallCurve: curveAt(multi, "rxRecall"),
    atShipped5: { covRecall: atShipped(multi, "covRecall"), rxRecall: atShipped(multi, "rxRecall") },
    uncappedEnd: { covRecall: curveAt(multi, "covRecall").at(-1), rxRecall: curveAt(multi, "rxRecall").at(-1) },
  },
  singleDay: { atShipped5: { covRecall: atShipped(single, "covRecall"), rxRecall: atShipped(single, "rxRecall") } },
};
writeFileSync(`${OUT}/recall-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
