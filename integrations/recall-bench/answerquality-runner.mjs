// answerquality-runner.mjs — chunk-BM25 answer-quality ablation (Option A).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  stratifiedSample, assembleContext, answererPrompt, judgePrompt, JUDGE_SCHEMA,
  composite, pairedBootstrapCI,
} from "./answerquality-lib.mjs";
import { createOpenRouter } from "./openrouter.mjs";

const ROOT = "/Users/mihirwagle/projects/daftari";
const QFILE = `${ROOT}/integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`;
const VAULT = "/tmp/cov-recall/vault";
const OUT = "/tmp/cov-recall";
const SMOKE = process.argv.includes("--smoke");
const KS = [5, 10];                 // K=5 primary, K=10 robustness
const LEX = { bm25: 1, vector: 0 };
const FALLBACK_CHARS = 1500;
const SEED = 20260624;
const ANSWERER = "anthropic/claude-haiku-4.5";
const JUDGE = "openai/gpt-5.4-mini";
const N_SINGLE = SMOKE ? 12 : 200;
const N_MULTI = SMOKE ? 13 : 200;
const MULTI_BUCKET_CAP = SMOKE ? 4 : 45;

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

const dayOf = (p) => { const m = /day-(\d+)/.exec(p || ""); return m ? Number(m[1]) : null; };
const daysAtK = (hits, K) => [...new Set(hits.slice(0, K).map((h) => dayOf(h.path)).filter((d) => d !== null))];
const recall = (got, rel) => (rel.length ? rel.filter((d) => got.includes(d)).length / rel.length : null);

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

// --- load + sample ---
const all = readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse);
const sample = stratifiedSample(all, { nSingle: N_SINGLE, nMulti: N_MULTI, multiBucketCap: MULTI_BUCKET_CAP, seed: SEED });
console.log(`sample: ${sample.length} (single=${sample.filter((r)=>r.stratum==="single").length} multi=${sample.filter((r)=>r.stratum==="multi").length})`);

// --- divergence pre-step (the gate; $0 lexical) ---
const maxK = Math.max(...KS);
let divSum = 0, divN = 0;
for (const r of sample.filter((r) => r.stratum === "multi")) {
  const rel = r.qa.relevantDays;
  const dHits = await retrieve(r.qa.question, "document", maxK);
  const cHits = await retrieve(r.qa.question, "chunk", maxK);
  const dR = recall(daysAtK(dHits, 5), rel), cR = recall(daysAtK(cHits, 5), rel);
  if (dR != null && cR != null) { divSum += cR - dR; divN += 1; }
}
const divergence = divN ? divSum / divN : 0;
console.log(`divergence (multi recall@5, chunk - document): ${divergence.toFixed(4)} over ${divN} q`);
if (divergence <= 0.01) {
  console.error("PRE-STEP GATE FAIL: arms do not diverge at K=5 — answering would be a null experiment. Rethink K.");
  process.exit(2);
}
console.log("pre-step gate PASS — proceeding to paid answer/judge phase.");

// --- paid phase: answer + judge ---
const llm = createOpenRouter();
const perQ = [];
let done = 0;
for (const r of sample) {
  const q = r.qa.question, ref = r.qa.referenceAnswer, rel = r.qa.relevantDays;
  const best = bestChunkByPath(q); // one chunk-FTS pass reused across arms+Ks
  const row = { id: r.qa.id, stratum: r.stratum, relLen: rel.length, cells: [] };
  for (const arm of ["document", "chunk"]) {
    const hits = await retrieve(q, arm, Math.max(...KS));
    for (const K of KS) {
      const topPaths = hits.slice(0, K).map((h) => h.path);
      const { text: ctx, totalChars, sources } = assembleContext(topPaths, best, docContentByPath, { fallbackChars: FALLBACK_CHARS }, { detailed: true });
      const answer = await llm.chat({ model: ANSWERER, system: "", user: answererPrompt(ctx, q), temperature: 0, maxTokens: 512 });
      let grade;
      try {
        grade = await llm.chatJson({ model: JUDGE, system: "", user: judgePrompt(q, ref, answer), temperature: 0, maxTokens: 400 });
      } catch (e) { grade = { correctness: 0, completeness: 0, hallucination: 0, reasoning: `judge-parse-fail: ${String(e).slice(0,120)}` }; }
      row.cells.push({
        arm, K, contextChars: totalChars, fallbackCount: sources.filter((s) => s.source === "fallback").length,
        retrieved: topPaths, recall5: recall(daysAtK(hits, 5), rel),
        answer, grade, composite: composite(grade),
      });
    }
  }
  perQ.push(row);
  if (++done % 10 === 0) console.log(`  ${done}/${sample.length} done; usage=${JSON.stringify(llm.usage)}`);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/answerquality-perq.json`, JSON.stringify({ smoke: SMOKE, ks: KS, models: { ANSWERER, JUDGE }, usage: llm.usage, perQ }, null, 2));
console.log(`wrote per-q (${perQ.length}); usage=${JSON.stringify(llm.usage)}`);

// --- aggregate ---
function cell(row, arm, K) { return row.cells.find((c) => c.arm === arm && c.K === K); }
const strata = ["single", "multi"];
const summary = { counts: {}, byStratumK: {}, gate: {}, usage: llm.usage, models: { ANSWERER, JUDGE } };
for (const s of strata) summary.counts[s] = perQ.filter((r) => r.stratum === s).length;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
for (const s of strata) {
  for (const K of KS) {
    const rows = perQ.filter((r) => r.stratum === s);
    const deltas = rows.map((r) => cell(r, "chunk", K).composite - cell(r, "document", K).composite);
    const ci = pairedBootstrapCI(deltas, { iters: 2000, seed: SEED, alpha: 0.05 });
    summary.byStratumK[`${s}@${K}`] = {
      n: rows.length,
      documentComposite: +mean(rows.map((r) => cell(r, "document", K).composite)).toFixed(3),
      chunkComposite: +mean(rows.map((r) => cell(r, "chunk", K).composite)).toFixed(3),
      delta: +ci.mean.toFixed(3), ci95: [+ci.lo.toFixed(3), +ci.hi.toFixed(3)],
      documentHalluc: +mean(rows.map((r) => 1 - cell(r, "document", K).grade.hallucination)).toFixed(3),
      chunkHalluc: +mean(rows.map((r) => 1 - cell(r, "chunk", K).grade.hallucination)).toFixed(3),
      documentCtxChars: Math.round(mean(rows.map((r) => cell(r, "document", K).contextChars))),
      chunkCtxChars: Math.round(mean(rows.map((r) => cell(r, "chunk", K).contextChars))),
    };
  }
}

// Non-regression gate at the primary K (5): PASS iff single-day CI lower bound >= ~0
// (no regression on the parity surface) AND multi-day delta >= 0.
const PRIMARY_K = 5;
const single = summary.byStratumK[`single@${PRIMARY_K}`];
const multi = summary.byStratumK[`multi@${PRIMARY_K}`];
const NOISE = -0.1; // tolerance: CI lower bound must not fall meaningfully below 0
summary.gate = {
  primaryK: PRIMARY_K,
  singleNoRegression: single.ci95[0] >= NOISE,
  multiNonNegative: multi.delta >= 0,
  verdict: single.ci95[0] >= NOISE && multi.delta >= 0 ? "PASS" : "FAIL",
  kTrendNote: `chunk-document delta @5=${multi.delta} @10=${summary.byStratumK[`multi@10`].delta} (expect shrink as K grows)`,
};

writeFileSync(`${OUT}/answerquality-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
