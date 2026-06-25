# Spec — Q1: does the chunk-BM25 win replicate on an independent human-query corpus (SQuAD)?

**Date:** 2026-06-24
**Status:** Design approved, pre-implementation
**Context:** The chunk-level BM25 ranker (PR #155) recovers most of the multi-day retrieval-recall gap on Recall Bench (the "win"). Both that win and the title/tag fix (#157) were measured on RB. Promoting `lexicalGranularity:"chunk"` to the default lexical path is gated on **Q1 — external validity**: is the win an artifact of RB's synthetic generation, or does it hold on an independent corpus? This experiment tests that on **SQuAD**, a standard QA dataset with long multi-topic documents and **human-authored** queries.
**Related:** [[project_recall_bench_experiment]], `docs/superpowers/results/2026-06-23-atomization-granularity-measurement.md` (the RB win), `docs/superpowers/results/2026-06-24-chunk-bm25-measurement.md`.

## Problem

The chunk-BM25 mechanism — whole-document BM25 dilutes a relevant topic across a long multi-topic document; per-chunk BM25 recovers it — has only been measured on Recall Bench. RB is **synthetically generated**: an LLM authored both the daily-journal corpus and the QA pairs. Three external-validity threats follow: (1) the QA generator may write questions that map suspiciously cleanly to chunks; (2) RB's daily-journal structure may be unusually chunk-friendly; (3) the EA domain may be special. A new RB persona escapes only (3); a synthetic corpus we build escapes none (it bakes in the dilution). Only a **real, independently-built, labeled corpus** tests generalization.

## Goal

On SQuAD reconstructed to article-level documents, measure whether **chunk-granularity** lexical retrieval beats **document-granularity** on **human-authored** queries — same direction as the RB win — and by how much. `$0` (no LLM; recall@k is pure lexical). The outcome gates (does not by itself decide) the default-flip.

## Why SQuAD, why article-level

- A SQuAD article (~40 paragraphs) reconstructed into **one document** is long and genuinely multi-topic — the dilution precondition. The answer to any question lives in **one paragraph** → whole-article BM25 dilutes; chunk-BM25 should recover. This is the exact RB mechanism, on a different corpus.
- Queries are **human crowdworker questions**, independent of any corpus generator — directly addressing threat (1).
- SQuAD's relevance is intrinsic: each question carries the title of its source article → article-level qrels for free.
- Free (public JSON), and **tractable** (~442 train-split articles = a non-trivial retrieval pool, small enough to index locally). Alternatives rejected: HotpotQA / most BEIR sets use short paragraph-documents (weak dilution); Natural Questions / MS-MARCO-Document fit the shape better but are millions of documents (intractable to index here).

## Non-goals (YAGNI)

- **No `src/` changes.** This is a measurement over the existing opt-in ranker (`hybridSearch` with `lexicalGranularity`). Reuses the recall-bench harness pattern.
- **No atom upper-bound arm.** RB needed a physical-atomization ceiling; Q1 only asks doc-vs-chunk (does the lossless ranker change help on a new corpus). Two arms.
- **No answer-quality / LLM arm.** Recall@k only; the answer-quality question is the separate gated track.
- **No vector/hybrid tuning.** Lexical-only (`{bm25:1, vector:0}`) isolates the BM25 dilution effect, matching RB methodology. (A hybrid sanity arm is optional, see Open questions.)
- **No multi-corpus sweep.** One independent corpus answers "does it replicate at all"; "replicates everywhere" is out of scope.
- **No paragraph-level qrels.** Relevance is article-level (does the right *article* rank). Paragraph-level would be sharper but article-level is the honest test of *document* dilution and is what SQuAD labels cleanly.

## Design

### Which tree we measure on

This branch is cut from `main` — which has the **body-only** chunk-BM25 ranker (#155) but **not** the title/tag union (#157, still unmerged). That is the right tree for Q1: the question is whether the **core body-dilution win** generalizes, and the neutral-title reconstruction makes the #157 union **inert** anyway (neutral titles carry no query tokens), so the result is identical under either version. Build/run the harness against this branch's `dist/`; record the measured commit in the results note.

### Component 1 — Adapter `integrations/recall-bench/gen-squad-vault.mjs`

Deterministic, `$0`. Produces a daftari vault + labeled queries from SQuAD.

- **Input:** SQuAD v1.1 JSON (public; e.g. the train split `train-v1.1.json`). The adapter downloads it if absent to an ephemeral `/tmp` path (document the URL; fail loudly if the download fails rather than silently producing an empty vault).
- **Document reconstruction:** group all paragraphs under each `title` into **one markdown document** (`squad-<NNN>.md`), body = the article's paragraphs concatenated (blank-line separated, so the chunker splits them), with **complete valid daftari frontmatter**. Required fields incl. the **enums** `domain` ∈ {accumulation, generative} and `provenance` ∈ {direct, synthesized, inferred} and `status` ∈ {draft, canonical, …} and `confidence` ∈ {low, medium, high} — a missing/invalid enum is coerced to a default **and flagged**, which trips guard #2 (zero `invalidFrontmatter`) and aborts. Emit valid values (mirror an existing `test/fixtures/sample-vault` doc).
  - **Title-leak guard:** the SQuAD article title is highly discriminative and would let *document*-granularity match via the title column unfairly (and chunk mode now unions title/tags — #157). To keep the test about **body dilution**, either (a) use a neutral synthetic title (`squad-<NNN>`) and put the real article title only in the body, or (b) run lexical-only doc-granularity which still indexes title via `documents_fts`. **Decision:** use a neutral `title:` (`Article <NNN>`) and a neutral tag, so neither arm gets a title shortcut — the comparison is purely body-chunk vs body-whole-doc. (Document this; it's load-bearing for a fair test.)
- **Query set:** for each sampled question, emit `{ id, query: <question text>, relevantPath: squad-<NNN>.md }`. Sample **~1–2k** questions across articles (deterministic sample — e.g. first K per article or a fixed stride; no `Math.random`). One relevant article per query (SQuAD answers are single-article).
- **Output:** vault at `/tmp/squad/vault`, queries at `/tmp/squad/queries.jsonl`.

### Component 2 — Runner `integrations/recall-bench/squad-runner.mjs`

Mirrors `chunkbm25-runner.mjs`'s import/open pattern (NOT its day-coverage helpers). For each query, two arms, lexical-only (`{bm25:1, vector:0}`):
- document: `lexicalGranularity:"document"`
- chunk: `lexicalGranularity:"chunk"`

**Metric:** since each query has exactly one relevant article, report **hit@k** (k=10/20/50 — is the relevant article in top-k), **hit@1**, and **MRR@10**. Label them hit@k/MRR (not "recall@k") to avoid implying graded relevance. Aggregate mean across queries, per arm.

**Validity guards (fail loudly — the experiment is invalid otherwise):**
1. `vectorUsed === false` on every call (lexical purity).
2. Reindex reported **zero `invalidFrontmatter` and zero `skipped`**.
3. **Dilution precondition:** mean chunks-per-doc ≫ 1 (articles are genuinely multi-chunk). Report it; if ≈1 the corpus reconstruction is wrong.
4. **Ceiling check (report, don't fail):** if document-granularity hit@1 is already ~1.0, there is no dilution headroom (SQuAD's entity-rich questions can make whole-article BM25 easy) → the result is an honest *null* and must be reported as "no headroom," not "chunk doesn't help."

Write per-query JSON + a summary JSON; print the summary.

### Component 3 — Results note `docs/superpowers/results/2026-06-24-chunk-bm25-squad-generalization.md`

Doc-vs-chunk table (recall@10/20/50, hit@1, MRR@10), the dilution stat (mean chunks/doc), the ceiling check, the verdict (does the win replicate, and the magnitude vs RB), and an Honest Assessment.

## Success / interpretation

- **Replicates:** chunk-granularity beats document-granularity by a meaningful margin on the same metrics → the win is **not** an RB artifact; it holds on an independent human-query corpus. Strengthens the default-flip case (still pending answer-quality).
- **Null (no headroom):** document-granularity already near ceiling → SQuAD lacks dilution headroom; inconclusive on generalization (report as such, don't overclaim).
- **Negative:** chunk underperforms document → the win may be RB-structure-specific; a strong signal *against* a blanket default flip. Report honestly.

**Kill condition for validity (not the hypothesis):** if docs are not multi-chunk, or `invalidFrontmatter > 0`, or `vectorUsed` is true, the numbers are invalid — assert and fail loudly.

## Honest Assessment (to live in the results doc)

- **What it shows:** whether the doc-vs-chunk dilution effect appears on an independent corpus with human queries.
- **What it does NOT show:** (1) SQuAD questions are **entity-rich**, so dilution headroom may be smaller than RB's — the *magnitude* can differ even if the *direction* replicates. (2) One corpus — "replicates on SQuAD" ≠ universal. (3) Article-level qrels (not paragraph) — measures *document* retrieval, not passage pinpointing. (4) Recall@k, not answer quality. (5) The neutral-title reconstruction deliberately strips the article title from the matchable title field to isolate body dilution — a real vault might title docs meaningfully, where chunk mode's title/tag union (#157) would also contribute.

## Files

- Create: `integrations/recall-bench/gen-squad-vault.mjs`
- Create: `integrations/recall-bench/squad-runner.mjs`
- Create: `docs/superpowers/results/2026-06-24-chunk-bm25-squad-generalization.md`
- No `src/` changes.

## Open questions for the plan

1. **Sample size / which split:** train-v1.1 (~442 articles, ~87k questions) sampled to ~1–2k queries vs dev-v1.1 (~48 articles — too few docs, retrieval too easy). Lean train split for a non-trivial pool.
2. **Optional hybrid sanity arm:** also run default weights (0.5/0.5) to see if the lexical effect survives the vector half — cheap, but the headline is lexical. Decide in the plan (default: lexical-only headline, hybrid optional).
3. **Chunk-count vs article length:** confirm SQuAD articles exceed `CHUNK_MAX_CHARS=800` per article comfortably (they do — multi-paragraph) so chunks-per-doc ≫ 1.
