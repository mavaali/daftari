# Retrieval fusion overhaul — design

2026-07-26. Status: **proposed — awaiting Mihir's review; implementation not
started.**
Companions (same date, deliberately separate): the reranker stage and
chunk-header work live in `2026-07-26-contextual-chunking-reranker-design.md`;
the embedding-model change has its own spec. This document is the ranking
spine only: how the two rankers are fused, when each gets weight, and what
the vector scan is allowed to see.

## Why

Three coupled weaknesses in `src/search/hybrid.ts`, all in the fusion layer
rather than in either ranker.

**What exists today.** `rankDocuments` runs two rankers: chunk-level FTS5
BM25 (`chunkFtsRanking`, best-chunk-per-doc, tiered with a column-restricted
title/tag pass — the 2026-06-24 chunk-BM25 spec, now the default) and a
sqlite-vec KNN over `embeddings_vec` (`vecRanking`, `k = VEC_KNN_K = 64`
chunks, collapsed to best-per-doc as `1 − distance`). Each ranker's map is
then passed through `normalize()` — divide every score by that ranker's own
top score so the best hit becomes 1.0 — and the two normalized maps are
mixed as a weighted sum, `HybridWeights` defaulting to `{bm25: 0.5, vector:
0.5}`. RBAC happens after ranking: `hybridSearch(…, {overFetch: true})`
returns every candidate, and `src/tools/search.ts` filters with
`canRead(access.role, h.collection)` before slicing to the user-facing limit.

**Weakness 1 — per-ranker max-normalization is the documented fragile
pattern.** Dividing by each list's own top score makes every score relative
to an arbitrary anchor: one outlier lexical hit crushes the rest of the
lexical list toward zero while a flat vector list saturates near 1.0, and
the 0.5/0.5 mix silently becomes whatever the two anchors made it. This is
exactly the failure mode the 2026 hybrid-search literature converged
against. Reciprocal Rank Fusion over rank lists (k = 60) is the current
default in OpenSearch, Weaviate, and Azure AI Search; reported hybrid
recall@10 for RRF fusion is ~91% against 65–78% for either method alone.
Rank fusion discards score magnitudes by design — that is the trade, and the
recall numbers say it is the right one.

**Weakness 2 — one static weight pair for every query shape.** Identifier
and exact-name queries (`processTensionDocket`, `config.yaml`, a ticket
number) are lexical queries; paraphrase questions are semantic. Supermemory's
April 2026 study measured BM25 alone retrieving ~70% of relevant docs on
identifier/exact-name queries where dense retrieval got ~5% — and fusion
still beat BM25 alone by +7 to +17.4pp across query categories. A fixed
0.5/0.5 leaves both wins on the table. Daftari's vault content is dense with
identifiers (paths, tool names, frontmatter keys), so this is our common
case, not a corner.

**Weakness 3 — a real recall bug for restricted roles.** `vecRanking` asks
sqlite-vec for the 64 nearest chunks *vault-wide*, and the readable-
collection filter runs afterward, in the tool handler. A role that can read
2 of 20 collections can have its entire K=64 budget consumed by unreadable
chunks and post-filtered to near-zero: the vector half of hybrid search goes
dark precisely for the users RBAC exists for. The lexical half is unaffected
(FTS returns all matches, no K budget) — this is a vector-only starvation
bug, and it is invisible in unrestricted benchmarks.

## Decision 1 — RRF over rank lists, tier folded into list construction

Replace `normalize()` + weighted sum with Reciprocal Rank Fusion:

```
score(d) = w_bm25 · 1/(k + rank_lex(d)) + w_vector · 1/(k + rank_vec(d))
```

with `k = 60` (the literature's default; not a tuning surface) and ranks
1-based within each list; a document absent from a list contributes 0 from
it. `HybridWeights` survives verbatim as the per-list RRF weights — the
config surface (`parseWeights` on `vault_search`'s `weights` arg) and the
`vectorUsed → {bm25: 1, vector: 0}` degrade path are unchanged. At the
default 0.5/0.5 this is plain RRF scaled by a constant, so the default
ordering is textbook RRF.

**The tiered-band interaction, analyzed.** The chunk-BM25 tier (architecture
doc: body matches score in (0.5, 1], title/tag-only in (0, 0.5], disjoint by
construction) guarantees that every body match outranks every title-only
match. Two observations settle where that invariant lives:

1. It is a *lexical-list* invariant, not a final-ranking invariant. Under
   today's weighted sum, the vector component can already lift a title-only
   document above a body-matched one in the fused score (0.5·0.3 + 0.5·0.9
   beats 0.5·0.6 + 0.5·0.1). The bands constrain the lexical signal;
   fusion has always been allowed to interleave.
2. RRF consumes orderings, not magnitudes — and the tiered map *is* an
   ordering. `tieredLexical`'s output is strict and tie-free (upper band
   strictly above lower band), so sorting it yields one lexical rank list in
   which all body matches precede all title-only matches.

Therefore: **fold the tier into rank-list construction.** The lexical rank
list is the sorted output of the existing `tieredLexical(chunkNorm,
titleTagNorm)` pipeline — the per-half `normalize()` calls survive *inside*
lexical, where they only ever compare a ranker against itself and exist to
reconcile the two FTS score scales before banding; what dies is cross-ranker
score normalization. RRF then fuses that one lexical list with the vector
list. The band invariant is preserved at exactly the layer it holds today,
byte-for-byte in semantics.

The alternative — run RRF within body-band candidates and append the
title-band below — is **rejected**: it would *promote* the invariant to the
final ranking, meaning a document with a strong semantic match plus a
title-only lexical match could never outrank the weakest body match. That is
a semantics change the tier was never meant to impose (the tier exists to
stop title/tag retrieval from being *diluted away*, not to subordinate the
vector ranker), and it would regress exactly the native-shape queries the
tiered combine was built to protect.

Mechanics: `rankDocuments` builds two rank arrays instead of two normalized
maps; the candidate union, decay computation, snippet plumbing
(`lexicalSnippets`), `overFetch`, and sort/slice are untouched. `HybridHit`'s
`bm25Score`/`vectorScore` fields become the per-list RRF contributions
`1/(k + rank)` (0 when absent from the list) — still monotone in each
ranker's opinion, still what `RerankCandidate` forwards to the agent-as-judge
pool. `relatedSearch` fuses through the same path (its lexical list is
document-granularity, as today).

## Decision 2 — deterministic query routing sets per-query weights

A cheap, rule-based classifier — new `src/search/router.ts`, pure function,
no I/O beyond one optional index lookup — inspects the raw query before
`hybridSearch` picks weights:

Lexical signals (any one fires → `lexical` class):
- a quoted phrase (`"…"` survives in the raw query even though
  `buildMatchQuery`'s tokenizer strips it — the router reads the raw string);
- a path-like token (contains `/` or a known file extension);
- a CamelCase or snake_case identifier;
- a digit-heavy token (≥ half digits, length ≥ 3);
- a high-IDF rare term — document frequency read from an `fts5vocab` table
  over `documents_fts` (one `CREATE VIRTUAL TABLE … USING fts5vocab(…,
  'row')`, costs nothing at write time), rare = df below a small absolute
  floor.

Class → weights: `lexical` → `{bm25: 0.8, vector: 0.2}`; everything else →
the balanced default. Two free wins fall out: an extreme-lexical class
(quoted phrase or path token) may set `{bm25: 1, vector: 0}`, and
`hybridSearch` already skips query embedding entirely when `weights.vector
=== 0` — routing buys latency, not just recall.

Escape hatches, in precedence order: explicit `weights` on the `vault_search`
call always wins (the existing arg, untouched); `search.routing: off` in
`.daftari/config.yaml` restores static defaults vault-wide. The router's
verdict is reported in the search result (`weights` is already echoed) so
misroutes are visible, not mysterious.

**No LLM. No HyDE.** Explicitly rejected, with evidence: HyDE measured
counterproductive as a default (arXiv 2504.08231: +2.61% on varied
reformulations, **−5.43% on original queries**) — it pays an LLM call per
query to lose on the query shape users actually type. An LLM router has the
same latency/cost profile with less evidence. The classifier above is
deterministic, testable with a fixture table, and free. If routing itself
underperforms, the config switch turns it off; nothing else depends on it.

## Decision 3 — ACL pushdown into the KNN scan

`package.json` pins `sqlite-vec ^0.1.9`, already past 0.1.8 (Mar 2026),
which added constraint support on KNN queries — filtering *inside* the scan
rather than after it. **No dependency bump; this is schema and query work.**

- `embeddings_vec` gains a `collection` partition-key column
  (`createVecTable` in `src/storage/index-db.ts`). Rows are written per
  `(content_hash, model, collection)`: the embedding cache stays
  content-addressed and dedupes as today, but a chunk whose identical
  content appears in documents from two collections gets one vec row per
  collection — the only honest shape, since a single row cannot carry two
  ACL labels. Cross-collection duplicate content is rare; the cost is a few
  duplicate vector rows, accepted.
- `vecRanking` gains the caller's readable-collection list and adds
  `AND v.collection IN (…)` to the KNN query. The scan now spends all 64 of
  its K budget on chunks the caller can read — the starvation bug is gone by
  construction, not mitigated by a bigger K (which only dilutes it).
- Threading: `HybridSearchOptions` gains `readableCollections?: string[]`;
  the tool handler derives it from the access context. Absent (operator CLI,
  no access context) means unfiltered, as today.
- Schema: bump `SCHEMA_VERSION`. The index is ephemeral and the
  version-mismatch path already does a clean drop-and-rebuild; no migration.
  Version-number ownership: this spec and the contextual-chunking companion
  (its Decision 3) each require a bump, and both were drafted against
  version 9 — the numbers are claimed *at implementation time*, in landing
  order (first to land takes 10, the second takes 11), or as one shared
  bump if they ship in the same release. Neither spec owns "10" by right.

**The post-rank `canRead` filter in `src/tools/search.ts` stays.** Pushdown
is a recall fix; the handler filter remains the authorization boundary
(defense in depth, and it still covers the lexical half and the coverage
pass). `overFetch` also stays — lexical candidates are still filtered late.

**Existence-disclosure check.** Filtering inside the scan is still omission:
an unreadable document simply never enters the candidate set, no count or
remainder of excluded chunks is computed or reported, and the result shape
is identical to a vault where those collections don't exist. Nothing new
leaks; this *narrows* the window in which unreadable material is
materialized at all. The 2026-07-14 invariants (omission over redaction, no
existence leak) hold without modification.

## Decision 4 — every change lands as a measured A/B; numbers are the release notes

All three decisions ship behind option flags, default OFF, and are measured
through the existing Recall Bench adapter
(`docs/superpowers/specs/2026-06-20-daftari-recall-bench-adapter-design.md`,
`integrations/recall-bench/`) before any default flips — the same discipline
that gated the chunk-BM25 default. A new sibling runner (`fusion-runner.mjs`;
committed runners stay reproducible) drives four arms over the standard
vault + questions fixtures:

- **A (baseline):** today's normalize-and-sum fusion.
- **B:** RRF (Decision 1) alone.
- **C:** RRF + routing (Decision 2), with per-category breakdown —
  identifier/exact-name queries reported separately from paraphrase queries,
  since routing's whole claim is category-shaped.
- **D:** RRF + routing + ACL pushdown (Decision 3), run under a
  restricted-role fixture that can read a minority of collections — the
  configuration where the starvation bug lives. A and D under the
  unrestricted role must be rank-identical modulo fusion, which doubles as
  the no-leak regression test.

Metric: recall@top-K (K = 10/20/50), per-category and aggregate, `$0`, no
LLM. **Regression gate for each default flip:** aggregate recall@10 must
improve, and no query category may drop by more than 1pp at any K. A change
that wins on average by trading away a category (the HyDE failure shape)
does not ship as a default; it stays a flag or dies. Results land in
`docs/superpowers/results/` and are the release notes for the flip.

Sequencing: Decision 3 first (it is a bug fix with no ranking-philosophy
risk and its arm-D fixture is needed anyway), then Decision 1, then
Decision 2 on top. Each is its own PR against this spec.

## Out of scope

- **Reranker stage and chunk-header changes** — companion spec
  `2026-07-26-contextual-chunking-reranker-design.md`. The agent-as-judge
  rerank pool (`RerankCandidate`) is untouched here beyond the component-
  score semantics noted in Decision 1.
- **Embedding model change** — companion spec. Decision 3's vec-table
  rebuild is provider-agnostic and does not presuppose it.
- Routing for `relatedSearch` — it has no user query to classify; it keeps
  static weights.
- Learned or LLM-based query classification, HyDE, and query rewriting of
  any kind (rejected in Decision 2, not deferred).
- Tuning RRF's `k` — 60 ships; it becomes a knob only if the bench demands
  it, which the literature says it won't.
- Multi-list RRF (adding decay, edges, or supersession as fused rank lists)
  — the SP2–SP4 ranking-signal programme is a separate track; this spec only
  builds the fusion those signals would eventually enter through.

## Kill condition

If arm B fails to beat arm A on aggregate recall@10 on the Recall Bench
fixtures — i.e. rank fusion does not outperform score normalization on
*this* corpus despite the literature — Decision 1 is falsified here and the
weighted sum stays; Decision 2 is then re-based onto it (routing is
fusion-agnostic) and re-measured independently. If arm C's per-category
breakdown shows routing losing on paraphrase queries by more than it gains
on identifier queries, routing ships permanently off by default. Decision 3
has no recall kill condition — it is a correctness fix whose gate is the
rank-identity check in arm D — but if the partition-key rebuild measurably
regresses unrestricted KNN latency at vault scale, the constraint moves from
partition key to a plain metadata filter and the numbers are re-run.
