# Results — Title/tag-aware chunk-BM25 (tiered combine)

**Date:** 2026-06-24
**Spec:** `docs/superpowers/specs/2026-06-24-chunk-bm25-title-tag-design.md`
**Harnesses:** `integrations/recall-bench/native-regression-runner.mjs` (native gate), `integrations/recall-bench/chunkbm25-runner.mjs` (RB win gate)
**Verdict:** **BOTH gates pass. Chunk-BM25's title/tag blindness is closed (native title/tag hit@1 0.0 → 1.0) AND the RB multi-topic win is preserved exactly (gapRecovered 0.527/0.996/0.880, byte-identical to the pre-fix baseline). Chunk mode is now a complete lossless ranker on both corpus shapes.**

## What was tested

Cycle 1 (PR #156) proved the opt-in chunk-BM25 ranker is title/tag-blind (`chunks_fts` indexes body only): native title/tag-only retrieval = 0.0 hit@1. This cycle adds a title/tag signal in chunk mode — a column-restricted `{title tags}` BM25 from `documents_fts` — combined with the chunk-body signal. The combine must (a) close the native gap AND (b) not regress the RB multi-topic win.

**The first combine failed.** A de-weighted max (`max(chunkNorm, 0.99 × titleTagNorm)`) regressed the RB win: RB day titles are `daily log <date>`, so common title tokens (`daily`, `log`, dates) match queries; `normalize` inflates a wrong day's title match to 1.0 and `0.99` beat the right day's *fractional* chunk score. gapRecovered dropped to 0.49 / 0.869 / 0.733 (kill condition tripped). A single global weight can't satisfy both corpora.

**The shipped combine is tiered.** `tieredLexical`: a doc with any chunk-body match occupies an upper band `(0.5, 1]` (ordered by body score); a doc matched *only* via title/tags occupies a lower band `(0, 0.5]` (ordered by title/tag score). Body always outranks title-only **by construction** — no tunable weight. (Both inputs normalize to `(0,1]` with no zeros, so the upper band is strictly `>0.5` and the lower band maxes at exactly `0.5`: strict, tie-free separation.)

## Gate 1 — Native-shape regression (the fix must work)

`native-regression-runner.mjs`, n=100/type, chunk mode, lexical-only:

| query type | chunk hit@1 BEFORE (cycle 1) | chunk hit@1 AFTER |
|---|---|---|
| title | 0.0 | **1.0** |
| tag | 0.0 | **1.0** |
| body | 1.0 | 1.0 |

Document arm unchanged (1.0 all types); validity guard (document hit@1 ≥ 0.99) PASS. **Title/tag blindness fully closed.**

## Gate 2 — RB multi-topic win (the fix must not regress it)

`chunkbm25-runner.mjs`, multi-day n=979, lexical-only (`vectorUsed: false`). `dayChunk` recall@top-K and the day-doc→atom `gapRecovered`:

| | K=10 | K=20 | K=50 |
|---|---|---|---|
| dayChunk (pre-title/tag baseline) | 0.2364 | 0.4177 | 0.6887 |
| **dayChunk (tiered, this run)** | **0.2364** | **0.4177** | **0.6887** |
| gapRecovered (baseline) | 0.527 | 0.996 | 0.880 |
| **gapRecovered (tiered, this run)** | **0.527** | **0.996** | **0.880** |
| _gapRecovered (failed de-weight, for contrast)_ | _0.490_ | _0.869_ | _0.733_ |

**The tiered title/tag tier is inert on RB** — byte-identical to the body-only baseline. Mechanism: RB queries are answered by body content, so the right day is body-matched → upper band; any common-token title match lands in the lower band and never displaces it. **Multi-topic win fully preserved.**

## Verdict

Both gates pass. The title/tag fix closes the native regression without costing anything on the multi-topic corpus. Chunk mode (`lexicalGranularity:"chunk"`) is now a complete lossless lexical ranker: per-chunk body granularity (the dilution fix) + title/tag matchability (the native fix), with body strictly primary.

**Kill-condition status: PASSED** (the de-weight design FAILED this same gate; the tiered combine exists specifically to pass it, and does).

## Honest Assessment

- **What this shows:** the tiered combine adds title/tag retrieval to chunk mode (native 0→1.0) with zero measured cost to the RB multi-topic win (gapRecovered identical to baseline).
- **What it does NOT show / caveats:**
  1. The native gate is a **synthetic worst case** (field-isolated tokens); real native vaults restate the title token in the body, so the real-world title/tag dependence is smaller — the fix is a safety margin, not a measured real-world delta.
  2. `TIER_SPLIT = 0.5` is a **structural band boundary, not a tuned weight** — any value in (0,1) gives the same strict body-over-title ordering.
  3. **Precondition:** tiering preserves the RB win *because* the right day is body-matched there. A corpus whose correct answer is reachable only via title/tag would not benefit from the body tier — untested beyond RB + the synthetic native vault.
  4. Promoting `"chunk"` to the **default** lexical path is still gated on the separate Q1 (multi-topic generalizability on a non-RB corpus) and answer-quality questions — out of scope here. This cycle only makes chunk mode *safe* on the title/tag axis.
- **Within-chunk-mode note:** the tiering compresses the lexical score into half-bands, which shifts the bm25-vs-vector blend ratio when vectors are active. Validation is lexical-only, so the gates don't exercise this; re-check it if chunk mode is ever promoted to a vector-on default.

## What ships / what's next

- `hybrid.ts` tiered combine + unit tests (title-only / tag-only / tie / dilution-preserved). Both harnesses re-run as the gates.
- Default-flip remains gated (Q1 + answer-quality). This closes the title/tag axis of the chunk-mode programme.
