# SP1 — Daftari ↔ Recall Bench Adapter + Baseline Arm (Design)

**Date:** 2026-06-20
**Status:** Design — pending spec review + user approval, then writing-plans
**Author:** brainstorming session (Claude + Mihir)

---

## Context

[Recall Bench](https://github.com/Stevenic/recall) (Steven Ickman, Microsoft; MIT)
is an external longitudinal agent-memory benchmark: it ingests up to ~1000 days
of synthetic persona "dailies" (with overlapping narrative arcs that revise facts
over time) and scores how well a memory system answers Q&A about that history.
Scoring is a 0–6 composite (correctness 0–3 + completeness 0–2 + hallucination
0–1) by an LLM judge, with an appellate judge re-scoring failures, tracked across
day-checkpoints to expose recall degradation as the corpus grows.

Its cross-system postmortem found that **sophisticated synthesis/"wiki" memory
layers underperform plain source retrieval** — the lossy aggregate layer outranks
the precise daily that holds the answer, producing confident fabrication. THUIR's
MemoryBench independently reached the same conclusion.

This cuts *for* daftari's architecture: daftari deliberately does **not** synthesize
content (raw markdown is the source of truth; the cortex loop emits `derives_from`
edges, not prose pages; query tools call no LLM — the consuming agent synthesizes).
But it also exposed a real gap in daftari: Recall Bench's failures are fundamentally
**ranking** failures, ranking is daftari's job, and daftari has already computed
decisive signals (`derives_from` edges, `superseded_by`) that **`src/search/hybrid.ts`
does not consume** — it scores on pure BM25 + vector, and supersession is carried as
annotation, never as a ranking signal.

The full programme tests whether wiring those signals into ranking moves the number
on an external benchmark. This document specifies **only SP1** of that programme.

## The full programme (context; SP2–SP4 deferred)

A three-arm ablation, decomposed into sequential sub-projects, each with its own
spec → plan → implementation:

- **SP1 (this doc)** — Daftari ↔ Recall Bench adapter + **Baseline arm** (daftari
  as-is). Foundation for all arms; produces daftari's current numbers and failure
  modes on Recall Bench.
- **SP2** — Supersession-aware ranking in `hybrid.ts` + **Oracle arm** (supersession
  edges injected from the benchmark's ground-truth correction arcs / `irrelevantAfter`
  cutoffs). Answers: *given* supersession knowledge, does ranking on it help?
- **SP3** — Auto-detection of supersession during consolidation + **Realistic arm**.
  Answers: can daftari *acquire* supersession unaided, and how far below the oracle
  upper bound does it land?
- **SP4** — Cross-arm synthesis + the §6.1 writeup.

## Fidelity constraints (binding on SP2 + SP3)

The programme touches ranking, which raises a principle question: does wiring
supersession into retrieval violate daftari's "raw is source of truth / curation
is advisory / agent decides / trust is earned" model? SP1 does not touch ranking
and is principle-safe. SP2 and SP3 do, and are bound by the following constraints
so the work *resolves* a latent infidelity rather than introducing one.

Latent infidelity being resolved: daftari already **asserts** supersession in
`superseded_by` metadata but **ignores it** in `hybrid.ts` ranking. The index
therefore contradicts the provenance the source of truth declares. Honoring that
metadata in ranking makes the index serve the file-truth; it does not override the
agent.

1. **Never hide history.** Superseded docs remain retrievable and keep their
   `superseded_by` annotation. The intervention is a **soft re-rank (downweight)**,
   never a hard exclude/filter. The agent still sees every revision and still
   decides. (Also required by the benchmark: `decision-tracking` and
   `recency-bias-resistance` need history retrievable; a hard filter would fail
   them.)
2. **Edge-based, not recency-based.** The ranking signal is the specific
   `superseded_by` relationship, not a generic "newer = better" recency boost — a
   recency heuristic would itself fail `recency-bias-resistance`. (This is why the
   programme rejected the recency-proxy option.)
3. **Earned confidence (SP3).** Auto-detected supersession edges must enter as
   candidates (k=0 birth) and earn confidence through the existing observe/contest
   re-derivation machinery — "surface, don't silently decrement." Ranking weights
   by *earned* edge strength. Nothing is asserted as authoritative on detection
   alone; shortcutting this breaks daftari's trust model even if the ranking math
   is sound.
4. **Determinism preserved.** Ranking remains deterministic given vault state
   (consistent with the fixed-seed reproducibility daftari already values).
5. **Query-conditioned downweight.** The current-state preference applies only when
   the question asks for the present state; as-of/historical questions and
   `decision-tracking` must still rank the relevant superseded revision high. An
   unconditional "superseded ⇒ downweight" would regress those categories and is
   itself a mild infidelity — the index burying a doc the agent explicitly asked for
   by date. The benchmark supplies the conditioning signal (`irrelevantAfter`,
   question phrasing).

A ranking change that obeys 1–5 is consistent with — arguably more faithful to —
daftari's principles than the current state. A change that hard-excludes superseded
docs, treats detected supersession as authoritative without earning, or downweights
superseded docs unconditionally regardless of query intent, is out of bounds.

## SP1 Goal

A daftari adapter implementing Recall Bench's `MemorySystemAdapter`, plus a baseline
run on the EA-180d persona, producing daftari's *as-is* recall numbers, degradation
curve, and per-category failure analysis (especially `contradiction-resolution` —
does daftari return stale revisions?).

## Non-goals (SP1)

- No ranking change (`hybrid.ts` untouched) — SP2.
- No oracle supersession edges — SP2.
- No supersession auto-detection — SP3.
- No §6.1 writeup — SP4.
- No `group-session-attribution` / `information-boundary` categories (daftari RBAC
  could later claim these; `groupsEnabled: false`).

## Key decision: daftari-as-is (native stack)

The adapter runs daftari's **native** stack:

- **Answerer model: Claude** (daftari's `src/eval/llm.ts`, Anthropic). No new client.
- **Embeddings: native local MiniLM.** Free, no API, the real daftari retrieval path.
- **Adapter drive mode: in-process agent-loop** reusing daftari's existing `src/eval`
  answerer (LLM drives `vault_search`/`vault_read` as tools), matching Recall Bench's
  `answerMode: agent`.

### Consequence (stated limitation)

The published OpenClaw/Recall/MemPalace runs synthesized with `gpt-5.4-mini` and used
`text-embedding-3-small`. Running daftari with Claude + MiniLM means **cross-system
absolute comparison is confounded** by answerer model and embedding model. Therefore:

- **Clean, defensible claims:** (1) the within-daftari ablation across SP1–SP3
  (baseline vs oracle vs realistic, all native/native — the only variable is the
  ranking/acquisition change); (2) daftari's degradation curve and failure-mode
  analysis (does it return stale revisions, and why).
- **Directional context only:** absolute score vs the published numbers.

This is acceptable because the ablation — not the cross-system leaderboard — was
always the contribution. A later sensitivity run (gpt-5.4-mini answerer + OpenAI
embeddings) could de-confound cross-system comparison if needed; out of scope here.

## Architecture (Approach A: in-process agent-loop)

Adapter lives in the daftari repo at `integrations/recall-bench/` so it can import
daftari internals as a workspace package, built to `dist/index.js`, exporting
`createDaftariAdapter`. A Recall Bench profile `ea-180d-daftari.yaml` sets
`harness.adapter` → that dist and `harness.factory: createDaftariAdapter`.

### Modules (small, single-purpose, independently testable)

- **`corpus-map.ts`** — pure function `(day, content, DayMetadata) → DaftariDaily`.
  Produces a daftari markdown daily with frontmatter using **real** daftari builtin
  fields (`src/frontmatter/types.ts` `BuiltinFrontmatter`): persona id → `collection`,
  `activeArcs` → `tags`, plus `title`/`created`/`updated` from `DayMetadata.date`.
  `date` and `dayNumber` are NOT builtins — carry them as config-declared extension
  fields (or omit; they don't affect retrieval, the only thing SP1 measures).
  Note `collection` also falls back to the first path segment at index time
  (`reindex.ts:209`), so filing dailies under `<persona>/` makes persona-as-collection
  robust even without the field. No I/O — fully unit-testable.
- **`answerer.ts`** — per-question agent loop. Exposes
  `answer(question) → { answer, retrieval, toolCalls }`. Reuses
  `buildToolSurface` (`src/eval/tool-surface.ts:152`) + `createAnthropicClient().
  completeWithTools` (`src/eval/llm.ts:116`) + `ANSWERER_SYSTEM_PROMPT`
  (`src/eval/prompts.ts`). **Does NOT use `runAnswerer`** — that is a batch driver
  tied to the cortex-eval `QuestionSet`/`EvalRun` shapes (k-sampling, tier counts,
  subgraph), not a per-question function. `completeWithTools` already is the
  per-question loop and returns `{text, tool_calls}` directly. Maps
  `config.agentMaxIterations → opts.maxRounds` (note: `completeWithTools` default
  is 12, not the example profile's 6 — set it explicitly).
  Handlers are called with `access: undefined`, matching the eval tool-surface
  (`tool-surface.ts:158-170`), which **bypasses RBAC** — so no config.yaml role is
  needed for SP1.
- **`adapter.ts`** — implements `MemorySystemAdapter`; owns temp-vault lifecycle and
  DB/index handles.
- **`config.ts`** — parse `harness.config` (answerer model, `maxSearchResults`,
  `agentMaxIterations`, etc.) with daftari `Result<T,E>` validation.
- **`index.ts`** — exports `createDaftariAdapter(config)`.

### Method → daftari operation

| Adapter call | Daftari action |
|---|---|
| `setup()` | `mkdtemp` temp vault; in-process — **no** server, **no** `process.lock` (`acquireProcessLock` is only called from server `main()`, `src/index.ts:72`). No config.yaml RBAC role needed (handlers run with `access: undefined`) |
| `ingestDay(day, content, meta)` | `corpus-map` → write `<vault>/<persona>/day-XXXX.md`; batched (no index yet) |
| `finalizeIngestion()` | call `reindexVault`. **It clears and rebuilds the index tables every call** (`reindex.ts:1-5, 249-269`) — there is no in-place incremental path. What is incremental is the **embedding** step: content-hash-keyed cache (`existingEmbeddingHashes`, `reindex.ts:304`) re-embeds only new/changed chunks. **Idempotency holds because the temp vault on disk is cumulative and is the source of truth** — each call re-stages all files-so-far and rebuilds, so repeated calls correctly cover all ingested days at low marginal embedding cost. **No consolidation** (baseline needs no edges). **Runtime confound guards (new `ReindexResult`):** throw if `vectorEnabled===false`, if `invalidFrontmatter.length>0` (a daily was coerced), or if `skipped.length>0` (a daily wasn't indexed) — see finding 3 |
| `query()` / `queryDetail()` | run the answerer agent-loop over the in-process tool surface; return prose answer + `retrieval[]` + `toolCalls[]`. **Extraction:** union all `vault_search` hits across the trace (filter `tool === "vault_search"`, skip `{tool_error}` envelopes, dedup by path keeping max score) → `RetrievalEntry{path,score,snippet}` (`HybridHit` has these; `snippet` is a ±140-char excerpt, not the full chunk). `toolCalls[]` maps `{tool, input→args, output→resultPreview(≤200 chars)}` per `ToolCallTraceEntry` |
| `teardown()` | `rm -rf` the temp vault, **after asserting the path is under `os.tmpdir()`** (cheap guard, consistent with the symlink-confinement work merged on this branch). (No long-lived DB handles to close — search/reindex open and close the DB per call.) |

### Data flow

```
Recall Bench harness
  → ingestDay × N (chronological, to checkpoint cutoff)
  → finalizeIngestion (rebuild from cumulative vault; embedding-cached)
  → query × (eligible + sampled QAs)        [daftari answerer agent-loop, Claude]
  → primary judge (azure:gpt-5.4-mini) → appellate (azure:gpt-5.4) on failures
  → result.json / progress.jsonl / failures.jsonl
```

Incremental checkpoint mode: the harness extends the corpus per checkpoint and
re-calls `finalizeIngestion`. The index tables are rebuilt from scratch each call
(not mutated in place); correctness comes from the cumulative on-disk vault, and the
embedding cache keeps each rebuild cheap (only new days are embedded).

## Models / keys

- **Judges:** primary `azure:gpt-5.4-mini`, appellate `azure:gpt-5.4` (match the
  published runs for judge comparability). Requires the billed Azure key in the
  profile's `env.file` (same key gap noted for the Stage-5 consolidate work).
- **Answerer:** Claude via daftari's native Anthropic client (`createAnthropicClient`,
  needs `ANTHROPIC_API_KEY`). Model id pinned in `config.ts` and surfaced in run
  metadata (`RunMetadata.synthesisModel`).
- **Embeddings:** native MiniLM (local, no key). Record the embedding model
  id/version in run metadata (reproducibility; pairs with the `synthesisModel` capture).
- **Unused profile field:** `models.generation` (which other harnesses use for
  post-retrieval synthesis) is **not** used by this adapter — in agent mode daftari
  answers with its own Claude client. Noted so a reader doesn't think it drives daftari.

## Run plan

1. **Smoke** — EA, 3 checkpoints (`start:6 end:30 step:12`), `sample:10`, no
   appellate. Validates the full pipeline cheaply (minutes, low cost) before any
   long run.
2. **Full baseline** — EA-180d, 30 checkpoints (`step:6`), `sample:50`,
   `judgeMemoryWindow:1`, appellate on. Matches the published comparison set.
   ~1–3 hrs + API cost. Always set `--json-out` for resumability.

## Error handling

- **Per-query errors** return a logged sentinel answer — one bad question must not
  abort a multi-hour run. **Log daftari-error sentinels distinctly from genuine
  model/answer failures** (e.g., a `daftari_error: true` marker), so the
  failure-mode analysis isn't polluted by infrastructure errors masquerading as
  recall failures.
- **Ingest/reindex errors** throw — these are genuine system failures the bench
  should record.
- **`finalizeIngestion` idempotency** — a test asserts a second call yields an index
  covering all ingested days at no greater embedding cost (the embedding cache is hit).
- **Silent vector fallback (confound guard)** — if MiniLM fails to load, `reindexVault`
  silently sets `vectorEnabled=false` (`reindex.ts:334-337`) and search degrades to
  BM25-only, which would silently corrupt the baseline. The adapter MUST detect
  `vectorEnabled:false`/`vectorUsed:false` and either abort or record it in run
  metadata. (See the known MiniLM CI-load flake — re-run before trusting a red result.)
- **`teardown`** removes the temp vault even when a prior step threw (try/finally).
- **Answerer loop** bounded by `agentMaxIterations` (→ `maxRounds`). NOTE: the daftari LLM client (`completeWithTools`) exposes no `timeout` knob, so the per-call profile `timeout` is enforced by the Recall Bench harness *around* `query()`, not inside the adapter — `maxRounds` is the only in-adapter bound.

## Testing (mirrors `src/`)

`corpus-map.test.ts` and `config.test.ts` are **hermetic** (no model, no network).
`answerer.test.ts` and `adapter.test.ts` stub the LLM but call real `reindexVault`,
which loads the MiniLM model — they are **integration tests requiring the model
cached** (gate them; re-check reds against the known MiniLM CI-load flake).

- **`corpus-map.test.ts`** — day+content+metadata → expected frontmatter asserted
  against the **real** builtin field names (`collection`, `tags`, `title`,
  `created`, `updated`; defaults the validator fills: `domain→accumulation`,
  `status→draft`, `confidence→low`, `provenance→inferred`) and canonical daily path.
- **`adapter.test.ts`** — lifecycle: `setup` → ingest 3–5 dailies with a planted
  fact → `finalizeIngestion` → `queryDetail` returns the fact and surfaces the
  correct daily in `retrieval[]`; `finalizeIngestion` idempotency (second call
  extends, doesn't reset); `teardown` removes the temp dir. Uses a **stub LLM
  client** for the answerer (deterministic, offline) but a **real in-process
  `hybridSearch`** over the fixture so retrieval is genuinely exercised.

## Validation findings from the 2026-06-20 spike (cross-ref: critique doc)

A separate Recall Bench adapter spike (EA-180d, stopped at 154/312 Qs) produced a
falsifiable critique ("What daftari is truly missing"). Its tests were re-run
against the repo at commit `30e0bfe`. Three findings are load-bearing for this
programme and are recorded here so SP1/SP2 absorb them rather than rediscover them.

1. **SP1 *is* daftari's first retrieval-only eval — state it, don't assume `daftari
   eval` covers it.** `[DATA]` `daftari eval` (`src/eval/types.ts`) is the *cortex
   quality* metric: LLM-judged `expected_answer` over a generated subgraph QA set,
   with a `grader`/`answerer_model`. It has no `recall@k`/nDCG/MRR over a labeled
   (query → relevant-doc) set, and it confounds retrieval with synthesis. SP1's
   per-category recall numbers are the *first* retrieval-grounding measurement in
   the box. The SP1 results note should say this explicitly so no reader thinks the
   eval already existed.

2. **The retrieval-grounding contract is the durable artifact — SP2's output shape,
   not just SP2's ranking.** `[DATA]` Today a hit is
   `HybridHit = { path, score, bm25Score, vectorScore, snippet, decay }`
   (`src/search/hybrid.ts:39-47`). The spike's hallucinations (`final_hold.md`,
   "day-0085") happened *over correct retrieval* because the caller had only prose
   `snippet` + document `path` to synthesize from. The missing fields a safe
   synthesizer needs are: **(a) char/line spans** into the source (today `snippet`
   is a ±140-char excerpt, no offsets); **(b) a stable chunk/source id** to cite
   (today `path` only, document-level — though the index already chunk-hashes
   content, so the id exists internally); **(c) an answerability/sufficiency
   signal**. SP1's `RetrievalEntry` extraction (`query()` row above) makes the
   absence concrete: it can only emit `{path, score, snippet}`. **Recommendation:**
   when SP2 touches `hybrid.ts` for supersession-aware ranking, extend `HybridHit`
   to carry chunk-id + spans + a sufficiency flag in the same pass — the
   retrieval-grounding contract and the ranking change are the same edit to the same
   struct, and the contract is the part that outlives the benchmark. Keep decay/
   supersession as **structured sibling fields** (they already are — do not inline
   them into `snippet`; the spike's `⚠ STALE`-in-prompt leak was the *adapter*
   flattening a structured field, and SP1's adapter must not repeat it).

3. **corpus-map fidelity is load-bearing because reindex coerces silently — no error
   on bad frontmatter.** `[DATA]` `vault_write` rejects schema-invalid frontmatter
   (`write.ts:534`), but the adapter does **not** use `vault_write` — it writes
   dailies to disk and calls `reindexVault`. On that path, `parseDocument` →
   `validateFrontmatter` **coerces** invalid enums to fallbacks (`domain: tooling →
   accumulation`, `confidence: EXPLICIT → low`) and `stageOne` indexes the coerced
   value while **discarding `parsed.value.validation`** (`reindex.ts:185-225`,
   `parser.ts:30-38`). Consequence for SP1: if `corpus-map.ts` ever emits an enum
   outside the builtin sets, **the run will not error — it will silently index a
   different value than intended**, corrupting the baseline invisibly. This is the
   real reason `corpus-map.test.ts` must assert against the exact builtin field
   names and the validator-filled defaults (already required at lines above); the
   added rationale is *why* the assertion is a correctness gate, not a nicety.

   **UPDATE 2026-06-20 — the standalone fix landed and SP1 now uses it as a RUNTIME
   guard.** `fix/reindex-validate-on-ingest` (merged into the SP1 branch) makes
   `reindexVault` **report** coercion instead of swallowing it: `ReindexResult` now
   carries `invalidFrontmatter: FlaggedDocument[]` (indexed but schema-violating →
   coerced) and `skipped: FlaggedDocument[]` (unreadable/malformed YAML), where
   `FlaggedDocument = {path, reason}`. So SP1 gets defense in depth: the static
   `corpus-map` unit gate (catch at test time) PLUS `finalizeIngestion` asserting
   `invalidFrontmatter.length === 0 && skipped.length === 0` at runtime (fail loud if
   any daily was coerced or dropped — the baseline can no longer be silently
   corrupted). Build SP1 against this new shape, not the old `skipped: string[]`.

## Open questions / risks

- **Answerer-model confound** (accepted) — documented above; revisit only if
  cross-system comparison becomes load-bearing.
- **Corpus → frontmatter fidelity** — Recall Bench dailies are plain markdown;
  the chosen frontmatter (collection = persona, tags = arcs) should not distort
  retrieval. The smoke run is the check.
- **Reindex cost at 180 days** — the BM25/table rebuild is **full each checkpoint**
  (O(all docs-so-far)); only the **embedding** step is incremental (content-hash
  cache → only new days embedded). Cheap at ~180 docs, but state it accurately: it's
  not an incremental reindex, it's a cheap full rebuild plus cached embeddings. Smoke
  run measures it.
- **Adapter ↔ daftari internals coupling** — importing `src/eval` and `src/search`
  internals ties the adapter to non-public surfaces. Acceptable (same repo); note
  if it forces exporting internals.

## Definition of done (SP1)

- `integrations/recall-bench/` builds; `createDaftariAdapter` satisfies
  `MemorySystemAdapter` (including the required `name` field); tests green.
- Smoke run completes end-to-end against Recall Bench.
- Full EA-180d baseline run produces `result.json` + failure logs.
- **Supersession failure is actually exercised** (elevated — without this the
  headline analysis has no data and the baseline is decorative): confirm
  `contradiction-resolution` QAs are present in the EA dataset AND evaluated at ≥1
  checkpoint *after* their revision day (e.g. the Condor day-13–14 flip → a checkpoint
  at day ≥18 that samples those QAs). If sampling can leave them out, pin them in (or
  verify coverage in the smoke run) before trusting the baseline.
- A short results note: daftari's baseline composite + degradation curve +
  `contradiction-resolution` failure analysis (does it return stale revisions?),
  with the cross-system comparability caveat stated.
