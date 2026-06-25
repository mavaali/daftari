# Results — Chunk-BM25 native-shape regression check (title/tag blindness)

**Date:** 2026-06-24
**Spec:** `docs/superpowers/specs/2026-06-24-chunk-bm25-native-regression-design.md`
**Plan:** `docs/superpowers/plans/2026-06-24-chunk-bm25-native-regression.md`
**Harness:** `integrations/recall-bench/{gen-native-vault,native-regression-runner}.mjs`
**Verdict:** **Chunk-BM25 is structurally blind to title/tag-only retrieval (0.0 hit@1 vs document's 1.0) and at full parity on body retrieval (1.0 = 1.0). On native one-fact-per-file vaults, chunk-BM25 is NOT safe as a blanket default lexical ranker without a title/tag fix.**

## What was tested

The chunk-BM25 win (Stage B, PR #155) was measured only on Recall Bench (long multi-topic journals). daftari's native model is the opposite shape: one fact per file, single-topic, short. A code-confirmed asymmetry creates a regression risk on that shape:

- `documents_fts` indexes `(title, tags, content_body)` (index-db.ts:183-184).
- `chunks_fts` indexes only chunk text, and chunks are **body-only** (`const body = parsed.value.content; chunkText(body)`, reindex.ts:261-266).

⇒ chunk-BM25 cannot match a token that lives only in title or tags. This experiment **quantifies the magnitude** of that blindness and **confirms body-query parity**. It does not discover whether the gap exists — the code already proves it; it measures how total the gap is.

**Method (`$0`, no LLM, no `src/` changes):** a generator builds a synthetic native-shape vault — 100 single-topic docs, each <800 chars (single chunk, asserted: `maxChunksPerDoc == 1`), with complete valid frontmatter (asserted: `invalidFrontmatter == 0, skipped == 0`). Each doc carries three globally-unique, field-isolated tokens (one only in the title, one only in a tag, one only in the body). 300 labeled queries (100 per type) are run under two arms — document- and chunk-granularity, lexical-only (`{bm25:1, vector:0}`, `vectorUsed:false` asserted) — and scored by path-equality hit@1 / hit@5. A validity guard requires the document arm to hit@1 ≥ 0.99 on every type (it indexes all fields, so it must find every unique token, else ground truth is broken); the guard **passed** (document hit@1 = 1.0 on all three types).

## Results (hit@1 / hit@5, n=100 per query type)

| query type | document hit@1 | chunk hit@1 | document hit@5 | chunk hit@5 |
|---|---|---|---|---|
| **body**  | 1.0 | **1.0** | 1.0 | 1.0 |
| **title** | 1.0 | **0.0** | 1.0 | 0.0 |
| **tag**   | 1.0 | **0.0** | 1.0 | 0.0 |

## Interpretation

- **Body parity is total.** On the single-chunk native case, the body token lives in the one chunk, so chunk-BM25 and document-BM25 retrieve identically (1.0 = 1.0). The common case — a query that hits the body — is **safe**. No avgdl/normalization surprise reordered anything at hit@1.
- **Title/tag blindness is total.** A query whose discriminating term is in the title or tags returns **nothing** from chunk-BM25 (0.0) — the token is in no chunk, `chunkFtsRanking` returns an empty map, the doc gets zero lexical score. Document-BM25 finds it every time (1.0). This is the maximal form of the code-evident regression.
- **Decision:** flipping the default lexical path to chunk-granularity on native vaults would **silently break all title/tag-only retrieval**. On daftari's native model — where the title is typically the canonical handle for a fact and tags carry classification — that is a serious regression. **Chunk-BM25 must remain opt-in until it folds title/tag signal back in.** This directly motivates the follow-on fix cycle.

## Honest Assessment

- **What this shows:** the magnitude of chunk-BM25's title/tag blindness (total, 0.0) and the safety of the body case (total parity, 1.0) on a controlled native-shape corpus.
- **What it does NOT show / caveats:**
  1. **Synthetic, worst case.** Tokens here are *fully* field-isolated — the title/tag token appears in NO body. Real native vaults restate the title token in the body far more often (a fact titled "Project Zephyrine budget" usually says "Zephyrine" in the body too), so chunk-BM25 would recover many of these via the body. The measured **0.0 is an upper bound on the regression**, not the expected real-world rate. The true cost depends on how often a native vault's discriminating term is title/tag-*exclusive* — unmeasured here.
  2. **recall@k, not answer quality.** Path retrieval only.
  3. **Says nothing about the multi-topic *win*** (the separate "Q1" generalizability question).
- For a *safety* check this worst-case framing is the right one: the body case is safe even in the worst case, and the title/tag case fails even in the worst case — so the design conclusion (needs a title/tag fix before any default flip) is robust regardless of where real vaults fall on the spectrum.

## What ships / what's next

- Generator + runner committed; reproducible (`node gen-native-vault.mjs && node native-regression-runner.mjs`). No `src/` change — production untouched.
- **Feeds the follow-on fix brainstorm (cycle 2 of "quantify, then fix").** The magnitude is total, so a fix is clearly warranted before any default flip. Two candidate approaches to weigh there:
  - **Title+tags pseudo-chunk** — at index time, inject one extra `chunks_fts` row per doc containing the title + tags text, so chunk-BM25 can match those terms as their own high-density chunk. Preserves the granularity win; +1 FTS row/doc; the cleaner option.
  - **Union with document-BM25** — combine chunk-BM25 with whole-doc BM25 (which already includes title/tags). Simpler, but reintroduces some of the whole-doc dilution the chunk ranker was built to remove.
- The pseudo-chunk approach is the likely recommendation (keeps the dilution fix and closes the title/tag gap), but that's the next brainstorm's call.
