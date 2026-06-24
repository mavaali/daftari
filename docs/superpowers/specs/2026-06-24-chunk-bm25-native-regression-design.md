# Spec — Chunk-BM25 native-shape regression check (quantify title/tag blindness)

**Date:** 2026-06-24
**Status:** Design approved, pre-implementation
**Context:** Follows the merged chunk-level BM25 ranker (PR #155). That ranker is opt-in (`lexicalGranularity:"chunk"`, default `"document"`); this experiment gates whether it is safe to ever make `"chunk"` the default lexical path on **native-daftari-shaped vaults** (one-fact-per-file, single-topic, short docs).
**Related:** [[project_recall_bench_experiment]] (Stage B = the chunk-BM25 win on RB), `docs/superpowers/results/2026-06-24-chunk-bm25-measurement.md`.

## Problem

The chunk-BM25 win (Stage B) was measured **only on Recall Bench** — long multi-topic daily journals, where whole-doc BM25 dilutes the relevant topic. daftari's **native** model is the opposite shape: one fact per file, single-topic, short. On that shape the dilution mechanism does nothing — but a **code-confirmed asymmetry** creates a *regression* risk:

- `documents_fts` indexes `(title, tags, content_body)` (index-db.ts:183-184).
- `chunks_fts` indexes only chunk text, and chunks come from the **body only**: `const body = parsed.value.content` → `chunkText(body)` (reindex.ts:261-266). Title and tags are never in any chunk.

⇒ **chunk-BM25 is structurally blind to title/tag matches.** A query whose only discriminating term lives in the title or tags gets a hit from document-BM25 but **zero** from chunk-BM25. On native vaults, where the title is typically the canonical handle for the fact, this is a real regression vector.

**The regression's existence is already proven by inspection.** This experiment does not discover *whether* it exists — it **quantifies magnitude** (how much native retrieval leans on title/tag-only terms) and **confirms body-query parity** (that the common case is safe). Both magnitudes are genuinely unknown and decision-relevant: they determine whether a default flip needs a title/tag fix and how urgent it is.

## Goal

Produce a per-query-type number — hit@1 and recall@5 for document- vs chunk-granularity lexical ranking on a synthetic native-shape vault, broken down by **body-only / title-only / tag-only** queries — that quantifies the title/tag regression and confirms body parity. `$0`, no LLM. This is the **"quick quantify"** half of a quantify-then-fix decomposition; the fix is a **separate follow-on brainstorm** informed by this number.

## Non-goals (YAGNI)

- **The fix itself.** Title/tag-aware chunk-BM25 (e.g. a title+tags pseudo-chunk, or union-with-document-BM25) is the *next* cycle, designed once this number is in. Not here.
- **LLM / answer-quality.** Recall@k only; no answerer.
- **Multi-topic corpora.** Whether the *win* replicates on a non-RB multi-topic corpus is the separate "Q1" question, not this.
- **Naturalistic queries.** Queries are programmatic term-targeted probes, not LLM-generated natural language. For a structural regression check this is adequate and is what keeps it `$0` (see Honest Assessment).
- **Changing any production code.** This is a measurement harness over the existing opt-in ranker; `src/` is untouched.

## Design

### Component 1 — Synthetic native vault generator (`integrations/recall-bench/gen-native-vault.mjs`)

Builds a native-daftari-shape vault, deterministically (no LLM, no randomness that breaks reproducibility — if any variation is needed, derive it from the doc index, not `Math.random()`).

- **~80–100 docs**, one per distinct entity. Each doc:
  - frontmatter `title` naming one entity with a **unique title-only token** (e.g. `title: "Project Zephyrine Q3 budget"` where `zephyrine` appears in NO body),
  - 2–3 `tags`, one of which is a **unique tag-only token** (appears nowhere else),
  - a 1–3 sentence body restating the fact, containing a **unique body-only token**.
  - Total < 800 chars so `chunkText` yields exactly **one chunk** (assert this in the runner — the native single-chunk case is the premise).
  - **Complete, valid daftari frontmatter.** Required fields (from `validateFrontmatter`; confirm against a `test/fixtures/sample-vault` doc): `title`, `domain` (enum), `collection`, `status` (enum), `confidence` (enum), `created` (date), `updated` (date), `updated_by`, `provenance` (enum), plus `tags`. **Important failure mode (corrected):** docs with *invalid* frontmatter are NOT silently skipped — `reindex` indexes them with **fallback defaults applied** (`status:draft`, `confidence:low`, etc.) and an **empty title** would silently pollute the title-arm BM25. So the generator must emit fully valid frontmatter, and the runner must assert it (see Component 2 guard).
- Writes the vault to an ephemeral `/tmp` path (e.g. `/tmp/native-regression/vault`).
- Emits a **labeled query JSONL** alongside: for each doc, three rows `{ id, type: "body"|"title"|"tag", query: <the unique token>, relevantPath: <doc path> }`. The unique-token construction guarantees exactly one correct doc per query (clean ground truth).

### Component 2 — Regression runner (`integrations/recall-bench/native-regression-runner.mjs`)

Mirrors the existing recall-bench runners (`chunkbm25-runner.mjs` as the template): open the vault index via `openIndexForActiveProvider`, drive `hybridSearch`.

- For each labeled query, run **two arms**, lexical-only (`weights:{bm25:1, vector:0}`):
  - document: `lexicalGranularity:"document"`
  - chunk: `lexicalGranularity:"chunk"`
- **Guards (fail loudly — the experiment is invalid otherwise):**
  - assert `vectorUsed === false` on every call (lexical purity — same guard the chunk-BM25 runner uses);
  - assert each doc produced exactly 1 chunk (the native single-chunk premise) — if any doc multi-chunks, the generator is wrong;
  - assert the reindex reported **zero `invalidFrontmatter` and zero `skipped`** docs (so no fallback defaults / empty titles silently distort the title-arm — see `ReindexResult`).
- **Metrics** per arm, **grouped by query type** (body / title / tag) and overall:
  - **hit@1**: fraction where `hits[0].path === relevantPath`.
  - **recall@5**: fraction where `relevantPath ∈ hits[0..4]`.
- Write per-query JSON + a summary JSON; print the summary.

### Reuse, not rebuild

Do not modify `chunkbm25-runner.mjs` or `granularity-runner.mjs`. Reuse from the sibling **only the import/open pattern** (`dist/search/hybrid.js`, `dist/tools/search.js`, `openIndexForActiveProvider`, the `vectorUsed` guard) — **do NOT** copy its `daysAtK`/`recall` helpers, which are RB date-window-specific. This runner's metrics are simple **path-equality** (`hits[0].path === relevantPath`, and `relevantPath ∈ hits[0..4]`). The vault index must be built at the current `SCHEMA_VERSION` (so `chunks_fts` exists) — reindex the generated vault before running.

## Predicted result (state up front, per Tenet 1)

- **body-only:** document ≈ chunk (parity) — single-chunk docs, body term present in the one chunk; small differences possible from the title/tags being in `documents_fts` only and avgdl corpus differences, but recall should be ~equal. **This is the safety-confirming case.**
- **title-only / tag-only:** chunk-arm hit@1/recall@5 collapse toward **0** (chunk-BM25 cannot match a term absent from all chunk text), document-arm stays high. **This is the regression, quantified.**
- **Headline number wanted:** the size of the chunk-arm drop on title/tag queries = the cost of a naive default flip; and the body-only parity = evidence the common case is safe.

## Success / interpretation

This is a measurement, not a pass/fail feature. "Success" = a **clean, interpretable per-type table** that supports a verdict:

- If body parity holds AND title/tag dependence is **small** in realistic native vaults → the regression is narrow; a default flip might be acceptable with a documented caveat.
- If title/tag dependence is **large** (likely, given native titles carry the fact) → chunk-BM25 is **not safe** as a blanket default without a title/tag fix → motivates the follow-on fix brainstorm.

**Kill condition for the experiment's validity (not the hypothesis):** if generated docs multi-chunk, or any doc fails to index (silently skipped), or `vectorUsed` is true, the numbers are invalid — the runner must assert all three and fail loudly rather than report a misleading table.

## Honest Assessment (to live in the results doc)

- **What it shows:** the magnitude of chunk-BM25's title/tag blindness on a controlled native-shape corpus, and whether body queries are safe.
- **What it does NOT show:** (1) **Synthetic corpus** — programmatic term-targeted queries are an upper bound on title/tag isolation; real native vaults restate the title token in the body more often than this corpus does, so the measured title/tag regression is likely a **worst case**, not the expected case. State this explicitly. (2) Says nothing about the multi-topic *win* (Q1). (3) recall@k, not answer quality.
- This worst-case framing is a feature for a *safety* check: if even the worst case is tolerable, the flip is safe; if the worst case is severe, we learn the fix is mandatory and the follow-on is justified.

## Files

- Create: `integrations/recall-bench/gen-native-vault.mjs`
- Create: `integrations/recall-bench/native-regression-runner.mjs`
- Create (output): `docs/superpowers/results/2026-06-24-chunk-bm25-native-regression.md`
- No `src/` changes.

## Decomposition note

This is cycle 1 of 2 ("quick quantify, then fix"). Cycle 2 (the fix) gets its own brainstorm → spec → plan after this result lands, and will weigh: title+tags **pseudo-chunk** injected into `chunks_fts` (preserves the granularity win, restores title/tag matchability, +1 FTS row/doc) vs **union** chunk-BM25 with document-BM25 (simpler, but reintroduces whole-doc dilution). The choice should be informed by this experiment's magnitude.
