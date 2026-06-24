# Handoff — chunk-level BM25 prototype (the lossless lever Stage A points at)

**Date:** 2026-06-23
**One-line:** The atomization Stage A experiment (just completed) showed sub-document **granularity** improves RB retrieval recall by **+6–18pp**, the benefit is **lexical** (whole-document BM25 dilution is the bottleneck), and the lossless realization is **chunk-level BM25 in `hybrid.ts`**. Next session: spec → prototype → measure that. Start fresh here.

## Why a new session
This session ran the full coverage thread to a clean stopping point: shipped coverage Stage 1 (v1.28.0), fixed the malformed-date bug (#151), cut the release, killed the date-window half (Stage 3, PR #153), and ran atomization Stage A to a grounded verdict. The next piece — a chunk-level-BM25 prototype — is genuinely new scope (a `src/search/hybrid.ts` change, not an experiment script). Resume clean.

## The settled finding (all verified this session)

On RB multi-day questions (n=979), **deployment-grounded recall@top-K, day-coverage:**

| | K=10 | K=20 | K=50 |
|---|---|---|---|
| DAY hybrid | 0.221 | 0.359 | 0.627 |
| ATOM hybrid | 0.286 | 0.430 | 0.683 |
| **DAY lexical** | 0.181 | 0.281 | **0.528** ← worst |
| **ATOM lexical** | **0.286** | 0.418 | **0.711** ← best |

- **Granularity helps** (atom > day everywhere), modestly: +6.5pp @K=10 → +18pp @K=50 (lexical). The "6×" from the char-budget metric was a **density artifact** (feeding full doc bodies); top-K is the honest number. Full reasoning: `docs/superpowers/results/2026-06-23-atomization-granularity-measurement.md`.
- **It's lexical.** `DAY lexical` worst, `ATOM lexical` best. Whole-document BM25 (`ftsRanking` over `documents_fts` in `src/search/hybrid.ts`) scores the *whole* multi-topic day, diluting the relevant topic. The vector half is already per-chunk (KNN over `embeddings_vec`, collapse to best-per-doc) so it adds nothing to atoms.

## The thing to build (the next session's job)

**Chunk-level BM25 in `src/search/hybrid.ts`** — mirror what the vector half already does, for the lexical half:
- Today: `ftsRanking` matches `documents_fts` (one FTS row per whole document) → one BM25 score per document, diluted.
- Proposed: an FTS index over **chunks** (the `chunks` table already exists, per-doc per-chunk), BM25 per chunk, then **collapse to best-chunk-per-document** (exactly the `vecRanking` pattern). A relevant topic's chunk scores high on its own; its document inherits that score instead of the diluted whole-doc score.
- **Lossless + chunking-general:** the document stays whole on disk; no SP-C atomization; no `###` structure needed (chunking is content-based). This is a ranker change, not an ingest pipeline.

**Key files to read first:** `src/search/hybrid.ts` (`ftsRanking` ~line 110; `vecRanking`/collapse-to-best-per-doc is the template ~line 141-165); `src/storage/index-db.ts` (the `chunks` table + `documents_fts` schema + triggers — there is currently NO chunk-level FTS, that's the net-new piece); `src/search/reindex.ts` (where chunks are written, to add a chunk-FTS population).

## How to measure it (reuse this session's harness)
The measurement is already built and the verdict criterion is set:
- Re-run `integrations/recall-bench/granularity-runner.mjs` logic but with **three arms over the WHOLE-day vault**: current whole-doc BM25, vs the new chunk-level BM25, vs the atom-vault (the upper bound). Success = chunk-level BM25 on the *day-vault* recovers most of the atom-vault's +6–18pp **without** physically atomizing (proves the lossless ranker change captures the granularity benefit).
- Day-vault: `/tmp/cov-recall/vault` (re-run `prep-vault.mjs` if gone). Atom-vault: `/tmp/cov-recall/atom-vault` (re-run `atomize-vault.mjs`). Questions: `integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`. RB corpus: `/tmp/recall-review/...memories-180d` (re-clone `Stevenic/recall` if gone). All ephemeral `/tmp`.
- Metric: recall@top-K (K=10/20/50), day-coverage, multi-day, lexical weights `{bm25:1,vector:0}`. `$0`, no LLM.

## Open questions for the next session's brainstorm
1. **Is +6–18pp worth a ranker change?** It grows with K — agents retrieving deep (K=50) gain most. Frame expectations: real but not a silver bullet.
2. **Return contract:** chunk-level *scoring* improves which documents rank; do we also want chunk-level *return* (snippets already exist, 140-char)? The Stage A snippet caveat — feeding atom-snippets vs day-snippets may change *answer* quality — is untested and is a separate LLM-arm experiment if it matters.
3. **Index cost:** a chunk-level FTS roughly multiplies FTS rows by mean-chunks-per-doc. Acceptable? (the vec table already pays this.)
4. **Collapse function:** best-chunk-per-doc (max) vs sum/mean of chunk scores — which collapse mirrors the relevance you want? (vector half uses best-per-doc.)

## This session's PRs (context)
#150 coverage Stage 1 (merged, v1.28.0), #151 malformed-date fix (merged), #153 Stage 3 kill (merged), and the atomization Stage A branch `exp/atomization-granularity` (PR being opened as this session closes — results + harness, no `src` change).
