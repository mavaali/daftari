# Contextual chunking and local reranking — design

2026-07-26. Status: **proposed — awaiting Mihir's review; implementation not
started.**
Companion: `2026-07-26-retrieval-fusion-overhaul-design.md` (RRF fusion),
settled the same day. The two are independent levers; Decision 9 states the
ordering and why neither blocks the other.

## Why

Chunk-level BM25 shipped as the default in v1.29.0 and closed the multi-topic
dilution gap. The two largest levers still on the table are both documented in
Anthropic's contextual-retrieval result (top-20 retrieval failure rate,
Sept 2024, corroborated since):

| Stage | Failure-rate reduction |
|---|---|
| Contextual embeddings | −35% |
| + contextual BM25 | −49% |
| + reranking | −67% |

Anthropic's method generates per-chunk context with an LLM call. The 2026
practitioner consensus for **markdown corpora specifically** is that a heading
breadcrumb (doc title › H1 › H2) prepended into the chunk text captures most
of that gain with zero LLM calls ("Free contextual chunk headers", dev.to
2026), and that structure-aware chunking beats semantic/LLM chunking decisively
on cost with mixed accuracy evidence either way (Chroma's chunking report vs
the Firecrawl/Extend 2026 numbers). A vault is the best case for this: every
document is markdown with frontmatter, so the structure is already there.

The mechanical fact that makes Part A one change, not two: `stageOne`
(`src/search/reindex.ts`) calls `chunkText(body)` and the resulting chunk text
feeds **both** retrieval halves — it is hashed (`sha256Hex`) into the
content-addressed embeddings cache keyed `(content_hash, model)`, *and* it is
the external-content source for the `chunks_fts` FTS5 table
(`content='chunks'`). One text-level prefix at staging time is therefore the
"contextual embeddings + contextual BM25" combination (−49%) in a single move.

Part B (reranking, the −67% row) gets its shape from a seam that also already
exists: the `EmbeddingProvider` pattern (`src/search/embedding-provider.ts`) —
config-selected, memoised per process, `warm()`/lazy-load, `Result`-returning
with graceful degradation. A `RerankProvider` mirrors it.

## Decision 1 — heading-aware splitting

`chunkText` (`src/search/vector.ts`, `CHUNK_MAX_CHARS = 800`) currently splits
on blank lines and greedy-packs paragraphs to 800 chars, blind to structure. It
becomes heading-aware:

- Split the body at ATX heading lines (`#`–`####`) first; paragraph-pack
  *within* a section up to the existing 800-char target, exactly as today.
- A heading boundary **always** starts a new chunk — no packing across
  sections, even when two small sections would fit in one chunk. Folding
  sections was considered and rejected: a chunk spanning two H2s has no honest
  breadcrumb, and the ambiguity defeats Decision 2. Heading-dense docs produce
  more, smaller chunks; every per-chunk store already scales with chunk count.
- Oversized single paragraphs hard-split as today. Setext headings are not
  recognized (the vault house style is ATX; a setext doc degrades to today's
  behavior, not an error).
- The function grows to `chunkDocument({ title, collection, tags, body })`
  returning `{ text, context }[]` (context per Decision 2); the always-≥1-chunk
  guarantee stays.

Chunk size stays 800. Retuning it is a separate experiment (out of scope).

## Decision 2 — breadcrumb + frontmatter context, hashed with the text

Each chunk carries a one-line synthesized context:

```
{collection} › {doc title} › {H1} › {H2} › {H3} · tags: a, b, c
```

- Heading path = the innermost open headings at the chunk's start. Tags capped
  at 5, whole line capped ~160 chars (truncate middle path components first).
  Collection and title always survive truncation — they are the highest-value
  disambiguators for the vault's short, similar-shaped docs.
- **Storage:** `chunks` gains a `context` column; `chunks_fts` becomes a
  two-column external-content table `(context, text)`. `bm25(chunks_fts)`
  scores both columns at default weight — this *is* contextual BM25, and it is
  Anthropic's plain-concatenation recipe, no new tuning knob.
- **Embedding input** is `context + "\n\n" + text`, and `content_hash` is
  computed over that same concatenation — the context is part of the chunk's
  retrieval identity. Consequence: renaming a heading re-embeds that section's
  chunks (correct — their retrieval context changed), and an identical
  paragraph in two differently-titled docs no longer dedupes to one embedding
  row (accepted — distinguishing them was the point).
- **Token budget check:** 800 chars ≈ 200 wordpiece tokens; local-minilm
  (all-MiniLM-L6-v2) truncates at 256. A ≤160-char context is ~40 tokens, so
  the concatenation fits without pushing body tail off the cliff.
- Interaction with the tiered lexical combine (`tieredLexical`,
  `src/search/hybrid.ts`): title tokens now appear in every chunk's context, so
  title-matching docs enter the upper band via chunk matches and the
  `{title tags}` fallback tier becomes nearly redundant. It **stays** — it is a
  strict, harmless fallback — and the chunk-BM25 native/title-tag regression
  suites (2026-06-24 specs) decide whether it can be retired later.

## Decision 3 — one-time full re-embed, shipped as a schema bump

Every chunk's hash input changes, so every content hash changes, so the first
post-upgrade reindex is a full cache miss: one cold re-embed of the whole
corpus. This is exactly the cost the architecture doc's honest assessment
worries about ("a first cold reindex on a large vault is already
multi-minute", docs/architecture.md ~997–1002). Addressed head-on rather than
hidden:

- **Ship with a schema bump** — `SCHEMA_VERSION` (`src/storage/index-db.ts:57`)
  advances, plus the `chunks.context` column and the two-column `chunks_fts`
  in the version-mismatch drop+recreate set. The rebuild happens once,
  loudly, at upgrade, not lazily per query. Version-number ownership: the
  retrieval-fusion companion (its Decision 3) also bumps the version, and
  both specs were drafted against version 9 — numbers are claimed at
  implementation time in landing order (first to land takes 10, the second
  11), or as one shared bump if they ship together. If the embedding-refresh
  spec's model switch lands in the same release, fold it into this same
  bump so the corpus pays one cold re-embed, not two.
- **Once per corpus per model.** Content-addressing restores the incremental
  property immediately after: edits re-embed only changed chunks, renames zero.
- **Interruptible.** The #54 batch-committed resume path (`EMBED_COMMIT_BATCH`,
  `src/search/reindex.ts`) means a killed first build banks every committed
  batch and resumes past it.
- **Priced.** local-minilm: ~25 min for a 44k-chunk vault; openai-3-small:
  ~2 min, ~$0.10. The release notes must state both numbers.
- **One honesty correction to the provider docs' "old rows stay as insurance"
  comment:** that insurance is for *provider switches*, where old-model rows
  remain referenced by live chunk hashes. A text-form change is different —
  the old hashes leave `chunks` entirely, so `gcOrphanedEmbeddings`
  (`index-db.ts:658`, `NOT EXISTS` against `chunks`, model-blind) reaps every
  pre-upgrade row for **all** models on the first post-bump reindex. That is
  correct behavior (the old text form never comes back; keeping its rows is
  dead weight), but it means each configured provider pays the one-time cost
  once for the new form before the switch-back insurance property holds again.

## Decision 4 — displayed snippets never contain the breadcrumb

The context line is an index-layer artifact. Markdown is truth; serving
synthesized text as if it were document content would break that and the
[DATA] labeling discipline with it. With Decision 2's two-column layout this is
structural, not string surgery: the `snippet()` call in `chunkFtsRanking`
targets the `text` column only, and the JS fallback (`makeSnippet`) reads
`doc.content`, which never contained context. A query that matches *only* in
the context column still ranks the chunk (bm25 spans both columns); its
snippet degrades to the chunk's leading body text — acceptable, and strictly
better than showing invented lines.

## Decision 5 — `RerankProvider`, config-selected, default `none`

```ts
export interface RerankProvider {
  readonly id: string; // stable namespace, mirrors EmbeddingProvider.id
  warm(): Promise<Result<void, Error>>;
  // One relevance score per passage, input order. Result.err = degrade.
  rerank(query: string, passages: string[]): Promise<Result<number[], Error>>;
}
```

Config, mirroring `embeddings.provider`:

```yaml
rerank:
  provider: none   # none | local-bge-m3
```

**Default is `none` — opt-in.** Argued: the q8 weights are ~600 MB on disk and
comparably resident in RAM, an order of magnitude past local-minilm's ~90 MB;
the default install must stay light. And the project already has the playbook:
chunk-level BM25 shipped behind an option, was measured, and flipped to
default in v1.29.0 on evidence. The reranker earns a default flip the same way
(Decision 9), not by assertion.

## Decision 6 — model: bge-reranker-v2-m3, ONNX q8, under transformers.js

- **BAAI/bge-reranker-v2-m3** (~568M params) is the 2026 self-hosted consensus
  default cross-encoder; batched over 50 candidates it scores a query in
  ~80 ms on CPU at q8 — affordable per search at daftari's single-user /
  small-team QPS.
- **ONNX q8 exists off the shelf** (`onnx-community/bge-reranker-v2-m3-ONNX`)
  and runs under `@huggingface/transformers` — already a dependency at
  `^4.2.0` (package.json), the same runtime local-minilm uses. **Zero new
  dependencies**; the provider is a sibling of
  `src/search/providers/local-minilm.ts`.
- **ColBERT-style late interaction rejected:** per-token vectors multiply
  vector storage by tokens-per-chunk (~200×) in an index whose
  delete-and-rebuild disposability the architecture doc treats as
  load-bearing, and late interaction's precompute advantage pays off at high
  QPS — which this is not. At this QPS the cross-encoder's full accuracy costs
  80 ms and nothing at rest.

## Decision 7 — pipeline position: rerank the fused permitted top-50, before the additive passes

Current `vaultSearch` order (`src/tools/search.ts`): over-fetched fused
ranking → RBAC filter → slice to `limit` → coverage pass → current-source
foregrounding / contested / structural joins → token cap → optional #3 pool.

The rerank stage inserts between RBAC filter and slice: take
`permittedRanked.slice(0, 50)`, score `(query, passage)` pairs, reorder, then
slice to `limit`. Rationale for the placement:

- **After RBAC** so cross-encoder budget is never spent on hits the caller
  cannot see.
- **Before the additive post-passes.** Coverage and current-source
  foregrounding are lossless appenders — recall levers, not ranking levers —
  and the token-cap backstop already shapes what they add. Reranking after
  them would let a relevance model evict recall insurance. They keep running
  last, over the reranked page, unchanged.
- **Passage text** is the hit's winning chunk (`context + "\n\n" + text`):
  `chunkFtsRanking` already tracks the lexical winner's rowid; vector-only
  hits use their best-KNN chunk. Whole-document passages are rejected — the
  breadcrumb-contextualized chunk is exactly the passage shape the
  cross-encoder wants, and it bounds input length.
- `HybridSearchResult` gains `rerankUsed: boolean`, the honest twin of
  `vectorUsed`.
- **The #3 agent-as-judge pool is untouched.** The cross-encoder is index
  machinery, the same class as the MiniLM embedder — not the server exercising
  judgment, so the #3 division (the server prepares a pool, the calling agent
  judges) stands. When both are on, the `rerank_candidates` pool is drawn from
  the cross-encoder's ordering; the agent judges a better pool.

## Decision 8 — degradation and warm mirror the embedding half

Lazy-load on first use. A load or inference failure returns `Result.err` and
the search serves the fused order with `rerankUsed: false` — the exact shape
of the vector half's lexical-only degradation (`hybrid.ts`); a missing 600 MB
model must never fail a search. Warm-up reuses the existing gate: when
`warm_embeddings: true` **and** `rerank.provider != none`, the background warm
(`runBackgroundWarm`, `src/index.ts`) warms the reranker after the embedder.
No new knob — the flag's meaning is "pay model cold-starts at startup, not on
the first query," and that meaning covers both models.

## Decision 9 — measurement gates, and independence from the fusion companion

Both stages are measured through the recall-bench adapter (2026-06-20 spec)
before any default changes:

- **Part A:** baseline vs breadcrumb-chunk arms, recall@K (K=10/20/50), plus a
  rerun of the chunk-BM25 native and title/tag regression suites (context
  duplicates title tokens; watch for double-counting distortions). Part A ships
  only if it beats baseline without regressing the native suites.
- **Part B:** fixed candidate pool of 50 — a reranker cannot move recall@50 by
  construction, only ordering within the pool — so the metric is recall@5 and
  recall@10 given the pool, plus an answer-quality arm per the 2026-06-24
  precedent. Measured with Part A already in place (its chunks are the
  passages).
- **Fusion companion:** Part A is *upstream* of fusion (it changes what both
  halves index, whatever combines them); Part B is *downstream* (it consumes
  the fused candidate list and is agnostic to weighted-sum vs RRF). Neither
  spec blocks the other; sequence for clean attribution is A → fusion → B,
  re-baselining between stages. If both fusion and B land, expect the reranker
  to absorb some of fusion's marginal top-K lift — that is fine; the fused
  list's job shrinks to candidate generation.

## Out of scope

- **LLM-generated per-chunk context** (Anthropic's original recipe). Costs an
  LLM call per chunk on every content change, against a local-first default
  that costs zero. The breadcrumb captures most of the gain for markdown; the
  LLM variant is only worth revisiting if Part A's measured lift falls well
  short of the published numbers.
- **Late chunking / long-context embedding models.** Requires replacing
  local-minilm (256-token cap); depends on the embedding-refresh companion
  spec and is deferred to it.
- **Reranking for `vault_search_related`** — stays document-granularity,
  un-reranked this pass.
- **Fusion changes** — the 2026-07-26 RRF companion spec.
- **ColBERT / late interaction** — rejected in Decision 6, recorded here.
- **Chunk-size retuning** — 800 stays; a separate sweep if ever.

## Kill condition

Two, one per part. **Part A:** if the breadcrumb arm fails to produce a clear
recall@K lift over baseline on recall-bench, or regresses the native
title/tag suites, the contextual-chunk hypothesis is falsified for this corpus
— the schema bump does not ship, and the corpus-wide re-embed is never imposed
on users (the experiment vault alone pays it). **Part B:** if
local-bge-m3 fails to improve recall@10 within the fixed candidate pool by a
meaningful margin over the fused order, or real-hardware CPU latency lands far
above the ~80–200 ms budget, the provider stays permanently opt-in or is
removed — a 600 MB model that only shuffles an already-good ordering is cost
without a claim.
