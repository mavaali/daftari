# Embedding refresh and index quantization — design

2026-07-26. Status: **proposed — awaiting Mihir's review; implementation not started.**

## Why

The default local embedder is `all-MiniLM-L6-v2` — a 2021-era model, 384
dimensions, ~512-token window, chosen in v1.9 because it was the smallest
thing that made hybrid search real. It has aged out of its job: 2026 model
guides file MiniLM under "prototyping, not production," and on MTEB(eng, v2)
it scores in the mid-50s while two small local candidates that fit daftari's
fully-local posture score ~70 — **EmbeddingGemma-300M** (622 MB, 768d,
Matryoshka-truncatable, MTEB-eng-v2 69.67) and **Qwen3-Embedding-0.6B**
(Apache-2.0, ~1.5 GB, MTEB-eng-v2 70.7). That is a model-generation delta, and
the vector half of every `vault_search` is paying it.

Two adjacent facts make this the right moment:

1. **The cache key already did the hard migration work.** The durable
   `embeddings` table is keyed `(content_hash, model)` with a `dim` column
   (`src/storage/index-db.ts`), and the architecture doc calls the composite
   key out as deliberate: *"a future model migration can keep both the old and
   new model's embeddings present under the same hash, so a roll-forward never
   has to clear the cache first."* This spec is that future migration. Both
   models' rows coexist; switching is a config change plus a background
   reindex; switching back is all cache hits. **No breaking change anywhere in
   this design** — that key is the spine everything below hangs on.
2. **Quantization has settled.** int8 scalar quantization preserves retrieval
   quality with negligible degradation, especially with float32 rescoring of
   the top-k (Sentence Transformers embedding-quantization docs; QAMA, CIKM
   2025), while binary quantization significantly impairs it on models this
   size. int8 yes, binary no — and sqlite-vec's `vec0` supports int8 columns,
   so the index side needs no new dependency.

One quieter, strategic reason: a long-context embedder is the prerequisite for
**late chunking** (Jina, arXiv:2409.04701 — encode the whole document, then
mean-pool per chunk from the token embeddings: whole-document context for
every chunk, no LLM call). MiniLM's ~512-token window forecloses it;
EmbeddingGemma's 2K window opens it partway, Qwen3's 32K fully. Decision 5
scopes it.

## Decision 1 — new default local provider: `local-embeddinggemma`

**Recommendation: EmbeddingGemma-300M as the new default local provider, run
in-process via `@huggingface/transformers` (Transformers.js) using the ONNX
community weights, exactly the way `local-minilm` runs today**
(`src/search/providers/local-minilm.ts` is the template: memoised lazy
extractor, small fixed sub-batches, `Result`-typed failures degrading to
lexical-only, `warm()` respecting `warm_embeddings`).

Why Gemma over Qwen3-0.6B for the *default*: 622 MB vs ~1.5 GB of weights —
the default provider downloads on first use, so footprint is a first-run tax
on every vault — and its Matryoshka points are exactly what Decision 2 needs.
Qwen3 scores ~1 point higher on MTEB-eng-v2 and carries a 32K context (the
full late-chunking unlock), so it ships as the **documented alternative** — a
provider id, not the default.

Verification honesty: ONNX exports of EmbeddingGemma exist and Transformers.js
support for the Gemma-3-based embedding architecture landed upstream, but
**compatibility with the pinned `@huggingface/transformers` ^4.2.0 line is
unverified in this repo** — as is Qwen3-Embedding's. Implementation starts with
a smoke spike in the style of `2026-07-19-sqlite-binding-spike.md`: load each
model, embed a fixture batch, compare against reference Python embeddings
within tolerance. A dependency bump is in scope if the pinned line can't load
the model; no Transformers.js path at all is a kill condition (below), not a
workaround hunt. Two behaviors the spike must confirm because MiniLM has
neither: EmbeddingGemma expects **asymmetric prompt prefixes** (document form
at index time, query form at search time — the provider must apply both), and
Qwen3 uses last-token pooling, not mean pooling.

Config and posture are unchanged in shape:

```yaml
embeddings:
  provider: local-embeddinggemma   # new default for new vaults
  # provider: local-qwen3-0.6b     # documented alternative
  # provider: local-minilm         # remains available, unchanged
  # provider: openai-3-small       # unchanged (out of scope)
```

New ids join `EMBEDDING_PROVIDERS` in `src/utils/config.ts` plus a branch in
`getProvider` — the exact three-touch extension the config comment already
prescribes. The hard-error posture for unknown ids is unchanged: a typo
refuses to start the server, never falls through to a default. `local-minilm`
is not removed; vaults that never touch config keep today's behavior exactly.
One consequence for warm-up gating: the architecture doc's "~100 MB model
footprint" becomes ~600 MB-class (less with the q8 ONNX variant — the spike
picks), so the `warm_embeddings: false` escape hatch matters more than it used
to, and the docs get that number updated.

## Decision 2 — Matryoshka truncation is a provider parameter, recorded in the model id

EmbeddingGemma is Matryoshka-trained at 768/512/256/128; published measurements
put the 1024→512 truncation class at roughly ~1.4% retrieval loss for 50%
storage, and 768→512 sits in the same regime. **Default the new provider to
512d truncation**: the provider slices each 768d output to its first 512
components and re-L2-normalizes (renormalization is required for cosine to
stay meaningful).

384d is deliberately *not* offered for Gemma: it is not one of
EmbeddingGemma's trained Matryoshka points, so truncating there is
off-distribution. Qwen3 supports arbitrary output dims (32–1024) and may offer
finer choices later; for now both new providers expose `dim: 512` as the
default with `768` (Gemma full) as the opt-up.

The load-bearing rule: **the truncation is part of the model id string** —
`local-embeddinggemma@512`, `local-embeddinggemma@768` — which is what gets
written to `embeddings.model`. The provider contract already says the id is
the cache namespace ("two providers with the same id would corrupt the cache")
and that mixed-dim vectors under one id are a bug; folding the dim into the id
honors both clauses for free. Two truncations of the same model are simply two
models to the cache: separate row sets under `(content_hash, model)`, separate
`embeddings_vec` dims via the existing `VEC_DIM_META_KEY` rebuild, no new
mechanism. The durable cache stores what the provider emits — the truncated
512d float32, not the full 768d — so the `dim` column keeps its
defense-in-depth meaning. (Storing full-width and re-truncating at read time
was rejected: it makes `dim` disagree with the id's promise, and buys only
truncation changes without re-embed — a rare event, priced honestly as a
re-embed.)

Config: `embeddings.dim` as an optional sibling of `provider`, validated
against the provider's allowed set, unknown values hard-error (same posture as
`provider`).

## Decision 3 — int8 in the vec index; float32 rescoring from the cache

The `embeddings_vec` table becomes `int8[dim]` instead of `FLOAT[dim]`
(`createVecTable` in `src/storage/index-db.ts` is the single touch point).
Because every provider L2-normalizes (`normalize: true`), components live in
[-1, 1], so quantization is calibration-free unit-range scaling — `round(x *
127)` in the insert path — deterministic and provider-agnostic. No sqlite-vec
quantize helper needed, though `vec_quantize_int8` may exist to do it SQL-side;
implementer's choice.

**The durable `embeddings` cache stays float32.** This is the sentence that
keeps the design consistent with everything daftari believes about the index:
the cache is the source, the vec table is the index, and the index is
ephemeral. Quantization is an *index* representation choice, droppable and
rebuildable from the cache at any time — never a lossy transform of the source
of truth.

Search becomes scan-then-rescore: KNN over int8 retrieves `k × 4` candidates
(the Sentence Transformers rescore-multiplier convention), rescored with exact
float32 cosine against vectors joined from the durable cache by
`content_hash`; final top-k comes from the rescored order. One extra indexed
query per search; the literature above puts rescored-int8 within noise of full
float32. Rescoring is not optional-config — it is simply how quantized search
works here; the only knob is `embeddings.quantize: int8 | none` (default
`int8` for the new providers, `none` kept for exact-parity debugging).

Version honesty: the pinned `sqlite-vec` is ^0.1.9, and the 0.1.x line
documents int8 vector columns, but **whether int8 composes with
`distance_metric=cosine` in the pinned build is unverified** — the smoke spike
covers it (create `int8[512]`, insert, KNN MATCH, compare ordering against
float32). If cosine-on-int8 is unsupported, fall back to int8 with L2 —
equivalent ordering for unit vectors up to quantization error. If the pinned
version can't do int8 at all, a minor sqlite-vec bump is in scope, re-running
the 2026-07-19 spike's gates against it.

Storage arithmetic on the reference 44K-chunk vault: today's 384d float32
index ≈ 68 MB; naive 768d float32 ≈ 135 MB; 512d int8 ≈ 22 MB — **the index
shrinks to a third of today's while model quality jumps a generation**. The
float32 cache grows (2 KB/row at 512d vs 1.5 KB today, plus retained
old-model rows); that durable-cache spend is priced in Decision 4.

## Decision 4 — migration: config change + background reindex; old rows are switching insurance

Rollout is deliberately boring, because the schema made it so:

1. Operator sets `embeddings.provider: local-embeddinggemma` (and optionally
   `dim`) and restarts. Unknown-id hard-error semantics catch typos at start.
2. `openIndexDb` sees the vec-dim mismatch via `VEC_DIM_META_KEY` and
   drop-recreates `embeddings_vec` at the new dim/type — existing behavior,
   durable cache untouched.
3. The next reindex finds zero cache hits for the new model id and embeds
   every chunk under it, exactly as a first-ever reindex would; every reindex
   after that is incremental again. MiniLM's rows are not deleted.

Until step 3 completes, vector search is degraded (the vec mirror is sparse);
lexical search is unaffected throughout — the same degradation posture as
every embedding failure mode today. New vaults get the new default with no
migration at all.

**Cold-start cost, stated honestly.** The architecture doc's "Honest
assessment" already worries that if a cold rebuild "ever becomes multi-hour,
disposability stops being a real fallback." This decision leans on that worry:
a 300M-parameter model on CPU plausibly runs 3–10× MiniLM's per-chunk cost, so
the 44K-chunk vault's ~25-minute MiniLM cold reindex could become 1–4 hours.
That number is a spike deliverable, not a footnote — measure it on the real
vault, publish it in the migration docs, and prefer the q8 ONNX variant if it
closes the gap. The mitigations are honest, not clever: the migration reindex
is a one-time cost per vault (the content-addressed cache keeps every later
reindex O(changed chunks) regardless of model); `openai-3-small` remains the
fast paid path; `local-minilm` remains available if the cost is unacceptable.
If the measured number breaches the kill condition, the default does not flip.

**Housekeeping interaction, verified in code.** `gcOrphanedEmbeddings` deletes
embeddings rows whose `content_hash` no longer appears in any chunk — it is
model-agnostic by hash, which is exactly right here: MiniLM rows for *live*
chunk text survive every gc pass (switching insurance stays intact), while
rows for text that has left the vault die across *all* models at once. No gc
change needed. The cost is a cache larger than single-model; acceptable —
cheap disk, and a committed operator can `DELETE FROM embeddings WHERE model =
?`. A `vault_gc --model` convenience is deferred until someone asks.

## Decision 5 — late chunking: explicitly deferred, precondition named

Scoped as a deferral rather than dropped, because this spec creates its
precondition and the follow-on should not have to re-argue it. Late chunking
(arXiv:2409.04701) inverts daftari's pipeline: embed the whole document once,
then mean-pool each chunk's vector from the contextualized token embeddings —
every chunk vector carries whole-document context, no LLM call, still one
vector per chunk in the same tables.

Why deferred and not a small decision here: late chunking breaks the
content-addressing invariant. A chunk's embedding becomes a function of its
surrounding document, so `(content_hash, model)` no longer uniquely determines
the vector — verbatim text moved between documents would need distinct rows.
Fixing the key (hash chunk + context, or key by `(path, chunk_index, model)`)
trades away the dedup and O(changed-chunks) properties this whole design leans
on. That redesign deserves its own spec, with its own recall-bench measurement
of late vs naive chunking.

**Named precondition:** a shipped default provider whose context window
exceeds the ~800-char chunk size by an order of magnitude — satisfied
partially by EmbeddingGemma (2K tokens ≈ section context) and fully by Qwen3
(32K ≈ whole document for nearly every vault doc). Nothing in this spec
forecloses it: providers stay pure text→vector functions and the pooling
change is upstream of storage.

## Decision 6 — measurement: recall-bench A/B with a regression gate

The claim "a model-generation jump beats a 2021 model" is plausible and
therefore exactly the kind of claim daftari measures instead of trusts. Reuse
the recall-bench adapter (`2026-06-20-daftari-recall-bench-adapter-design.md`)
and the Stage-A metrics (recall@top-K for K ∈ {10, 20, 50}, day-coverage) on
the same corpus the chunk-BM25 work used, hybrid and vector-only arms. Three
arms, so model gain and quantization loss are separately attributable:

| Arm | Provider / representation | Answers |
| --- | --- | --- |
| A (baseline) | `local-minilm`, 384d float32 | today's shipped behavior |
| B | `local-embeddinggemma@512`, float32, no quantize | model gain at comparable index scale |
| C (proposed default) | `local-embeddinggemma@512`, int8 + rescore | what actually ships |

Gates, in order of severity: **C must not regress recall@10 vs A** — a new
default that retrieves worse than the model it replaces does not ship,
whatever MTEB says. **C vs B within 1pp at every K** — the literature says the
quantization loss is negligible, so a bigger gap is a bug signal in the
quantize/rescore path, not a tradeoff to accept. B vs A is the headline number
and carries no gate — it is the measured size of the model-generation claim,
reported honestly whatever it is. A Qwen3 arm runs only if B vs A
underwhelms.

## Out of scope

- **Reranker.** A cross-encoder stage is a different lever with a different
  latency budget; it gets a companion spec and must not be smuggled in as
  "more rescoring" here.
- **API-provider changes.** `openai-3-small` is untouched — no new API
  providers, no dim/quantize options for it; its 1536d float32 rows behave
  exactly as today.
- **Removing `local-minilm`.** It remains a valid id indefinitely; nothing in
  this spec is forced on existing vaults.
- **Late chunking implementation** (Decision 5 — deferred with precondition).
- **Vec-engine or binding changes.** sqlite-vec stays (minor bump allowed if
  the int8 smoke requires it); node:sqlite stays parked per the 2026-07-19
  spike.

## Kill condition

Three, one per load-bearing bet:

1. **Compatibility.** If the smoke spike cannot get EmbeddingGemma *or*
   Qwen3-0.6B producing reference-matching embeddings through Transformers.js
   (pinned or reasonably bumped), the provider half dies as specified — do not
   substitute a weaker model to save the spec; re-propose when the ecosystem
   catches up.
2. **Quality.** If arm B fails to beat arm A on recall@10 by a measurable
   margin — the MTEB delta not transferring to daftari's corpus — the default
   does not flip. The new providers may still land as non-default options, and
   the model-independent int8 work survives on its own if C-vs-B holds on
   MiniLM.
3. **Disposability.** If the measured cold reindex on the 44K-chunk reference
   vault exceeds ~4 hours on commodity CPU with the best ONNX variant, the new
   model cannot be the *default* — it would convert "delete the .db files and
   rebuild" from a fallback into a threat, which the architecture doc
   explicitly refuses. Non-default option only; revisit when local inference
   gets faster.
