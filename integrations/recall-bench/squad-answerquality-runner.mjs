// squad-answerquality-runner.mjs — chunk-BM25 answer-quality ablation on SQuAD
// (single-relevant-document human queries; the low-K regime where chunk helps).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  assembleContext, answererPrompt, judgePrompt, composite, pairedBootstrapCI, shuffleSeeded,
} from "./answerquality-lib.mjs";
import { createOpenRouter } from "./openrouter.mjs";

const ROOT = "/Users/mihirwagle/projects/daftari";
const VAULT = "/tmp/squad/vault";
const QFILE = "/tmp/squad/queries.jsonl";
const SQUAD = "/tmp/squad/train-v1.1.json";
const OUT = "/tmp/squad";
const SMOKE = process.argv.includes("--smoke");
const PRESTEP_ONLY = process.argv.includes("--prestep");
const KS = [5, 10];                 // K=5 primary, K=10 robustness
const LEX = { bm25: 1, vector: 0 };
const FALLBACK_CHARS = 1500;
const SEED = 20260624;
const ANSWERER = "anthropic/claude-haiku-4.5";
const JUDGE = "openai/gpt-5.4-mini";
const N = SMOKE ? 25 : 400;
const PRIMARY_K = 5;

const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { buildMatchQuery } = await import(`${ROOT}/dist/search/bm25.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);
const { getAllDocuments } = await import(`${ROOT}/dist/storage/index-db.js`);

const open = openIndexForActiveProvider(VAULT);
if (!open.ok) { console.error("open failed:", open.error.message); process.exit(1); }
const db = open.value;
const docs = getAllDocuments(db);
const docContentByPath = new Map(docs.map((d) => [d.path, d.content]));
console.log(`vault docs=${docs.length}`);

// id -> reference answer (from raw SQuAD)
const squad = JSON.parse(readFileSync(SQUAD, "utf8"));
const answerById = new Map();
for (const a of squad.data) for (const p of a.paragraphs) for (const qa of p.qas) {
  const t = qa.answers?.[0]?.text;
  if (t) answerById.set(qa.id, t);
}
console.log(`answers mapped=${answerById.size}`);

// Best chunk TEXT per doc for a query — mirrors chunkFtsRanking but keeps text.
function bestChunkByPath(query) {
  const mq = buildMatchQuery(query);
  if (mq === null) return new Map();
  const rows = db.prepare(
    `SELECT c.path AS path, c.text AS text, -bm25(chunks_fts) AS score
       FROM chunks_fts JOIN chunks c ON c.rowid = chunks_fts.rowid
      WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts)`,
  ).all(mq);
  const best = new Map();
  for (const r of rows) {
    if (r.score <= 0) continue;
    const prev = best.get(r.path);
    if (!prev || r.score > prev.score) best.set(r.path, { text: r.text, score: r.score });
  }
  return new Map([...best].map(([p, v]) => [p, v.text]));
}

let vu = null;
async function retrieve(q, granularity, limit) {
  const res = await hybridSearch(db, q, { limit, weights: LEX, lexicalGranularity: granularity });
  if (!res.ok) throw new Error(res.error.message);
  if (vu === null) vu = res.value.vectorUsed;
  else if (vu !== res.value.vectorUsed) throw new Error(`vectorUsed flipped (${vu} vs ${res.value.vectorUsed})`);
  if (res.value.vectorUsed !== false) throw new Error("vectorUsed not false — lexical purity broken");
  return res.value.hits;
}
const hitAtK = (hits, relPath, K) => hits.slice(0, K).some((h) => h.path === relPath) ? 1 : 0;

// --- load queries + join answers + deterministic single-stratum sample ---
const raw = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const withAns = raw.filter((q) => answerById.has(q.id));
console.log(`queries=${raw.length} withAnswer=${withAns.length} dropped=${raw.length - withAns.length}`);
const sample = shuffleSeeded(withAns, SEED).slice(0, N);
console.log(`sample=${sample.length}`);

// --- divergence pre-step ($0 lexical) ---
// Guard headroom at the SAME K the paid experiment runs (PRIMARY_K), so this
// catches the RB failure mode (arms diverge at low K but are a null at the
// experiment's K). Verified full-N divergence: hit@5 +0.055, hit@1 +0.128.
// In SMOKE (N=25) the first-25 queries saturate hit@5 to ~1.0/1.0 → a false
// zero; smoke is a plumbing test, so we report but DON'T abort there. A K=1
// reference line is also printed for visibility.
const DIV_K = PRIMARY_K;
const maxK = Math.max(...KS);
let divSum = 0, div1 = 0, divN = 0;
for (const q of sample) {
  const dHits = await retrieve(q.query, "document", maxK);
  const cHits = await retrieve(q.query, "chunk", maxK);
  divSum += hitAtK(cHits, q.relevantPath, DIV_K) - hitAtK(dHits, q.relevantPath, DIV_K);
  div1 += hitAtK(cHits, q.relevantPath, 1) - hitAtK(dHits, q.relevantPath, 1);
  divN += 1;
}
const divergence = divN ? divSum / divN : 0;
console.log(`divergence (hit@${DIV_K}, chunk - document): ${divergence.toFixed(4)} over ${divN} q (hit@1 ref: ${(div1 / divN).toFixed(4)})`);
if (divergence <= 0.01) {
  if (!SMOKE) {
    console.error(`PRE-STEP GATE FAIL: arms do not diverge at K=${DIV_K} — answering would be a null experiment.`);
    process.exit(2);
  }
  console.warn(`(smoke) divergence ~0 at K=${DIV_K} — expected on N=25 (saturated); proceeding for plumbing only.`);
} else {
  console.log("pre-step gate PASS.");
}
if (PRESTEP_ONLY) { console.log("--prestep: exiting before paid loop ($0)."); process.exit(0); }

// --- paid phase: answer + judge ---
const llm = createOpenRouter();
const perQ = [];
let done = 0;
for (const q of sample) {
  const ref = answerById.get(q.id);
  const best = bestChunkByPath(q.query); // one chunk-FTS pass reused across arms+Ks
  const row = { id: q.id, relevantPath: q.relevantPath, cells: [] };
  for (const arm of ["document", "chunk"]) {
    const hits = await retrieve(q.query, arm, maxK);
    for (const K of KS) {
      const topPaths = hits.slice(0, K).map((h) => h.path);
      const { text: ctx, totalChars, sources } = assembleContext(topPaths, best, docContentByPath, { fallbackChars: FALLBACK_CHARS }, { detailed: true });
      const answer = await llm.chat({ model: ANSWERER, system: "", user: answererPrompt(ctx, q.query), temperature: 0, maxTokens: 512 });
      let grade;
      try {
        grade = await llm.chatJson({ model: JUDGE, system: "", user: judgePrompt(q.query, ref, answer), temperature: 0, maxTokens: 400 });
      } catch (e) { grade = { correctness: 0, completeness: 0, hallucination: 0, reasoning: `judge-parse-fail: ${String(e).slice(0,120)}` }; }
      row.cells.push({
        arm, K, contextChars: totalChars, fallbackCount: sources.filter((s) => s.source === "fallback").length,
        retrieved: topPaths, hit: hitAtK(hits, q.relevantPath, K),
        answer, grade, composite: composite(grade),
      });
    }
  }
  perQ.push(row);
  if (++done % 25 === 0) console.log(`  ${done}/${sample.length} done; usage=${JSON.stringify(llm.usage)}`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/answerquality-perq.json`, JSON.stringify({ smoke: SMOKE, ks: KS, models: { ANSWERER, JUDGE }, usage: llm.usage, perQ }, null, 2));
console.log(`wrote per-q (${perQ.length}); usage=${JSON.stringify(llm.usage)}`);

// --- aggregate (single stratum) ---
function cell(row, arm, K) { return row.cells.find((c) => c.arm === arm && c.K === K); }
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const summary = { n: perQ.length, byK: {}, gate: {}, usage: llm.usage, models: { ANSWERER, JUDGE } };
for (const K of KS) {
  const deltas = perQ.map((r) => cell(r, "chunk", K).composite - cell(r, "document", K).composite);
  const ci = pairedBootstrapCI(deltas, { iters: 2000, seed: SEED, alpha: 0.05 });
  summary.byK[K] = {
    n: perQ.length,
    documentComposite: +mean(perQ.map((r) => cell(r, "document", K).composite)).toFixed(3),
    chunkComposite: +mean(perQ.map((r) => cell(r, "chunk", K).composite)).toFixed(3),
    delta: +ci.mean.toFixed(3), ci95: [+ci.lo.toFixed(3), +ci.hi.toFixed(3)],
    documentHit: +mean(perQ.map((r) => cell(r, "document", K).hit)).toFixed(3),
    chunkHit: +mean(perQ.map((r) => cell(r, "chunk", K).hit)).toFixed(3),
    documentHalluc: +mean(perQ.map((r) => 1 - cell(r, "document", K).grade.hallucination)).toFixed(3),
    chunkHalluc: +mean(perQ.map((r) => 1 - cell(r, "chunk", K).grade.hallucination)).toFixed(3),
    documentCtxChars: Math.round(mean(perQ.map((r) => cell(r, "document", K).contextChars))),
    chunkCtxChars: Math.round(mean(perQ.map((r) => cell(r, "chunk", K).contextChars))),
  };
}
const prim = summary.byK[PRIMARY_K];
const NOISE = -0.1;
summary.gate = {
  primaryK: PRIMARY_K,
  nonRegression: prim.ci95[0] >= NOISE,
  positive: prim.ci95[0] > 0,
  verdict: prim.ci95[0] >= NOISE ? "PASS" : "FAIL",
  kTrendNote: `chunk-document delta @${KS[0]}=${summary.byK[KS[0]].delta} @${KS[1]}=${summary.byK[KS[1]].delta} (expect shrink as K grows on SQuAD)`,
};
writeFileSync(`${OUT}/answerquality-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
