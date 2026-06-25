import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Two-arm regression runner over the synthetic native-shape vault. For each
// labeled query (body / title / tag token), retrieves under document- and
// chunk-granularity lexical BM25 and records path-equality hit@1 / hit@5.
// Reuses only the import/open pattern from chunkbm25-runner.mjs — metrics here
// are simple path equality, not the RB date-window day-coverage helpers.

const ROOT = "/Users/mihirwagle/projects/daftari";
const VAULT = "/tmp/native-regression/vault";
const QFILE = "/tmp/native-regression/queries.jsonl";
const OUT = "/tmp/native-regression";
const LEX = { bm25: 1, vector: 0 };
const TYPES = ["body", "title", "tag"];

const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);

const open = openIndexForActiveProvider(VAULT);
if (!open.ok) {
  console.error("open failed:", open.error.message);
  process.exit(1);
}
const db = open.value;

const queries = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);

async function retrieve(q, granularity) {
  const res = await hybridSearch(db, q, { limit: 5, weights: LEX, lexicalGranularity: granularity });
  if (!res.ok) throw new Error(res.error.message);
  if (res.value.vectorUsed !== false) throw new Error("vectorUsed not false — lexical purity broken");
  return res.value.hits;
}

const perQ = [];
for (const q of queries) {
  const docHits = await retrieve(q.query, "document");
  const chunkHits = await retrieve(q.query, "chunk");
  perQ.push({
    ...q,
    docHit1: docHits[0]?.path === q.relevantPath,
    docHit5: docHits.slice(0, 5).some((h) => h.path === q.relevantPath),
    chunkHit1: chunkHits[0]?.path === q.relevantPath,
    chunkHit5: chunkHits.slice(0, 5).some((h) => h.path === q.relevantPath),
  });
}

const frac = (rows, key) =>
  rows.length ? +(rows.filter((r) => r[key]).length / rows.length).toFixed(4) : null;
const summary = { total: perQ.length, byType: {} };
for (const t of TYPES) {
  const rows = perQ.filter((r) => r.type === t);
  summary.byType[t] = {
    n: rows.length,
    document: { hit1: frac(rows, "docHit1"), hit5: frac(rows, "docHit5") },
    chunk: { hit1: frac(rows, "chunkHit1"), hit5: frac(rows, "chunkHit5") },
  };
}

// VALIDITY GUARD: the document arm indexes title+tags+body, so it MUST find
// every unique token at hit@1. If it doesn't, the corpus/queries are ambiguous
// (prefix collisions, tokenization) and the comparison is invalid — fail loudly.
for (const t of TYPES) {
  const d1 = summary.byType[t].document.hit1;
  if (d1 === null || d1 < 0.99) {
    console.error(
      `VALIDITY FAIL: document arm hit@1 on ${t} = ${d1} (< 0.99). ` +
        `Corpus/query ground truth is broken; numbers are invalid.`,
    );
    process.exit(1);
  }
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/native-regression-perq.json`, JSON.stringify(perQ, null, 2));
writeFileSync(`${OUT}/native-regression-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
