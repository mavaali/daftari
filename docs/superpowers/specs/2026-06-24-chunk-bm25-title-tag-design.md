# Spec — Title/tag-aware chunk-BM25 (column-restricted union)

**Date:** 2026-06-24
**Status:** Design approved, pre-implementation
**Context:** Cycle 2 of "quantify, then fix". Cycle 1 (PR #156, `docs/superpowers/results/2026-06-24-chunk-bm25-native-regression.md`) proved the opt-in chunk-level BM25 ranker (PR #155) is **title/tag-blind**: native-shape title/tag-only retrieval drops to **0.0 hit@1** (vs document's 1.0) because `chunks_fts` indexes body text only. This closes that gap so chunk mode is a complete lossless ranker.
**Related:** [[project_recall_bench_experiment]].

## Problem

`chunks_fts` is built from `chunkText(parsed.value.content)` — **body only** (reindex.ts:261-266) — while `documents_fts` indexes `(title, tags, content_body)` as separate columns (index-db.ts:183-184). So `chunkFtsRanking` (hybrid.ts:173) cannot match a token living only in a title or tag. On daftari's native one-fact-per-file model, where the title is the canonical handle for a fact, this is a total regression on title/tag-only retrieval (cycle-1 measurement: 0.0 hit@1). chunk mode must match title/tag terms before it could ever become the default lexical path.

## Goal

In chunk mode (`lexicalGranularity:"chunk"`), give the lexical signal a clean path to title/tag matches **without** reintroducing whole-document dilution, **without** any schema/reindex change, and **without** touching the production default (`"document"`) or `relatedSearch`.

## Approach (selected)

**Column-restricted title/tag union.** `documents_fts` already exposes `title` and `tags` as separate FTS5 columns, so a column-restricted match `'{title tags} : (<tokens>)'` yields a title/tag-only BM25 score with **no body content** in it (verified against the SQLite/FTS5 build: `{title tags} : titletok042*` returns the doc; `{title tags} : bodytok042*` returns empty). In chunk mode the lexical signal **tiers** the two independently-normalized signals: chunk-body matches occupy an upper score band and title/tag-only matches a lower one, so a body match always outranks a title-only match (see Component 2 — this replaces an earlier de-weighted-max combine that failed the RB win gate).

Rejected alternatives (recorded): **pseudo-chunk** — inject a title+tags row into `chunks_fts`; but `chunks` is shared with the embeddings/vector half, so the pseudo-chunk would also be embedded and pollute vector ranking unless specially excluded → schema + reindex + embedding-skip plumbing, more surface and risk. **Naive union with whole-document BM25** — `max(chunk-body, ftsRanking)`; the whole-doc component reintroduces exactly the multi-topic dilution noise the chunk ranker removed (a diluted body match can tie a clean chunk match). Approach D is strictly better at the same complexity.

## Design

### Change surface

`src/search/hybrid.ts` **only**. No change to `index-db.ts`, `reindex.ts`, schema, or `SCHEMA_VERSION`. `relatedSearch` stays `"document"`. `"document"` mode is byte-for-byte unchanged — this completes the opt-in `"chunk"` path exclusively.

### Component 1 — `titleTagRanking(db, matchQuery)`

A sibling of `chunkFtsRanking`/`ftsRanking`. Wraps the existing prefix-OR'd token string in an FTS5 **column filter** and runs it against `documents_fts`:

```sql
SELECT d.path AS path, -bm25(documents_fts) AS score
  FROM documents_fts
  JOIN documents AS d ON d.rowid = documents_fts.rowid
 WHERE documents_fts MATCH ?      -- the column-restricted match string
 ORDER BY bm25(documents_fts)
```

- The match string is built by a tiny helper: `columnRestrict(matchQuery, "{title tags}")` → `matchQuery ? `{title tags} : (${matchQuery})` : null`. `matchQuery` is the SAME prefix-OR'd string the other rankers receive (e.g. `t1* OR t2*`), so no new tokenization.
- `null` match (no usable tokens) → empty map (degrade, identical to the others).
- Sign-flip `-bm25()`, drop non-positive, collapse path→best (max), exactly mirroring the other two rankers.

Note the column is named `content_body` in `documents_fts` (distinct from the `documents.content` table column); `{title tags}` excludes it. The existing `ftsRanking` matches all three columns unrestricted; this restricts to the first two.

> **Revision (2026-06-24, after a failed validation run).** An earlier version of this spec combined the two signals by `max(chunkNorm, TITLE_TAG_WEIGHT × titleTagNorm)` with a de-weight constant (0.99). It **failed the RB win gate** (gapRecovered K=20 0.996→0.869, K=50 0.880→0.733 — kill condition tripped). Root cause: the assumption that "RB titles are non-topical" was **false** — RB day titles are `daily log <date>`, so common tokens (`daily`, `log`, date numerals) match queries; `normalize()` inflates a wrong day's title match to 1.0, and `0.99` beats the right day's *fractional* chunk score (0.5–0.9). The lesson: a single global weight cannot satisfy both corpora (native wants it high, RB wants it low). The combine below replaces it with a **tiered band split** that separates body and title-only matches structurally, with no tunable weight.

### Component 2 — `tieredLexical(chunkNorm, titleTagNorm)`

A tiered combine: a document with **any** chunk-body match ranks in an upper band, ordered by body score; a document matched **only** via title/tags ranks in a lower band, ordered by title/tag score. Body always outranks title-only **by construction** (the band boundary), so there is no weight to tune.

```ts
const TIER_SPLIT = 0.5; // band boundary: body matches occupy (0.5, 1],
// title-only matches occupy (0, 0.5]. Body always outranks title-only.
function tieredLexical(
  chunkNorm: Map<string, number>,   // normalized chunk-body scores (all > 0)
  titleTagNorm: Map<string, number>, // normalized title/tag scores (all > 0)
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [p, c] of chunkNorm) out.set(p, TIER_SPLIT + (1 - TIER_SPLIT) * c); // upper band
  for (const [p, t] of titleTagNorm) {
    if (out.has(p)) continue;             // already body-matched → stays upper band
    out.set(p, TIER_SPLIT * t);           // lower band (title-only)
  }
  return out;
}
```

`chunkFtsRanking` and `ftsRanking` only store positive scores and `normalize` divides by the max, so every entry is in `(0, 1]` (no zeros). Therefore "has a body match" ≡ "is a key in `chunkNorm`", and a body score `c > 0` ⇒ upper-band score `> 0.5`, while a title-only score is `≤ 0.5` — strict separation. A doc matched in both is body-matched and keeps its upper-band (body) score; its title contribution is dropped (body is primary). The earlier single-match-inflation worry is moot: an inflated title-only `1.0` maps to exactly `0.5`, still below every body match.

### Component 3 — combine in `rankDocuments`

Today (hybrid.ts:224-237):

```ts
const bm25Raw = opts.lexicalGranularity === "chunk" ? chunkFtsRanking(...) : ftsRanking(...);
// ...
const bm25Norm = normalize(bm25Raw);
```

Becomes:

```ts
let bm25Norm: Map<string, number>;
if (opts.lexicalGranularity === "chunk") {
  // Chunk mode: body granularity (the dilution fix) TIERED with a clean
  // title/tag signal (the native-shape fix). Each is normalized to its own
  // max to reconcile the two FTS score scales, then combined so a body match
  // always outranks a title-only match — body is primary, title/tag is a
  // strict fallback that only orders docs the body ranker missed entirely.
  const chunkNorm = normalize(chunkFtsRanking(db, matchQuery));
  const titleTagNorm = normalize(ftsRanking(db, columnRestrict(matchQuery, "{title tags}")));
  bm25Norm = tieredLexical(chunkNorm, titleTagNorm);
} else {
  bm25Norm = normalize(ftsRanking(db, matchQuery));
}
```

(The title/tag signal reuses `ftsRanking` with a column-restricted query — no separate ranker needed. The invariant: normalize-each, then `tieredLexical`, chunk mode only.) Everything downstream — the `vectorUsed` weighting fallback, the candidate union, the weight mix, decay, snippet, sort, slice — is untouched.

**Precondition (load-bearing).** The tiering only helps a query whose correct answer has a **chunk-body match**. In RB the right day's body contains the query terms, so it lands in the upper band — that is *why* tiering preserves the win. If a future corpus had the correct answer reachable *only* via title/tag (no body match at all), tiering gives it no advantage and the body-vs-title-only distinction collapses. The kill condition's re-validation is what verifies this precondition holds on RB.

### Why tiered, why normalize-first

The two maps are signals on **different FTS corpora** (chunk avgdl vs document avgdl), so raw scores aren't comparable — each is normalized to [0,1] first. The combine is **tiered, not a numeric blend**, because the two signals have different *trust*: a body match is direct evidence the query is about that document; a title/tag match is weak evidence that `normalize` can inflate (a common title token → 1.0). A blend (max or weighted) lets an inflated title match compete with a real body match — exactly what failed on RB. Tiering removes the competition entirely.

- **Multi-topic win case (RB):** the right day has a body match → upper band; a wrong day matched only on a common title token (`daily`/`log`/date) → lower band → cannot displace it → **the +6–18pp win is preserved**.
- **Native title/tag case:** a title-only query has no body match for any doc → all candidates in the lower band → the true doc wins on title/tag score → **gap closed**.
- **Pure body query:** title/tag map adds only docs already body-matched (skipped) or none → result is the chunk ranking, monotonically rescaled into `(0.5, 1]` (order unchanged) → no regression.

## Testing

### Unit (`test/search/hybrid.test.ts`)

- **Title-only fix:** a doc whose discriminating term appears only in the title; assert chunk mode now ranks it first (was 0 before). A tag-only variant.
- **Dilution preserved:** the existing chunk-granularity dilution test must still pass (multi-topic body granularity unchanged).
- **Body-query no-op (order preserved):** a pure-body query returns the same chunk-mode *ordering* as before (the title/tag map adds nothing; the upper-band rescale `0.5 + 0.5×c` is monotonic so ranking is unchanged).
- **Tier separation (body wins):** doc A has the query term strongly in its body (the true answer, upper band); doc B has the same term only in its title (coincidental, lower band). Assert chunk mode ranks **A first** (the band split puts B below A by construction) — and that B is still *retrieved* (the title match is a lower tier, not dropped).

### Validation via the two existing harnesses (the regression + win gates)

After `npm run build` and reindexing the ephemeral vaults at the current schema:

1. `integrations/recall-bench/native-regression-runner.mjs` → chunk **title/tag hit@1 must jump 0.0 → 1.0** (fix confirmed), body stays 1.0, document arm unchanged.
2. `integrations/recall-bench/chunkbm25-runner.mjs` → the RB day→atom **gap recovery must be preserved** (≈ the prior 53%/99.6%/88% within noise) — proving the title/tag union does not hurt the multi-topic win.

Record both in a short results note (`docs/superpowers/results/2026-06-24-chunk-bm25-title-tag.md`).

## Error handling / degradation

The title/tag match (`ftsRanking` with a column-restricted query) on null/empty/no-match returns an empty map → `tieredLexical` adds no lower-band entries → chunk mode is the body ranking alone (rescaled). With `lexicalGranularity` unset, nothing changes (default `"document"`). Risk surface is limited to explicit `"chunk"` callers (tests + the two harnesses); production search is untouched.

## Files

- Modify: `src/search/hybrid.ts` — add `tieredLexical` + `TIER_SPLIT`, keep `columnRestrict`, rewrite the `rankDocuments` chunk-mode branch (title/tag signal reuses `ftsRanking`). **Remove the failed-combine dead code:** `TITLE_TAG_WEIGHT`, `scale`, and `unionMax` from the prior commit are no longer used — delete them.
- Modify: `test/search/hybrid.test.ts` (title-only / tag-only fix, dilution-preserved, body no-op order, tier separation).
- Create: `docs/superpowers/results/2026-06-24-chunk-bm25-title-tag.md` (validation run).
- No `src/storage` / schema / reindex changes.

## Out of scope (YAGNI)

- Flipping `"chunk"` to the default — still gated; this *un*blocks the title/tag axis but the multi-topic generalizability (Q1) and answer-quality questions remain.
- Applying the tiered combine to `"document"` mode or `relatedSearch`.
- `bm25()` per-column weights, sub-tiering within a band, or making `TIER_SPLIT` anything other than a structural band boundary (it is not a tuned blend weight — any value in `(0,1)` gives the same strict body-over-title ordering; `0.5` is the natural choice).

## Kill condition

If validation shows the tiered combine **measurably degrades the RB multi-topic win** (gap recovery drops materially below the prior 53/99.6/88), then even a strict body-over-title tiering interferes (which would be surprising — the right day is body-matched in RB) and the approach needs rethinking. The native title/tag hit@1 must reach ≈1.0 *and* the RB win must hold — both, or the fix isn't done. (The prior de-weight design already failed this gate; the tiered combine exists specifically to pass it — re-validation is mandatory, not a formality.)
