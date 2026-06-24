import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = "/Users/mihirwagle/projects/daftari";
const QFILE = `${ROOT}/integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`;
const DAY_VAULT = "/tmp/cov-recall/vault";
const ATOM_VAULT = "/tmp/cov-recall/atom-vault";
const OUT = "/tmp/cov-recall";
const SMOKE = process.argv.includes("--smoke");
// budget sweep in chars: brackets a few thousand up to ~Stage-3 top-10-days (~110k)
const BUDGETS = [2000, 4000, 8000, 16000, 32000, 64000, 110000];

const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);
const { getDocument, getAllDocuments } = await import(`${ROOT}/dist/storage/index-db.js`);

function openVault(path) {
  const r = openIndexForActiveProvider(path);
  if (!r.ok) {
    console.error(`open ${path} failed:`, r.error.message);
    process.exit(1);
  }
  return r.value;
}
const DAY = openVault(DAY_VAULT);
const ATOM = openVault(ATOM_VAULT);
const dayCount = getAllDocuments(DAY).length;
const atomCount = getAllDocuments(ATOM).length;
console.log(`vaults: day=${dayCount} atom=${atomCount}`);

const dayOf = (p) => {
  const m = /day-(\d+)/.exec(p || "");
  return m ? Number(m[1]) : null;
};
const recall = (got, rel) => (rel.length ? rel.filter((d) => got.includes(d)).length / rel.length : null);

// Fill budget B (chars) by walking ranked hits, adding each doc's true body length
// (from the index, NOT the truncated hit.snippet) until the next would exceed B.
function fillDays(db, hits, B) {
  let used = 0;
  const days = new Set();
  for (const h of hits) {
    const doc = getDocument(db, h.path);
    const len = doc ? doc.content.length : 0;
    if (used + len > B) break;
    used += len;
    const d = dayOf(h.path);
    if (d !== null) days.add(d);
  }
  return [...days];
}

async function retrieve(db, q, limit, weights) {
  const res = await hybridSearch(db, q, weights ? { limit, weights } : { limit });
  if (!res.ok) throw new Error(res.error.message);
  return res.value;
}

const recs = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const cases = SMOKE ? recs.slice(0, 25) : recs;

let vuHybrid = null;
const perQ = [];
for (const r of cases) {
  const q = r.qa.question;
  const rel = r.qa.relevantDays || [];
  const row = { id: r.qa.id, relLen: rel.length, rel, day: {}, atom: {}, dayLex: {}, atomLex: {} };
  // hybrid
  const dH = await retrieve(DAY, q, dayCount);
  const aH = await retrieve(ATOM, q, atomCount);
  if (vuHybrid === null) vuHybrid = dH.vectorUsed;
  for (const v of [dH.vectorUsed, aH.vectorUsed])
    if (v !== vuHybrid) throw new Error(`vectorUsed flipped (${vuHybrid} vs ${v}); pin the provider`);
  // lexical-only
  const dL = await retrieve(DAY, q, dayCount, { bm25: 1, vector: 0 });
  const aL = await retrieve(ATOM, q, atomCount, { bm25: 1, vector: 0 });
  for (const B of BUDGETS) {
    row.day[B] = recall(fillDays(DAY, dH.hits, B), rel);
    row.atom[B] = recall(fillDays(ATOM, aH.hits, B), rel);
    row.dayLex[B] = recall(fillDays(DAY, dL.hits, B), rel);
    row.atomLex[B] = recall(fillDays(ATOM, aL.hits, B), rel);
  }
  perQ.push(row);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(
  `${OUT}/granularity-perq.json`,
  JSON.stringify({ vectorUsed: vuHybrid, budgets: BUDGETS, smoke: SMOKE, perQ }, null, 2),
);
console.log(`granularity-runner: ${perQ.length} questions, vectorUsed=${vuHybrid} -> ${OUT}/granularity-perq.json`);

// --- aggregate: multi-day curves, hybrid + lexical-only, with atom-minus-day gaps ---
function meanAt(qset, arm, B) {
  const v = qset.map((p) => p[arm][B]).filter((x) => x != null);
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : null;
}
const multi = perQ.filter((p) => p.relLen > 1);
const curve = (arm) => Object.fromEntries(BUDGETS.map((B) => [B, meanAt(multi, arm, B)]));
const summary = {
  counts: { total: perQ.length, multi: multi.length },
  vectorUsed: vuHybrid,
  multiDay: {
    hybrid: { day: curve("day"), atom: curve("atom") },
    lexicalOnly: { day: curve("dayLex"), atom: curve("atomLex") },
  },
};
summary.gapHybrid = Object.fromEntries(
  BUDGETS.map((B) => [B, +(summary.multiDay.hybrid.atom[B] - summary.multiDay.hybrid.day[B]).toFixed(4)]),
);
summary.gapLexical = Object.fromEntries(
  BUDGETS.map((B) => [B, +(summary.multiDay.lexicalOnly.atom[B] - summary.multiDay.lexicalOnly.day[B]).toFixed(4)]),
);
writeFileSync(`${OUT}/granularity-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
