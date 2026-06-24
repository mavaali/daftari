# Spec — Chunk-level BM25 in `hybrid.ts` (lossless granularity lever)

**Date:** 2026-06-24
**Status:** Design approved, pre-implementation
**Motivating result:** `docs/superpowers/results/2026-06-23-atomization-granularity-measurement.md`
**Handoff:** `docs/superpowers/handoffs/2026-06-23-chunk-level-bm25-pickup.md`

## Problem

Stage A (atomization granularity) established three things on Recall Bench multi-day
questions (n=979), deployment-grounded recall@top-K, day-coverage:

| | K=10 | K=20 | K=50 |
|---|---|---|---|
| DAY hybrid | 0.221 | 0.359 | 0.627 |
| ATOM hybrid | 0.286 | 0.430 | 0.683 |
| DAY lexical | 0.181 | 0.281 | 0.528 ← worst |
| ATOM lexical | 0.286 | 0.418 | 0.711 ← best |

1. **Granularity helps** retrieval recall — modestly, +6.5pp @K=10 → +18pp @K=50.
2. **The benefit is lexical.** `DAY lexical` is the worst arm, `ATOM lexical` the best.
   Whole-document BM25 (`ftsRanking` over `documents_fts`) scores the *whole* multi-topic
   day, diluting the one relevant topic. The vector half is already per-chunk (KNN over
   `embeddings_vec`, collapse to best-per-doc), so it adds nothing to atoms.
3. The lossless realization is **chunk-level BM25 in `hybrid.ts`** — score the lexical half
   per-chunk and collapse to best-chunk-per-document, mirroring what the vector half already
   does. A relevant topic's own chunk scores high; its document inherits that score instead
   of the diluted whole-doc score. **Ranker change, not an ingest pipeline** — the document
   stays whole on disk; no atomization, no source rewrite, no `###` structure required
   (chunking is content-based, so the win is chunking-general).

The honest expected gain is **+6–18pp recall (growing with K)**, not the inflated "6×" from
the char-budget metric (a full-doc-feeding density artifact). Worth a prototype; not a silver
bullet.

## Goal

Prove the +6–18pp lift transfers to a lossless ranker change on *whole* documents, measured
the same way (recall@top-K, day-coverage, lexical) as Stage A. Ship it behind a flag so
production search is unchanged until the measurement justifies a default switch.

## Non-goals (YAGNI)

- **Chunk-level snippet *return*.** `vault_search` keeps returning the existing 140-char
  doc-centred snippet. Whether feeding chunk-snippets vs day-snippets changes downstream
  *answer* quality is a separate, untested LLM-arm experiment (Stage A "Honest Assessment"
  caveat 3).
- **Chunk granularity for `relatedSearch`.** Stays document-level this pass.
- **Score blending** (whole-doc BM25 + best-chunk BM25). Rejected during brainstorm — adds a
  tuning knob and muddies the clean chunk-vs-doc attribution the experiment needs.
- **`sum`/`mean` collapse in production.** `max` (best-chunk-per-doc) ships; `sum` is a
  harness-only sanity variant.
- **Making chunk the default.** Deferred — a later decision gated on this measurement.

## Design

### Decision: gating

Approved approach — **option flag, default OFF.** `hybridSearch` gains a
`lexicalGranularity: "document" | "chunk"` option defaulting to `"document"`. Production
search and `relatedSearch` are byte-for-byte unchanged; the harness drives all three arms
(whole-doc lexical / chunk lexical / atom-lexical upper bound). This enables clean A/B,
keeps the whole-doc baseline available, and defers the prod-default decision until measured.

Alternatives considered and rejected: **replace outright** (changes prod before it's
measured, loses the baseline arm); **blend both scores** (extra knob, muddies attribution).

### Component 1 — Schema (`src/storage/index-db.ts`)

Add a `chunks_fts` FTS5 external-content virtual table over `chunks.text`, mirroring the
existing `documents_fts` pattern:

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='rowid',
  tokenize='porter unicode61'
);
CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
END;
CREATE TRIGGER chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.rowid, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.rowid, new.text);
END;
```

- `content='chunks'` is the same contentless external-content link `documents_fts` uses — the
  FTS index stores tokens, not a second copy of the chunk text.
- `content_rowid='rowid'` references the `chunks` table's implicit integer rowid (the table's
  PK is the composite `(path, chunk_index)`, so the implicit rowid is the join key). The
  write path uses `INSERT OR REPLACE` (fires DELETE then INSERT triggers on conflict) and
  `DELETE ... WHERE path = ?`; the AI/AD/AU triggers cover all three, so the FTS index never
  drifts. The `chunks_fts.rowid` ↔ `chunks.rowid` correspondence is what the ranker joins on.
- Same `porter unicode61` tokenizer as `documents_fts` so chunk and document BM25 scores are
  on a comparable scale.
- **Where it's created:** `chunks_fts` must be created in the same place the schema/FTS is
  set up, and added to the version-mismatch drop+recreate set (alongside `documents_fts`,
  `embeddings_vec`, `chunks`).

**Migration:** bump `SCHEMA_VERSION` 5 → 6. The existing version-mismatch path drops the
derived tables and forces a full reindex; `reindex` re-writes every chunk, and the new
triggers repopulate `chunks_fts` in lockstep. The `.daftari/index.db` is ephemeral
(rebuildable from the markdown source at any time), so there is **no data migration** — only
a version bump plus the existing reindex. No need to manually `'rebuild'` the FTS because the
reindex re-inserts all chunk rows through the triggers.

### Component 2 — Ranker (`src/search/hybrid.ts`)

New `chunkFtsRanking(db, query)` — structurally the merge of `ftsRanking` (sign-flip
`-bm25()`, only-positive guard) and `vecRanking` (collapse-to-best-per-document via `max`):

```sql
SELECT c.path AS path, -bm25(chunks_fts) AS score
  FROM chunks_fts
  JOIN chunks AS c ON c.rowid = chunks_fts.rowid
 WHERE chunks_fts MATCH ?
 ORDER BY bm25(chunks_fts)
```

Collapse to `path → max(score)` (best-chunk-per-document), keeping only positive flipped
scores, exactly as `ftsRanking` does. Returns the same `Map<string, number>` shape, so the
caller is agnostic to which ranker produced it.

`rankDocuments` gains `lexicalGranularity: "document" | "chunk"` in its options and selects:

```ts
const bm25Raw = opts.lexicalGranularity === "chunk"
  ? chunkFtsRanking(db, matchQuery)
  : ftsRanking(db, matchQuery);
```

Everything downstream is **untouched**: `normalize`, the `vectorUsed` weighting fallback, the
candidate union, the weight mix, decay, snippet generation, sort, slice.

`HybridSearchOptions` gains `lexicalGranularity?: "document" | "chunk"` (default `"document"`).
`hybridSearch` threads it into `rankDocuments`. `relatedSearch` passes `"document"` (out of
scope this pass).

### Collapse function

`max` (best-chunk-per-document) ships — it mirrors `vecRanking` and matches the premise ("a
relevant topic's *own* chunk scores high"). The harness additionally tries `sum` as a
sanity variant to confirm `max` is the right collapse; `sum` does not ship to production.

## Measurement (`integrations/recall-bench/`)

Reuse the Stage A harness and verdict criterion. Add a **third arm over the day-vault**:

- **Arm A (baseline):** day-vault, `lexicalGranularity:"document"`, `{bm25:1, vector:0}` —
  today's whole-doc BM25.
- **Arm B (new):** day-vault, `lexicalGranularity:"chunk"`, `{bm25:1, vector:0}` — the
  prototype.
- **Arm C (upper bound):** atom-vault, lexical — the physically-atomized ceiling from Stage A.

**Metric:** recall@top-K (K=10/20/50), day-coverage, multi-day questions (`relLen > 1`),
`$0`, no LLM. The committed `granularity-runner.mjs` computes char-budget recall via
`fillDays`; the verdict table is **recall@top-K**, so add an explicit top-K computation
(`hits.slice(0, K)` mapped to days via the `day-(\d+)` path regex) rather than reusing
`fillDays`. Confirm `vectorUsed` is pinned consistent across arms (the harness already throws
if it flips).

**Success criterion:** Arm B (day-chunk) recovers **most of the +6–18pp gap** between Arm A
(day-doc, the floor) and Arm C (atom, the ceiling) **without physically atomizing** — proving
the lossless ranker change captures the granularity benefit.

**Vault/fixtures (all ephemeral `/tmp`):** day-vault `/tmp/cov-recall/vault` (`prep-vault.mjs`
if gone), atom-vault `/tmp/cov-recall/atom-vault` (`atomize-vault.mjs`), questions
`integrations/recall-bench/results/ea-180d-partial-2026-06-21/questions.jsonl`, RB corpus
`/tmp/recall-review/...memories-180d` (re-clone `Stevenic/recall` if gone). The harness drives
the **real** index (`hybridSearch` + `openIndexForActiveProvider` against built `dist/`), so
the prototype must be built (`npm run build`) before measuring, and the day-vault reindexed
under SCHEMA_VERSION 6 so `chunks_fts` exists.

## Testing

Tests mirror `src/` structure (project convention); `Result` patterns, no throws from
handlers.

- **`test/search/hybrid.test.ts`** — ranker unit tests:
  - A multi-topic document whose relevant term lives in *one* chunk, vs a competitor where the
    term is diluted/absent: assert `lexicalGranularity:"chunk"` ranks the right document above
    the order produced by `"document"` (demonstrates the dilution fix).
  - Default option (`undefined`/`"document"`) reproduces today's `ftsRanking` ordering exactly
    (no-regression).
  - Degrade-to-empty: a query with no chunk match yields an empty lexical map and the search
    falls back to vector/empty without error.
- **`test/storage/index-db.test.ts`** (or sibling) — schema/sync:
  - `chunks_fts` exists at SCHEMA_VERSION 6; reindex populates it.
  - Edit/replace a document's chunks → `chunks_fts` rows track via triggers (no drift, no
    orphans after a doc shrinks).

## Error handling / degradation

`chunkFtsRanking` on no-match or FTS error returns an empty map → `normalize` → lexical
contributes 0, identical to the existing `ftsRanking` degrade path. With
`lexicalGranularity` unset, behavior is byte-for-byte today's, so the risk surface is limited
to callers that explicitly opt in (the harness, and any future prod switch).

## Files touched

- `src/storage/index-db.ts` — `chunks_fts` table + triggers, SCHEMA_VERSION 5→6, add to
  drop+recreate set.
- `src/search/hybrid.ts` — `chunkFtsRanking`, `lexicalGranularity` option threaded through
  `rankDocuments` / `HybridSearchOptions` / `hybridSearch`.
- `integrations/recall-bench/granularity-runner.mjs` (or a sibling `chunkbm25-runner.mjs`) —
  third arm + top-K metric.
- `test/search/hybrid.test.ts`, `test/storage/index-db.test.ts` — new cases.

## Open questions resolved in brainstorm

1. **Worth a ranker change?** Yes for a measured prototype; the gain grows with K (deep
   retrieval benefits most). Framed as real-but-modest, not a silver bullet.
2. **Return contract:** scoring-only. Chunk-snippet return is out of scope (separate
   experiment).
3. **Index cost:** accepted. `chunks_fts` multiplies FTS rows by mean-chunks-per-doc — the
   `embeddings_vec` table already pays this per-chunk cost.
4. **Collapse function:** `max` (best-chunk-per-doc) ships; `sum` is a harness-only variant.

## Kill condition

If Arm B (day-chunk) fails to recover a meaningful fraction of the Arm A → Arm C gap — i.e.
chunk-level BM25 on whole documents lands at or near the diluted whole-doc floor rather than
climbing toward the atom ceiling — the lossless ranker hypothesis is falsified for this corpus
and chunk-BM25 should not become a default; the granularity benefit would then require
something the ranker alone can't deliver (revisit atomization/return-contract).
