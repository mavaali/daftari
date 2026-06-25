import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Q1 generalization runner: document- vs chunk-granularity lexical retrieval over
// the SQuAD article-level vault, on human queries. Single relevant article per
// query -> hit@k / hit@1 / MRR@10. Reuses chunkbm25-runner's import/open pattern
// only (metrics here are path-equality rank, not RB day-coverage).

const ROOT = "/Users/mihirwagle/projects/daftari";
const VAULT = "/tmp/squad/vault";
const QFILE = "/tmp/squad/queries.jsonl";
const OUT = "/tmp/squad";
const LEX = { bm25: 1, vector: 0 };
const KS = [10, 20, 50];
const LIMIT = 50;

const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);
const { getAllDocuments } = await import(`${ROOT}/dist/storage/index-db.js`);

const open = openIndexForActiveProvider(VAULT);
if (!open.ok) {
  console.error("open failed:", open.error.message);
  process.exit(1);
}
const db = open.value;

// Dilution precondition: docs must be genuinely multi-chunk.
const meanChunks = Number(
  db.prepare("SELECT AVG(c) m FROM (SELECT COUNT(*) c FROM chunks GROUP BY path)").get().m,
);
if (!(meanChunks > 3)) {
  console.error(`mean chunks/doc = ${meanChunks} (<=3): articles not multi-topic enough; corpus invalid`);
  process.exit(1);
}
console.log(`docs=${getAllDocuments(db).length} meanChunksPerDoc=${meanChunks.toFixed(1)}`);

const queries = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);

async function retrieve(q, granularity) {
  const res = await hybridSearch(db, q, { limit: LIMIT, weights: LEX, lexicalGranularity: granularity });
  if (!res.ok) throw new Error(res.error.message);
  if (res.value.vectorUsed !== false) throw new Error("vectorUsed not false — lexical purity broken");
  return res.value.hits;
}
const rankOf = (hits, path) => {
  const i = hits.findIndex((h) => h.path === path);
  return i < 0 ? Infinity : i + 1;
};

const perQ = [];
for (const q of queries) {
  const dRank = rankOf(await retrieve(q.query, "document"), q.relevantPath);
  const cRank = rankOf(await retrieve(q.query, "chunk"), q.relevantPath);
  perQ.push({ id: q.id, dRank, cRank });
}

const arm = (key) => {
  const ranks = perQ.map((p) => p[key]);
  const hitAt = (k) => +(ranks.filter((r) => r <= k).length / ranks.length).toFixed(4);
  const hit1 = +(ranks.filter((r) => r === 1).length / ranks.length).toFixed(4);
  const mrr10 = +(ranks.reduce((s, r) => s + (r <= 10 ? 1 / r : 0), 0) / ranks.length).toFixed(4);
  return { hit1, mrr10, ...Object.fromEntries(KS.map((k) => [`hit@${k}`, hitAt(k)])) };
};
const summary = {
  n: perQ.length,
  meanChunksPerDoc: +meanChunks.toFixed(1),
  document: arm("dRank"),
  chunk: arm("cRank"),
};
summary.ceiling =
  summary.document.hit1 >= 0.95
    ? "NO HEADROOM (document arm already ~ceiling — result is a null, not a negative)"
    : "headroom present";

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/squad-perq.json`, JSON.stringify(perQ, null, 2));
writeFileSync(`${OUT}/squad-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
