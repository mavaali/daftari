import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = "/Users/mihirwagle/projects/daftari";
const QFILE = `${ROOT}/integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`;
const DAY_VAULT = "/tmp/cov-recall/vault";
const ATOM_VAULT = "/tmp/cov-recall/atom-vault";
const OUT = "/tmp/cov-recall";
const SMOKE = process.argv.includes("--smoke");
const KS = [10, 20, 50];
const LEX = { bm25: 1, vector: 0 };

const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);
const { getAllDocuments } = await import(`${ROOT}/dist/storage/index-db.js`);

function openVault(path) {
  const r = openIndexForActiveProvider(path);
  if (!r.ok) { console.error(`open ${path} failed:`, r.error.message); process.exit(1); }
  return r.value;
}
const DAY = openVault(DAY_VAULT);
const ATOM = openVault(ATOM_VAULT);
const maxK = Math.max(...KS);
console.log(`vaults: day=${getAllDocuments(DAY).length} atom=${getAllDocuments(ATOM).length}`);

const dayOf = (p) => { const m = /day-(\d+)/.exec(p || ""); return m ? Number(m[1]) : null; };
const recall = (got, rel) => (rel.length ? rel.filter((d) => got.includes(d)).length / rel.length : null);
const daysAtK = (hits, K) => [...new Set(hits.slice(0, K).map((h) => dayOf(h.path)).filter((d) => d !== null))];

async function retrieve(db, q, opts) {
  const res = await hybridSearch(db, q, opts);
  if (!res.ok) throw new Error(res.error.message);
  return res.value;
}

const recs = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const cases = SMOKE ? recs.slice(0, 25) : recs;

let vu = null;
const perQ = [];
for (const r of cases) {
  const q = r.qa.question;
  const rel = r.qa.relevantDays || [];
  const dayDoc = await retrieve(DAY, q, { limit: maxK, weights: LEX, lexicalGranularity: "document" });
  const dayChunk = await retrieve(DAY, q, { limit: maxK, weights: LEX, lexicalGranularity: "chunk" });
  const atom = await retrieve(ATOM, q, { limit: maxK, weights: LEX, lexicalGranularity: "document" });
  for (const v of [dayDoc.vectorUsed, dayChunk.vectorUsed, atom.vectorUsed]) {
    if (vu === null) vu = v;
    else if (v !== vu) throw new Error(`vectorUsed flipped (${vu} vs ${v}); pin provider / ensure lexical-only`);
  }
  const row = { id: r.qa.id, relLen: rel.length, rel, dayDoc: {}, dayChunk: {}, atom: {} };
  for (const K of KS) {
    row.dayDoc[K] = recall(daysAtK(dayDoc.hits, K), rel);
    row.dayChunk[K] = recall(daysAtK(dayChunk.hits, K), rel);
    row.atom[K] = recall(daysAtK(atom.hits, K), rel);
  }
  perQ.push(row);
}

const multi = perQ.filter((p) => p.relLen > 1);
const meanAt = (qset, arm, K) => {
  const v = qset.map((p) => p[arm][K]).filter((x) => x != null);
  return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : null;
};
const curve = (arm) => Object.fromEntries(KS.map((K) => [K, meanAt(multi, arm, K)]));
const summary = {
  counts: { total: perQ.length, multi: multi.length },
  vectorUsed: vu,
  multiDay: { dayDoc: curve("dayDoc"), dayChunk: curve("dayChunk"), atom: curve("atom") },
};
summary.gapRecovered = Object.fromEntries(KS.map((K) => {
  const floor = summary.multiDay.dayDoc[K], ceil = summary.multiDay.atom[K], got = summary.multiDay.dayChunk[K];
  const denom = ceil - floor;
  return [K, denom > 0 ? +(((got - floor) / denom)).toFixed(3) : null];
}));

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/chunkbm25-perq.json`, JSON.stringify({ ks: KS, smoke: SMOKE, perQ }, null, 2));
writeFileSync(`${OUT}/chunkbm25-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
