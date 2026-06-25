# Chunk-BM25 Answer-Quality Ablation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether the chunk-BM25 retrieval-recall win translates into non-regressed end-to-end answer quality, by feeding two retrieval arms (`document` vs `chunk`) to one held-constant single-shot answerer and grading the answers — the last default-flip gate.

**Architecture:** A standalone Node ESM harness in `integrations/recall-bench/` (no `src/` changes). Pure, DB-free helpers (seeded sampler, paired bootstrap, context assembly, scoring) live in `answerquality-lib.mjs` and are unit-tested with vitest. The orchestration runner `answerquality-runner.mjs` opens the existing `/tmp/cov-recall/vault`, runs a $0 lexical divergence pre-step gate, then for each (question, arm, K) retrieves top-K docs, assembles each doc's best lexical chunk, answers via OpenRouter Haiku, and grades via OpenRouter gpt-5.4-mini. Both arms share the answerer/judge — the only variable is retrieval ranking.

**Tech Stack:** Node v22 (global `fetch`), better-sqlite3 (via daftari `dist/`), OpenRouter OpenAI-compatible Chat Completions API, vitest. Reuses `dist/search/hybrid.js` (`hybridSearch`), `dist/search/bm25.js` (`buildMatchQuery`), `dist/tools/search.js` (`openIndexForActiveProvider`), `dist/storage/index-db.js` (`getAllDocuments`).

**Spec:** `docs/superpowers/specs/2026-06-24-chunk-bm25-answer-quality-design.md`

---

## Pre-flight (read before Task 1)

- **Branch:** stay on `exp/chunk-bm25-squad-generalization` (has #155 chunk ranker + #157 tiered combine; title/tag tier is inert on RB). No worktree needed — the harness is purely additive.
- **Build is current:** `dist/search/hybrid.js`, `dist/search/bm25.js`, `dist/storage/index-db.js`, `dist/tools/search.js` all exist. If you edit any `src/`, rebuild with `npm run build` from repo root — but this plan touches **no** `src/`.
- **Vault present:** `/tmp/cov-recall/vault` (180 day-docs). If missing, it regenerates from `integrations/recall-bench/prep-vault.mjs` (see that script's header).
- **Questions:** `integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl` — 1489 records, each `{ qa: { id, question, referenceAnswer, relevantDays:[dayNums], category, difficulty } }`. Pool: 510 single-day, 979 multi-day (281 in the 2–6-day buckets, 698 seven-day).
- **Secrets:** `process.env.OPENROUTER_API_KEY` is present (verified, `sk-or-v1…`), exported from `~/.zshenv`. The runner reads it directly. Do **not** print the key.
- **Models (verified live on OpenRouter):** answerer `anthropic/claude-haiku-4.5`, judge `openai/gpt-5.4-mini`. Endpoint `https://openrouter.ai/api/v1/chat/completions`.
- **Cost discipline:** smoke (N=25) before the full run; log token usage every call; abort the divergence pre-step if arms don't diverge (don't pay for a null experiment).

### Key facts pinned from the codebase

- `hybridSearch(db, query, { limit, weights, lexicalGranularity })` → `Result<{ hits: HybridHit[], vectorUsed: boolean }, …>`. `HybridHit` has `path`, `score`, `snippet` (only ±140 chars — too short to answer from, so we pull full chunk text instead). Lexical-only via `weights:{bm25:1,vector:0}` → `vectorUsed:false`.
- `chunkFtsRanking` (`src/search/hybrid.ts:208`) ranks per-chunk then collapses to best-chunk-per-doc, so **both arms output a ranked document list** — only order differs.
- The best chunk's **text** is fetched with the same FTS string the ranker builds: `import { buildMatchQuery } from dist/search/bm25.js`, then `SELECT c.path, c.text, -bm25(chunks_fts) AS score FROM chunks_fts JOIN chunks c ON c.rowid=chunks_fts.rowid WHERE chunks_fts MATCH ? ORDER BY bm25(chunks_fts)` and keep the max-score row per path (mirrors `chunkFtsRanking` exactly, but keeps `text`).
- `db` (from `openIndexForActiveProvider(path).value`) exposes better-sqlite3 `.prepare(...)` (see `squad-runner.mjs:28`).
- `dayOf(path)` = `/day-(\d+)/` → day number; relevance is by day number (`relevantDays`).
- Judge composite mirrors SP1: `composite = correctness(0–3) + completeness(0–2) + hallucination(0–1, 1=clean)`, range 0–6.

---

## File Structure

| File | Responsibility |
|---|---|
| `integrations/recall-bench/answerquality-lib.mjs` | **Create.** Pure, DB-free helpers: `mulberry32` seeded PRNG, `shuffleSeeded`, `stratifiedSample`, `pairedBootstrapCI`, `assembleContext`, `composite`, `answererPrompt`, `judgePrompt`, `JUDGE_SCHEMA`. |
| `integrations/recall-bench/answerquality-lib.test.mjs` | **Create.** Vitest unit tests for every pure helper. |
| `integrations/recall-bench/openrouter.mjs` | **Create.** Thin OpenRouter client: `chat({model,system,user,temperature,maxTokens})` and `chatJson(...)` with retry + token accounting. DB-free, network. |
| `integrations/recall-bench/answerquality-runner.mjs` | **Create.** Orchestration: open vault, sample, divergence pre-step gate, per-(q,arm,K) retrieve→assemble→answer→judge, write per-q + summary JSON, print gate verdict. |
| `docs/superpowers/results/2026-06-24-chunk-bm25-answer-quality.md` | **Create (Task 10).** Results note with verdict, per-stratum deltas + CIs, K-trend, cost, caveats, kill condition. |

Run unit tests with: `npx vitest run --root integrations/recall-bench answerquality-lib` (from repo root).

---

## Task 1: Seeded PRNG + scaffold lib

**Files:**
- Create: `integrations/recall-bench/answerquality-lib.mjs`
- Test: `integrations/recall-bench/answerquality-lib.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// answerquality-lib.test.mjs
import { describe, it, expect } from "vitest";
import { mulberry32, shuffleSeeded } from "./answerquality-lib.mjs";

describe("mulberry32", () => {
  it("is deterministic for a fixed seed", () => {
    const a = mulberry32(42); const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it("differs across seeds", () => {
    expect(mulberry32(1)()).not.toEqual(mulberry32(2)());
  });
  it("returns values in [0,1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 100; i++) { const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});

describe("shuffleSeeded", () => {
  it("is a deterministic permutation that preserves elements", () => {
    const xs = [1,2,3,4,5,6,7,8,9,10];
    const a = shuffleSeeded(xs, 99); const b = shuffleSeeded(xs, 99);
    expect(a).toEqual(b);
    expect([...a].sort((x,y)=>x-y)).toEqual(xs);
    expect(a).not.toEqual(xs); // overwhelmingly likely for n=10
  });
  it("does not mutate the input", () => {
    const xs = [1,2,3]; shuffleSeeded(xs, 1); expect(xs).toEqual([1,2,3]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root integrations/recall-bench answerquality-lib`
Expected: FAIL — cannot import `mulberry32` / module missing.

- [ ] **Step 3: Write minimal implementation**

```javascript
// answerquality-lib.mjs
// Pure, DB-free helpers for the chunk-BM25 answer-quality ablation.
// No imports from dist/ here — keep this unit-testable in isolation.

// Deterministic PRNG (mulberry32). Seeded so the whole experiment reproduces.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates with a seeded PRNG. Returns a new array; input untouched.
export function shuffleSeeded(arr, seed) {
  const out = [...arr];
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root integrations/recall-bench answerquality-lib`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add integrations/recall-bench/answerquality-lib.mjs integrations/recall-bench/answerquality-lib.test.mjs
git commit -m "test(recall-bench): seeded PRNG for answer-quality ablation"
```

---

## Task 2: Stratified sampler

Selects N=400 = 200 single-day + 200 multi-day, multi-day spread across the 2/3/4/5/6/7-relevant-day buckets with a per-bucket cap so the 698 seven-day questions don't dominate. Deterministic (seeded).

**Files:**
- Modify: `integrations/recall-bench/answerquality-lib.mjs`
- Test: `integrations/recall-bench/answerquality-lib.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { stratifiedSample } from "./answerquality-lib.mjs";

function mkRecs(n, relLen, idPrefix) {
  return Array.from({ length: n }, (_, i) => ({
    qa: { id: `${idPrefix}-${i}`, relevantDays: Array.from({ length: relLen }, (_, d) => d + 1) },
  }));
}

describe("stratifiedSample", () => {
  // pool: 30 single, then multi buckets sized like RB (2..7), 7-day over-represented
  const pool = [
    ...mkRecs(30, 1, "s"),
    ...mkRecs(8, 2, "b2"), ...mkRecs(8, 3, "b3"), ...mkRecs(8, 4, "b4"),
    ...mkRecs(8, 5, "b5"), ...mkRecs(8, 6, "b6"), ...mkRecs(60, 7, "b7"),
  ];

  it("returns the requested single/multi counts and tags strata", () => {
    const out = stratifiedSample(pool, { nSingle: 20, nMulti: 30, multiBucketCap: 6, seed: 1 });
    expect(out.filter((r) => r.stratum === "single")).toHaveLength(20);
    expect(out.filter((r) => r.stratum === "multi")).toHaveLength(30);
  });

  it("caps any single multi-day bucket at multiBucketCap (so 7-day can't dominate)", () => {
    const out = stratifiedSample(pool, { nSingle: 0, nMulti: 30, multiBucketCap: 6, seed: 1 });
    const byLen = {};
    for (const r of out) { const L = r.qa.relevantDays.length; byLen[L] = (byLen[L] || 0) + 1; }
    for (const L of Object.keys(byLen)) expect(byLen[L]).toBeLessThanOrEqual(6);
  });

  it("is deterministic for a fixed seed", () => {
    const a = stratifiedSample(pool, { nSingle: 20, nMulti: 30, multiBucketCap: 6, seed: 7 });
    const b = stratifiedSample(pool, { nSingle: 20, nMulti: 30, multiBucketCap: 6, seed: 7 });
    expect(a.map((r) => r.qa.id)).toEqual(b.map((r) => r.qa.id));
  });

  it("never returns duplicates", () => {
    const out = stratifiedSample(pool, { nSingle: 20, nMulti: 30, multiBucketCap: 6, seed: 3 });
    expect(new Set(out.map((r) => r.qa.id)).size).toBe(out.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --root integrations/recall-bench answerquality-lib`
Expected: FAIL — `stratifiedSample` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `answerquality-lib.mjs`)

```javascript
// Stratified deterministic sample.
// - single stratum: relevantDays.length === 1
// - multi stratum: grouped by relevantDays.length into buckets; round-robin
//   across buckets, each bucket capped at `multiBucketCap`, until nMulti filled.
// Returns records tagged with `stratum: "single" | "multi"`. Throws if the pool
// can't satisfy the requested counts (fail loud, don't silently under-sample).
export function stratifiedSample(records, { nSingle, nMulti, multiBucketCap, seed }) {
  const single = records.filter((r) => (r.qa.relevantDays?.length ?? 0) === 1);
  const multi = records.filter((r) => (r.qa.relevantDays?.length ?? 0) > 1);

  const pickedSingle = shuffleSeeded(single, seed).slice(0, nSingle);
  if (pickedSingle.length < nSingle)
    throw new Error(`single pool too small: have ${single.length}, need ${nSingle}`);

  // Bucket multi by relevantDays length, shuffle each bucket deterministically.
  const buckets = new Map();
  for (const r of multi) {
    const L = r.qa.relevantDays.length;
    if (!buckets.has(L)) buckets.set(L, []);
    buckets.get(L).push(r);
  }
  const lens = [...buckets.keys()].sort((a, b) => a - b);
  const queues = new Map(lens.map((L) => [L, shuffleSeeded(buckets.get(L), seed + L)]));
  const takenPerBucket = new Map(lens.map((L) => [L, 0]));

  const pickedMulti = [];
  let progressed = true;
  while (pickedMulti.length < nMulti && progressed) {
    progressed = false;
    for (const L of lens) {
      if (pickedMulti.length >= nMulti) break;
      if (takenPerBucket.get(L) >= multiBucketCap) continue;
      const q = queues.get(L);
      const idx = takenPerBucket.get(L);
      if (idx < q.length) {
        pickedMulti.push(q[idx]);
        takenPerBucket.set(L, idx + 1);
        progressed = true;
      }
    }
  }
  if (pickedMulti.length < nMulti)
    throw new Error(
      `multi pool too small under cap=${multiBucketCap}: got ${pickedMulti.length}, need ${nMulti}`,
    );

  return [
    ...pickedSingle.map((r) => ({ ...r, stratum: "single" })),
    ...pickedMulti.map((r) => ({ ...r, stratum: "multi" })),
  ];
}
```

> **Note for the full run:** 200 multi from the 2–6-day buckets (281 total) needs `multiBucketCap` high enough; with caps {2:61,3:53,4:46,5:82,6:39}=281 and 7-day=698, a cap of e.g. 40 yields ~200 from small buckets + some 7-day. Pin the exact cap in Task 8/10 after checking the real bucket sizes; the test only fixes the *mechanism*.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --root integrations/recall-bench answerquality-lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add integrations/recall-bench/answerquality-lib.mjs integrations/recall-bench/answerquality-lib.test.mjs
git commit -m "test(recall-bench): stratified single/multi-day sampler (bucket-capped)"
```

---

## Task 3: Paired bootstrap CI + composite

`pairedBootstrapCI(deltas, {iters, seed, alpha})` resamples the per-question paired deltas (chunk − document on the SAME question) and returns `{ mean, lo, hi }`. `composite(axes)` mirrors the SP1 sum.

**Files:**
- Modify: `integrations/recall-bench/answerquality-lib.mjs`
- Test: `integrations/recall-bench/answerquality-lib.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { pairedBootstrapCI, composite } from "./answerquality-lib.mjs";

describe("composite", () => {
  it("sums correctness + completeness + hallucination (SP1 rubric, max 6)", () => {
    expect(composite({ correctness: 3, completeness: 2, hallucination: 1 })).toBe(6);
    expect(composite({ correctness: 0, completeness: 0, hallucination: 0 })).toBe(0);
  });
});

describe("pairedBootstrapCI", () => {
  it("mean equals the arithmetic mean of deltas", () => {
    const { mean } = pairedBootstrapCI([1, 1, 1, 1], { iters: 200, seed: 1, alpha: 0.05 });
    expect(mean).toBeCloseTo(1, 6);
  });
  it("CI brackets the mean and is deterministic", () => {
    const d = [0.2, -0.1, 0.3, 0.0, 0.5, -0.2, 0.4, 0.1];
    const a = pairedBootstrapCI(d, { iters: 500, seed: 9, alpha: 0.05 });
    const b = pairedBootstrapCI(d, { iters: 500, seed: 9, alpha: 0.05 });
    expect(a).toEqual(b);
    expect(a.lo).toBeLessThanOrEqual(a.mean);
    expect(a.hi).toBeGreaterThanOrEqual(a.mean);
  });
  it("all-zero deltas give a zero-width CI at zero", () => {
    const { mean, lo, hi } = pairedBootstrapCI([0, 0, 0], { iters: 100, seed: 2, alpha: 0.05 });
    expect(mean).toBe(0); expect(lo).toBe(0); expect(hi).toBe(0);
  });
});
```

- [ ] **Step 2: Run** — FAIL (not exported).

- [ ] **Step 3: Implement** (append):

```javascript
export function composite({ correctness, completeness, hallucination }) {
  return correctness + completeness + hallucination;
}

// Percentile bootstrap over PAIRED per-question deltas (same question, both arms).
// Resample WITH replacement n times, take the mean each iter, return the
// alpha/2 and 1-alpha/2 percentiles. Seeded → reproducible.
export function pairedBootstrapCI(deltas, { iters = 2000, seed = 1, alpha = 0.05 }) {
  const n = deltas.length;
  const mean = n ? deltas.reduce((a, b) => a + b, 0) / n : 0;
  if (n === 0) return { mean: 0, lo: 0, hi: 0 };
  const rnd = mulberry32(seed);
  const means = new Array(iters);
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[Math.floor(rnd() * n)];
    means[it] = s / n;
  }
  means.sort((a, b) => a - b);
  const q = (p) => means[Math.min(iters - 1, Math.max(0, Math.floor(p * iters)))];
  return { mean, lo: q(alpha / 2), hi: q(1 - alpha / 2) };
}
```

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit**

```bash
git add integrations/recall-bench/answerquality-lib.mjs integrations/recall-bench/answerquality-lib.test.mjs
git commit -m "test(recall-bench): paired bootstrap CI + SP1 composite"
```

---

## Task 4: Context assembly + prompts

`assembleContext(rankedPaths, bestChunkByPath, docContentByPath, {fallbackChars})` builds the answerer context string from each top-K doc's best chunk (fallback: first `fallbackChars` of the doc body when no chunk matched — e.g. title-only matches). Also the answerer/judge prompts and the judge JSON schema.

**Files:**
- Modify: `integrations/recall-bench/answerquality-lib.mjs`
- Test: `integrations/recall-bench/answerquality-lib.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
import { assembleContext, answererPrompt, judgePrompt, JUDGE_SCHEMA } from "./answerquality-lib.mjs";

describe("assembleContext", () => {
  const best = new Map([["a.md", "best chunk A"], ["b.md", "best chunk B"]]);
  const full = new Map([["a.md", "FULL A ".repeat(500)], ["c.md", "FULL C body here"]]);

  it("uses best chunk per path, in ranked order, each prefixed with its path", () => {
    const ctx = assembleContext(["a.md", "b.md"], best, full, { fallbackChars: 1500 });
    expect(ctx.indexOf("a.md")).toBeLessThan(ctx.indexOf("b.md")); // ranked order preserved
    expect(ctx).toContain("best chunk A");
    expect(ctx).toContain("best chunk B");
  });

  it("falls back to first fallbackChars of body when no chunk matched", () => {
    const ctx = assembleContext(["c.md"], best, full, { fallbackChars: 8 });
    expect(ctx).toContain("c.md");
    expect(ctx).toContain("FULL C b"); // first 8 chars
  });

  it("reports total chars and per-doc source for cost/validity logging", () => {
    const { text, totalChars, sources } = assembleContext(["a.md", "c.md"], best, full, { fallbackChars: 8 }, { detailed: true });
    expect(typeof text).toBe("string");
    expect(totalChars).toBe(text.length);
    expect(sources).toEqual([{ path: "a.md", source: "chunk" }, { path: "c.md", source: "fallback" }]);
  });
});

describe("prompts", () => {
  it("answerer prompt embeds context + question and instructs context-only answering", () => {
    const p = answererPrompt("CTX", "Q?");
    expect(p).toContain("CTX"); expect(p).toContain("Q?");
    expect(p.toLowerCase()).toContain("only the");
  });
  it("judge prompt embeds question, reference, candidate; schema has the three axes", () => {
    const p = judgePrompt("Q?", "REF", "CAND");
    expect(p).toContain("Q?"); expect(p).toContain("REF"); expect(p).toContain("CAND");
    expect(JUDGE_SCHEMA.required).toEqual(expect.arrayContaining(["correctness", "completeness", "hallucination", "reasoning"]));
  });
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** (append):

```javascript
export function assembleContext(rankedPaths, bestChunkByPath, docContentByPath, { fallbackChars }, opts = {}) {
  const parts = [];
  const sources = [];
  for (const path of rankedPaths) {
    let body = bestChunkByPath.get(path);
    let source = "chunk";
    if (body == null) {
      body = (docContentByPath.get(path) ?? "").slice(0, fallbackChars);
      source = "fallback";
    }
    parts.push(`[source: ${path}]\n${body}`);
    sources.push({ path, source });
  }
  const text = parts.join("\n\n---\n\n");
  if (opts.detailed) return { text, totalChars: text.length, sources };
  return text;
}

export function answererPrompt(context, question) {
  return [
    "You are answering a question using ONLY the provided context excerpts.",
    "Rules:",
    "- Use only the context below. Do not use outside knowledge.",
    "- If the context does not contain the answer, say exactly: \"The provided context does not contain the answer.\"",
    "- Be concise. Cite the [source: …] path(s) you used.",
    "",
    "CONTEXT:",
    context,
    "",
    `QUESTION: ${question}`,
    "",
    "ANSWER:",
  ].join("\n");
}

export const JUDGE_SCHEMA = {
  type: "object",
  required: ["correctness", "completeness", "hallucination", "reasoning"],
  properties: {
    correctness: { type: "integer", minimum: 0, maximum: 3 },
    completeness: { type: "integer", minimum: 0, maximum: 2 },
    hallucination: { type: "integer", minimum: 0, maximum: 1 }, // 1 = no hallucination (clean)
    reasoning: { type: "string" },
  },
};

export function judgePrompt(question, referenceAnswer, candidateAnswer) {
  return [
    "You are grading a candidate answer against a reference answer. Grade blind and strictly.",
    "Scoring axes (integers):",
    "- correctness 0–3: does the candidate state the correct fact(s) from the reference? (3=fully correct, 0=wrong/absent)",
    "- completeness 0–2: does it cover what the reference covers? (2=complete, 0=missing the point)",
    "- hallucination 0–1: 1 if the candidate adds NO unsupported/contradictory claims; 0 if it fabricates.",
    "",
    `QUESTION: ${question}`,
    `REFERENCE ANSWER: ${referenceAnswer}`,
    `CANDIDATE ANSWER: ${candidateAnswer}`,
  ].join("\n");
}
```

- [ ] **Step 4: Run** — PASS.

- [ ] **Step 5: Commit**

```bash
git add integrations/recall-bench/answerquality-lib.mjs integrations/recall-bench/answerquality-lib.test.mjs
git commit -m "test(recall-bench): context assembly (best-chunk + fallback) and answerer/judge prompts"
```

---

## Task 5: OpenRouter client

Thin wrapper over the OpenAI-compatible Chat Completions endpoint with retry (429/5xx, exponential backoff — mirrors `src/eval/llm.ts:206`) and cumulative token accounting. Temperature pinned to 0 for both answerer and judge (reproducibility).

**Files:**
- Create: `integrations/recall-bench/openrouter.mjs`

> No unit test (pure network I/O); it's exercised by the smoke run (Task 9). Keep it tiny and obviously correct.

- [ ] **Step 1: Implement**

```javascript
// openrouter.mjs — minimal OpenAI-compatible client for OpenRouter.
const URL = "https://openrouter.ai/api/v1/chat/completions";
const MAX_RETRIES = 5, BASE = 500, CAP = 60_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createOpenRouter() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY env var is required");
  const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };

  async function raw({ model, system, user, temperature = 0, maxTokens = 1024, json = false }) {
    const body = {
      model,
      temperature,
      max_tokens: maxTokens,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: user },
      ],
      ...(json ? { response_format: { type: "json_object" } } : {}),
    };
    let lastErr;
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        const res = await fetch(URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.status === 429 || res.status >= 500) { lastErr = new Error(`HTTP ${res.status}`); }
        else if (!res.ok) { throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`); }
        else {
          const j = await res.json();
          usage.input_tokens += j.usage?.prompt_tokens ?? 0;
          usage.output_tokens += j.usage?.completion_tokens ?? 0;
          usage.calls += 1;
          return j.choices?.[0]?.message?.content ?? "";
        }
      } catch (e) { lastErr = e; }
      if (i < MAX_RETRIES - 1) await sleep(Math.min(BASE * 2 ** i, CAP));
    }
    throw lastErr ?? new Error("retries exhausted");
  }

  return {
    usage,
    chat: (opts) => raw(opts),
    chatJson: async (opts) => {
      const txt = await raw({ ...opts, json: true });
      const stripped = txt.replace(/^```(?:json)?\n?/, "").replace(/\n?```\s*$/, "");
      return JSON.parse(stripped);
    },
  };
}
```

- [ ] **Step 2: Smoke-check the client compiles + reaches OpenRouter** (1 cheap call)

Run:
```bash
node --input-type=module -e '
import { createOpenRouter } from "./integrations/recall-bench/openrouter.mjs";
const c = createOpenRouter();
const r = await c.chat({ model: "anthropic/claude-haiku-4.5", system: "", user: "Reply with the single word OK.", maxTokens: 5 });
console.log("reply:", JSON.stringify(r), "usage:", c.usage);
'
```
Expected: prints a reply containing `OK` and non-zero usage. (Costs ~$0.)

- [ ] **Step 3: Commit**

```bash
git add integrations/recall-bench/openrouter.mjs
git commit -m "feat(recall-bench): minimal OpenRouter chat/chatJson client with retry + token accounting"
```

---

## Task 6: Runner — vault open, sampling, divergence pre-step gate

The runner's first half: open the vault, load + sample questions, and run the **$0 lexical divergence pre-step**. If the arms don't diverge at K=5, abort BEFORE any paid call.

**Files:**
- Create: `integrations/recall-bench/answerquality-runner.mjs`

- [ ] **Step 1: Implement the head of the runner**

```javascript
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
// Full run: 200/200. Smoke: 12/13. multiBucketCap tuned to real bucket sizes.
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
```

- [ ] **Step 2: Run the head (pre-step only halts the run because the answer loop isn't written yet)**

Run: `node integrations/recall-bench/answerquality-runner.mjs --smoke`
Expected: prints vault docs, sample counts, a **positive** divergence (chunk recall@5 > document — consistent with the recall-run gapRecovered), and `pre-step gate PASS`. Then exits (no answer loop yet). If divergence ≤ 0.01, STOP and revisit K with the user before continuing.

- [ ] **Step 3: Commit**

```bash
git add integrations/recall-bench/answerquality-runner.mjs
git commit -m "feat(recall-bench): answer-quality runner head — sample + \$0 divergence pre-step gate"
```

---

## Task 7: Runner — answer/judge loop + per-question output

Append the paid loop: for each sampled question, for each arm, for each K — retrieve, assemble best-chunk context, answer (Haiku), judge (gpt-5.4-mini, blind), record.

**Files:**
- Modify: `integrations/recall-bench/answerquality-runner.mjs`

- [ ] **Step 1: Append the loop**

```javascript
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
```

- [ ] **Step 2: Do NOT run full yet** — the smoke run is Task 9. Just verify it parses:

Run: `node --check integrations/recall-bench/answerquality-runner.mjs`
Expected: no output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add integrations/recall-bench/answerquality-runner.mjs
git commit -m "feat(recall-bench): answer+judge loop, per-question JSON with usage/context logging"
```

---

## Task 8: Runner — aggregation, gate verdict, summary

Append the aggregation: per (stratum, K) mean composite per arm, paired delta + paired bootstrap CI, hallucination rate, mean context chars; then the non-regression gate verdict.

**Files:**
- Modify: `integrations/recall-bench/answerquality-runner.mjs`

- [ ] **Step 1: Append aggregation**

```javascript
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
```

- [ ] **Step 2: Verify it parses**

Run: `node --check integrations/recall-bench/answerquality-runner.mjs`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add integrations/recall-bench/answerquality-runner.mjs
git commit -m "feat(recall-bench): per-stratum/K aggregation, paired-CI, non-regression gate verdict"
```

---

## Task 9: Smoke run (integration gate)

Validate the whole pipeline end-to-end on N=25 and confirm real per-call token spend before the full run.

- [ ] **Step 1: Run smoke**

Run: `node integrations/recall-bench/answerquality-runner.mjs --smoke 2>&1 | tee /tmp/cov-recall/answerquality-smoke.log`
Expected:
- vault docs printed; sample = 25 (12 single / 13 multi);
- divergence positive, `pre-step gate PASS`;
- progress lines with rising `usage`;
- final summary JSON with `byStratumK` populated and a `gate.verdict`.

- [ ] **Step 2: Sanity-check the smoke output** (don't trust, verify)

```bash
jq '{usage, counts: .counts, gate: .gate,
     ctx: {docChars: .byStratumK["multi@5"].documentCtxChars, chunkChars: .byStratumK["multi@5"].chunkCtxChars}}' \
  /tmp/cov-recall/answerquality-summary.json
```
Check: (a) `chunkCtxChars` is bounded (~K×1–2k, NOT ~K×26k — confirms best-chunk feeding, not full docs); (b) composites are plausible (document arm not 0 everywhere — if it is, the answerer/judge or context is broken, investigate before scaling); (c) extrapolate cost: `usage` × (400/25) × pricing should be well under $10. If chunkCtxChars looks like full-doc size, the `bestChunkByPath` fallback is firing too often — investigate before the full run.

- [ ] **Step 3: Commit the smoke artifacts**

```bash
git add -f /tmp/cov-recall/answerquality-smoke.log 2>/dev/null || true
git commit -am "chore(recall-bench): answer-quality smoke run validated (N=25)" || echo "nothing to commit"
```
> (The `/tmp` artifacts are ephemeral; committing the log is optional. The point is the gate checkpoint.)

- [ ] **Step 4: Checkpoint with the human** — report smoke gate verdict, bounded context confirmation, and extrapolated full-run cost. Get a go/no-go before spending on the full run.

---

## Task 10: Full run + results note

- [ ] **Step 1: Tune `MULTI_BUCKET_CAP` to the real pool** — confirm the 2–6-day bucket sizes can yield 200 multi:

```bash
jq -c '.qa.relevantDays | length' integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl | sort | uniq -c
```
Pick `MULTI_BUCKET_CAP` so round-robin fills 200 without over-weighting 7-day (e.g. cap ~45 draws from small buckets first, tops up from 7-day). Adjust the constant in the runner if needed; re-run `node --check`.

- [ ] **Step 2: Run full**

Run: `node integrations/recall-bench/answerquality-runner.mjs 2>&1 | tee /tmp/cov-recall/answerquality-full.log`
Expected: 400 questions, gate verdict, `usage` logged. Watch the first progress line's usage to confirm cost trajectory; Ctrl-C if usage is wildly above the smoke extrapolation.

- [ ] **Step 3: Verify the result, then write the note**

Write `docs/superpowers/results/2026-06-24-chunk-bm25-answer-quality.md` with:
- the measured commit hash (`git rev-parse HEAD`);
- the **gate verdict** (PASS/FAIL) and the per-(stratum, K) table: document vs chunk composite, paired delta + 95% CI;
- the **K-trend** (delta@5 vs delta@10) and whether it shrinks as predicted (internal-validity check);
- hallucination rates per arm; mean context chars per arm (the efficiency readout);
- **actual** token spend × verified OpenRouter pricing → real $ cost;
- the **Haiku-directional caveat** and the **kill condition** outcome (did single-day regress?);
- what it means for the default-flip (3rd gate status) and the recommended next step (flip / Option B confirmation / hold).
- Cross-link `[[project_recall_bench_experiment]]` and the spec.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/results/2026-06-24-chunk-bm25-answer-quality.md
git commit -m "docs(recall-bench): answer-quality ablation results — gate <PASS|FAIL>, default-flip 3rd gate"
```

- [ ] **Step 5: Update memory** — refresh the `project_recall_bench_experiment` banner with the answer-quality gate outcome and the resulting default-flip decision (per the memory protocol in the system prompt).

---

## Validity guardrails (baked into the tasks)

- **Lexical purity:** `retrieve()` asserts `vectorUsed===false` and that it never flips (Task 6).
- **Headroom:** the $0 divergence pre-step gate aborts before any paid call if arms don't diverge at K=5 (Task 6).
- **Bounded context / cost:** best-chunk feeding (Task 4) + smoke cost extrapolation gate (Task 9) — the dominant $80→$7 lever.
- **Paired analysis:** bootstrap resamples per-question paired deltas, not arms independently (Task 3/8).
- **Judge independence:** judge family (`openai/gpt-5.4-mini`) ≠ answerer family (`anthropic/claude-haiku-4.5`); judge is blind to arm (never sees `arm`).
- **Determinism:** single fixed `SEED` drives sampler + bootstrap; temperature 0 on answerer + judge.
- **Honest failure:** judge-parse failures score 0 with a recorded reason (Task 7), not silently dropped.
