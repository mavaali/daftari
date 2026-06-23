# Coverage Recall Measurement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, on Recall Bench, whether the shipped coverage pass's date-window mechanism retrieves more of the true relevant days than plain ranking (a free `$0` recall sweep), and — only if it does — whether that cuts hallucination toward the oracle ceiling (a gated, cost-bounded LLM arm).

**Architecture:** Three Node ESM scripts under `integrations/recall-bench/`, importing the *built* daftari retrieval functions from `dist/`. `prep-vault.mjs` turns the 180 tag-less RB day-files into an indexable daftari vault (uniform tag + injected `created` so the shipped coverage code fires as pure date-window gathering). `recall-runner.mjs` retrieves once per question and computes two recall curves over `maxAdd` (coverage-selection vs rank-extension) — deterministic, no LLM. `llm-arm.mjs` (gated) reuses the existing oracle-harness machinery to score hallucination on multi-day questions. Output is a written results doc.

**Tech Stack:** Node ESM (`.mjs`), better-sqlite3 (via daftari `dist/`), OpenRouter (LLM arm, via `integrations/recall-bench/.env`). These are one-off experiment scripts, not the typed `src/` codebase — verification is via runtime assertions + `--smoke` runs, not vitest.

---

## Preconditions (verify before Task 1)

- `npm run build` is current (scripts import from `dist/`).
- RB corpus present: `/tmp/recall-review/packages/recall-bench/personas/executive-assistant/memories-180d/day-0001.md` … `day-0180.md`. If absent, re-clone `Stevenic/recall` (MIT) and point `CORPUS` at `packages/recall-bench/personas/executive-assistant/memories-180d`.
- Questions present: `integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`.
- Spec: `docs/superpowers/specs/2026-06-22-coverage-recall-measurement-design.md` (read it; this plan implements it).

## File structure

- **Create** `integrations/recall-bench/prep-vault.mjs` — corpus → daftari vault + reindex + invariant assertions. One responsibility: produce an indexed scratch vault.
- **Create** `integrations/recall-bench/recall-runner.mjs` — retrieval + `maxAdd` sweep → recall curves + per-question retrieval dump. The free arm.
- **Create** `integrations/recall-bench/llm-arm.mjs` — reads the per-question retrieval dump, runs the oracle answerer+judge on multi-day questions. The gated arm.
- **Create** `docs/superpowers/results/2026-06-22-coverage-recall-measurement.md` — the findings (Task 4).
- Scratch vault + JSON outputs live under `/tmp/cov-recall/` (gitignored scratch; not committed).

Constants shared by the scripts (define at the top of each):
```js
const ROOT = "/Users/mihirwagle/projects/daftari";
const CORPUS = "/tmp/recall-review/packages/recall-bench/personas/executive-assistant/memories-180d";
const QFILE = `${ROOT}/integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`;
const VAULT = "/tmp/cov-recall/vault";
const OUT = "/tmp/cov-recall";
const BASE_DATE = "2026-01-01"; // day-0001
const LIMIT = 10;               // Stage-1 default
const SHIPPED_MAXADD = 5;       // DEFAULT_COVERAGE_OPTIONS.maxAdd
```

---

## Task 1: Corpus prep → indexed daftari vault

**Files:** Create `integrations/recall-bench/prep-vault.mjs`

- [ ] **Step 1: Write the prep script**

```js
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/mihirwagle/projects/daftari";
const CORPUS = "/tmp/recall-review/packages/recall-bench/personas/executive-assistant/memories-180d";
const VAULT = "/tmp/cov-recall/vault";
const BASE_DATE = "2026-01-01";

if (!existsSync(CORPUS)) { console.error(`CORPUS missing: ${CORPUS}\nRe-clone Stevenic/recall.`); process.exit(1); }

// day-N -> BASE_DATE + (N-1) days, UTC, YYYY-MM-DD
function dayDate(n) {
  const d = new Date(`${BASE_DATE}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (n - 1));
  return d.toISOString().slice(0, 10);
}
// strip a leading `--- ... ---` frontmatter block, return the body verbatim
function stripFrontmatter(text) {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

const files = readdirSync(CORPUS).filter((f) => /^day-\d+\.md$/.test(f)).sort();
const nums = files.map((f) => Number(/day-(\d+)/.exec(f)[1])).sort((a, b) => a - b);

// Invariant assertions (the date-window depends on monotonic, contiguous, one-per-day):
if (files.length !== 180) throw new Error(`expected 180 day-files, got ${files.length}`);
for (let i = 0; i < nums.length; i++) {
  if (nums[i] !== i + 1) throw new Error(`non-contiguous day numbering at index ${i}: got ${nums[i]}`);
}
// Spot-check ONLY the base offset (NOT per-file in-body dates — body dates are often topic prose):
const day1 = readFileSync(join(CORPUS, "day-0001.md"), "utf8");
if (!day1.includes(BASE_DATE)) console.warn(`warning: day-0001 body does not mention ${BASE_DATE}; confirm BASE_DATE`);

rmSync(VAULT, { recursive: true, force: true });
mkdirSync(join(VAULT, "notes"), { recursive: true });

for (const n of nums) {
  const created = dayDate(n);
  const body = stripFrontmatter(readFileSync(join(CORPUS, `day-${String(n).padStart(4, "0")}.md`), "utf8"));
  // Inert, question-orthogonal title (NOT the first prose header — that would enter FTS and perturb ranking).
  const fm =
    `---\n` +
    `title: daily log ${created}\n` +
    `domain: accumulation\n` +
    `collection: notes\n` +
    `status: canonical\n` +
    `confidence: high\n` +
    `created: ${created}\n` +
    `updated: ${created}\n` +
    `updated_by: agent:prep\n` +
    `provenance: direct\n` +
    `tags: [daily]\n` +
    `---\n\n`;
  writeFileSync(join(VAULT, "notes", `day-${String(n).padStart(4, "0")}.md`), fm + body);
}
console.log(`prep: wrote 180 docs to ${VAULT}/notes (dates ${dayDate(1)} .. ${dayDate(180)})`);

// Reindex via the built daftari pipeline.
const { reindexVault } = await import(`${ROOT}/dist/search/reindex.js`);
const r = await reindexVault(VAULT);
if (!r.ok) { console.error("reindex failed:", r.error.message); process.exit(1); }
console.log(`prep: indexed ${r.value.documentCount} docs`);
if (r.value.documentCount !== 180) throw new Error(`indexed ${r.value.documentCount}, expected 180`);
```

- [ ] **Step 2: Build daftari, then run the prep**

Run: `npm run build && node integrations/recall-bench/prep-vault.mjs`
Expected: prints `wrote 180 docs`, `indexed 180 docs`; no assertion throws. (Reindex embeds 180 docs via local MiniLM — takes a few seconds.)

- [ ] **Step 3: Verify the prepped vault**

Run: `node -e "import('/Users/mihirwagle/projects/daftari/dist/storage/index-db.js').then(async m=>{const {getProvider}=await import('/Users/mihirwagle/projects/daftari/dist/search/vector.js');const o=m.openIndexDb('/tmp/cov-recall/vault',getProvider().dim);const d=m.getAllDocuments(o.value);console.log('docs',d.length,'sample',d[0].created,JSON.stringify(d[0].tags),d[0].title);console.log('createdSorted', d.map(x=>x.created).every((c,i,a)=>i===0||a[i-1]<=c));})"`
Expected: `docs 180`, sample `created` = an ISO date, tags `["daily"]`, title `daily log <date>`, `createdSorted true`.

- [ ] **Step 4: Commit**

```bash
git add integrations/recall-bench/prep-vault.mjs
git commit -m "feat(recall-bench): prep RB corpus into an indexable daftari vault (coverage stage 3)"
```

---

## Task 2: Recall sweep (the free arm)

**Files:** Create `integrations/recall-bench/recall-runner.mjs`

This is the load-bearing arm. It retrieves once per question at a generous limit, builds the full uncapped coverage-candidate list via the real `applyCoveragePass` (maxAdd=∞), and computes both recall curves by slicing — which the spec's review verified is byte-identical to calling the feature at each `maxAdd`.

- [ ] **Step 1: Write the runner**

```js
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const ROOT = "/Users/mihirwagle/projects/daftari";
const QFILE = `${ROOT}/integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`;
const VAULT = "/tmp/cov-recall/vault";
const OUT = "/tmp/cov-recall";
const LIMIT = 10;
const SHIPPED_MAXADD = 5;
const GEN_LIMIT = 180;       // whole vault — bounded; lets us read top-(LIMIT+m) for any m
const SMOKE = process.argv.includes("--smoke");

const { hybridSearch } = await import(`${ROOT}/dist/search/hybrid.js`);
const { applyCoveragePass, DEFAULT_COVERAGE_OPTIONS } = await import(`${ROOT}/dist/search/coverage.js`);
const { openIndexForActiveProvider } = await import(`${ROOT}/dist/tools/search.js`);

const db = openIndexForActiveProvider(VAULT);
if (!db.ok) { console.error("open index failed:", db.error.message); process.exit(1); }
const DB = db.value;

const dayOf = (p) => { const m = /day-(\d+)/.exec(p || ""); return m ? Number(m[1]) : null; };
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
  if (!res.ok) { console.error("search failed:", res.error.message); continue; }
  // Vector-half parity: must be identical across every retrieval.
  if (vectorUsed === null) vectorUsed = res.value.vectorUsed;
  else if (vectorUsed !== res.value.vectorUsed) throw new Error(`vectorUsed flipped (${vectorUsed} -> ${res.value.vectorUsed}); pin the provider`);

  const ranked = res.value.hits;
  const seeds = ranked.slice(0, LIMIT);
  const widened = applyCoveragePass(DB, seeds, { ...DEFAULT_COVERAGE_OPTIONS, maxAdd: 1e9 });
  const added = widened.filter((h) => h.viaCoverage); // full ordered candidate list (created-DESC), uncapped
  const seedDays = daysOf(seeds);

  // Faithfulness assert (once): slicing the precomputed list == the real feature at maxAdd=5.
  if (!faithChecked) {
    const real5 = applyCoveragePass(DB, seeds, { ...DEFAULT_COVERAGE_OPTIONS, maxAdd: SHIPPED_MAXADD })
      .filter((h) => h.viaCoverage).map((h) => h.path);
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
    const addedRelevant = added.slice(0, m).map((h) => dayOf(h.path)).filter((d) => rel.includes(d)).length;
    curve.push({ m, covRecall: recall(covDays, rel), rxRecall: recall(rankExtDays, rel), addedRelevant, covRealized: covDays.length });
  }
  perQ.push({ id: r.qa.id, relLen: rel.length, rel, seedDays, addedDays: daysOf(added), curve });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/recall-perq.json`, JSON.stringify({ vectorUsed, smoke: SMOKE, perQ }, null, 2));
console.log(`recall-runner: ${perQ.length} questions, vectorUsed=${vectorUsed}, faithfulness=OK -> ${OUT}/recall-perq.json`);
```

- [ ] **Step 2: Smoke-run and sanity-check**

Run: `node integrations/recall-bench/recall-runner.mjs --smoke`
Expected: prints `25 questions, vectorUsed=true, faithfulness=OK`. If `faithfulness FAIL` throws, STOP — the sweep diverged from the real feature; do not proceed. If `vectorUsed=false`, the embedding model didn't load — fix the provider before trusting any ranking.

- [ ] **Step 3: Write the aggregator (append to the same script, after the perQ loop)**

```js
// --- aggregate: curves split by single vs multi-day, conditioned on relevantDays length ---
function curveAt(qset, key) {
  // mean over questions of recall at each m, padding short curves with their last value (uncapped plateau)
  const maxM = Math.max(...qset.map((p) => p.curve.length - 1), 0);
  const out = [];
  for (let m = 0; m <= maxM; m++) {
    const vals = qset.map((p) => (p.curve[Math.min(m, p.curve.length - 1)] || {})[key]).filter((x) => x != null);
    out.push(vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : null);
  }
  return out;
}
const multi = perQ.filter((p) => p.relLen > 1);
const single = perQ.filter((p) => p.relLen === 1);
const atShipped = (qset, key) => +(qset.map((p) => (p.curve[Math.min(SHIPPED_MAXADD, p.curve.length - 1)] || {})[key])
  .filter((x) => x != null).reduce((a, b, _, arr) => a + b / arr.length, 0)).toFixed(4);

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
```

- [ ] **Step 4: Full run (free, no LLM)**

Run: `node integrations/recall-bench/recall-runner.mjs`
Expected: a `recall-summary.json` with multi-day `covRecallCurve` vs `rankExtRecallCurve`, the `atShipped5` point, the `uncappedEnd`, and `multiDayLengthDistribution` (confirm the ~length-7 mode the spec predicts). Eyeball: is the coverage curve above rank-extension at the uncapped end?

- [ ] **Step 5: Commit**

```bash
git add integrations/recall-bench/recall-runner.mjs
git commit -m "feat(recall-bench): maxAdd-sweep recall curves, coverage vs rank-extension (coverage stage 3)"
```

---

## Task 3: Gated LLM arm (run ONLY if the recall gate passes)

**Gate (from the spec §5):** proceed only if the multi-day `covRecallCurve` sits ≥ ~5pp above `rankExtRecallCurve` at/near the uncapped end. If it does not, **skip this task** — write the negative result in Task 4 and stop. Record the gate decision explicitly.

**Files:** Create `integrations/recall-bench/llm-arm.mjs` (adapts `/tmp/oracle-recall.mjs` — copy its `call`/`docsBlock`/`pool`/`parseScore`/`GROUNDED_JUDGE`/`ANSWERER_SYS` verbatim; they already do exactly the answerer+judge+concurrency work).

**CRITICAL override — do NOT inherit `MAX_DOCS=8` from the oracle harness.** `docsBlock(days)` truncates to the first `MAX_DOCS` days. The coverage-ON context is `[...seedDays, ...added]`, so an 8-doc cap drops the **coverage-added days first — the exact thing being measured** — and would understate the coverage effect. Set `const MAX_DOCS = 40;` (comfortably exceeds the largest coverage-ON set: `LIMIT`=10 seed days + the full window) so **neither arm truncates**. Consequence: absolute hallucination rates won't equal the historical "~18.2%" anchor (which used 8 docs) — that's fine, the anchor is only a sanity reference; **the coverage-OFF vs coverage-ON delta from this same harness is the measurement**. Log `onDays.length`/`offDays.length` so any truncation is visible.

- [ ] **Step 1: Write the LLM arm**

It reuses the oracle machinery, but the two arms are **coverage-OFF days** (top-`LIMIT` seed days) vs **coverage-ON days** (seed days + `added.slice(0, m)`), for **multi-day questions only**. Read the day-sets from `recall-perq.json` so retrieval isn't recomputed.

```js
import { readFileSync } from "node:fs";
// ---- paste from /tmp/oracle-recall.mjs verbatim: CORPUS, BASE/KEY env, ANSWERER, JUDGE, DOC_CAP, MAX_DOCS, CONC,
//      GROUNDED_JUDGE, ANSWERER_SYS, dayFile, readDay, clip, docsBlock, call, parseScore, pool ----

const PERQ = "/tmp/cov-recall/recall-perq.json";
const QFILE = "/Users/mihirwagle/projects/daftari/integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl";
const SMOKE = process.argv.includes("--smoke");
const M = Number((process.argv.find((a) => a.startsWith("--m=")) || "--m=5").slice(4)); // which coverage point to test

const qmeta = new Map(readFileSync(QFILE, "utf8").split("\n").filter(Boolean).map(JSON.parse).map((r) => [r.qa.id, r.qa]));
const perQ = JSON.parse(readFileSync(PERQ, "utf8")).perQ.filter((p) => p.relLen > 1); // multi-day only
const cases = (SMOKE ? perQ.slice(0, 4) : perQ).map((p) => {
  const qa = qmeta.get(p.id);
  const offDays = p.seedDays;
  const onDays = [...new Set([...p.seedDays, ...p.addedDays.slice(0, M)])];
  return { id: p.id, q: qa.question, ref: qa.referenceAnswer, rel: p.rel, offDays, onDays };
});

const maxOn = Math.max(...cases.map((c) => c.onDays.length), 0);
const maxOff = Math.max(...cases.map((c) => c.offDays.length), 0);
console.log(`llm-arm: multi-day=${perQ.length} testing=${cases.length} coveragePoint m=${M} smoke=${SMOKE}`);
console.log(`context sizes: maxOff=${maxOff} maxOn=${maxOn} (MAX_DOCS=${MAX_DOCS}) — both must be <= MAX_DOCS or the measured days get truncated`);
if (maxOn > MAX_DOCS) throw new Error(`onDays (${maxOn}) exceeds MAX_DOCS (${MAX_DOCS}) — raise MAX_DOCS, coverage days would be truncated`);
console.log(`COST NOTE: ${cases.length} questions x 2 arms x 2 calls (answer+judge). Ctrl-C now to abort.`);

async function runArm(q, ref, rel, days) {
  const docs = docsBlock(days);
  if (!docs) return null;
  const sys = await call(ANSWERER, ANSWERER_SYS, `MEMORY DOCUMENTS:\n${docs}\n\nQUESTION:\n${q}`, 600, 0.2);
  if (!sys) return null;
  const mem = docsBlock(rel);
  const j = await call(JUDGE, GROUNDED_JUDGE,
    `MEMORY CONTEXT (ground truth):\n${mem}\n\nQUESTION:\n${q}\n\nREFERENCE ANSWER:\n${ref}\n\nSYSTEM ANSWER:\n${sys}\n\nOutput the JSON score now.`, 400, 0);
  return parseScore(j);
}
const rate = (arr) => { const v = arr.filter((x) => x && x.sc); const h = v.filter((x) => x.sc.h === 0).length; return { n: v.length, halluc: h, rate: +(h / v.length).toFixed(3) }; };

const OFF = await pool(cases, async (c) => ({ c, sc: await runArm(c.q, c.ref, c.rel, c.offDays) }));
const ON = await pool(cases, async (c) => ({ c, sc: await runArm(c.q, c.ref, c.rel, c.onDays) }));
console.log(`\ncoverage-OFF (top-${10}):      ${JSON.stringify(rate(OFF))}`);
console.log(`coverage-ON  (m=${M}):          ${JSON.stringify(rate(ON))}`);
```

(Note `parseScore` returns `{h,c}` per the oracle harness; `sc.h===0` = hallucinated.)

- [ ] **Step 2: Smoke the LLM arm (a handful, both points)**

Run: `source integrations/recall-bench/.env && node integrations/recall-bench/llm-arm.mjs --smoke --m=5`
Expected: prints the pool sizes + two rates without API errors. (If the curve showed `m=5` is cap-starved, also smoke `--m=<uncapped>` per the spec.)

- [ ] **Step 3: Full gated run**

Run: `source integrations/recall-bench/.env && node integrations/recall-bench/llm-arm.mjs --m=5` (and `--m=<uncapped>` only if `m=5` was cap-starved).
Expected: coverage-OFF vs coverage-ON hallucination rates on the multi-day set. Compare against the prior anchors (multi-day baseline ~18.2%, oracle ceiling ~1.3%).

- [ ] **Step 4: Commit**

```bash
git add integrations/recall-bench/llm-arm.mjs
git commit -m "feat(recall-bench): gated LLM hallucination arm, coverage off vs on (coverage stage 3)"
```

---

## Task 4: Results doc (Experiment-and-Publish)

**Files:** Create `docs/superpowers/results/2026-06-22-coverage-recall-measurement.md`

- [ ] **Step 1: Write the findings**

Include, per the spec §6:
- The multi-day recall table: `covRecall` vs `rankExtRecall` at the as-shipped `m=5` point AND the uncapped end, plus the `multiDayLengthDistribution` (does the length-7 mode hold?).
- The recall-curve shape note (recency-skew visible?) and the added-doc relevant-vs-distractor split.
- The **gate decision** (proceed / kill) with the numbers behind it.
- If the LLM arm ran: coverage-OFF vs coverage-ON hallucination, and an explicit **verdict** — win / backfire / null — against the kill condition, with the backfire **disambiguation** (cap story vs suppression story) using the uncapped-end recall + added-doc split.
- An "Honest Assessment" section: what this does and does NOT show (date-window half only; multi-day only; RB has no SP-A suppression; the LLM arm raised the doc cap to 40 so absolute rates aren't comparable to the historical 8-doc ~18.2% anchor — only the OFF-vs-ON delta is), and the kill condition's status.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/results/2026-06-22-coverage-recall-measurement.md
git commit -m "docs(recall-bench): coverage recall measurement results (coverage stage 3)"
```

---

## Out of scope (per spec)
- The discriminating-tag half of coverage (needs a native labeled vault) — deferred.
- `CoverageOptions` tuning beyond reporting the `maxAdd` sweep — a follow-up only if results warrant.
- Stage 2 edge expansion.
