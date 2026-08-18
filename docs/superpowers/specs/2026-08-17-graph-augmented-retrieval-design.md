# Graph-Augmented Retrieval (off.1 / MAV-154) — Design

**Date:** 2026-08-17 · **Branch:** `feat/off1-edge-ceiling` · **Bead:** `mavaali-beads-off.1`
**Epic:** off / MAV-155 (Daftari multi-hop retrieval enhancements)

## Problem

Top-K retrieval ranks by BM25 + vector fusion (`src/search/hybrid.ts`) and stops.
Multi-hop / multi-day questions have relevant documents that are neither lexically
nor semantically close to the query on their own — they are *reachable* only through
the knowledge graph (a shared tension, a `derives_from` lineage). Daftari already
stores that graph and already traverses it (`topicEgoGraphFrom`, `src/canon/topic.ts`),
but nothing composes traversal *into* retrieval.

**Hypothesis:** one-hop edge-guided expansion after ranking raises span recall on
multi-hop questions more than extending the rank list by the same number of docs.

## Gate (banked — do not re-litigate)

The $0 reachability-ceiling arm (`integrations/recall-bench/edge-ceiling.mjs`) ran on
the synthetic edgehop corpus (2026-08-17, `vectorUsed=true`) and did **not** trigger the
kill condition. On the hard multi-hop types, inject-all ceiling beats rank-extension at
matched budget:

| type | n | seedRecall | subset | ceiling | rankExt | budget |
|---|---|---|---|---|---|---|
| hub-hop | 24 | 0.20 | all | 1.00 | 0.68 | ~50 |
| hub-hop | 24 | 0.20 | trigger | 0.60 | 0.20 | ~24 |
| cross-tension | 8 | 0.50 | all | 1.00 | 0.56 | ~50 |
| cross-tension | 8 | 0.50 | trigger | 0.75 | 0.50 | ~24 |
| lex-reachable | 24 | 1.00 | all/trigger | 1.00 | 1.00 | — |

Findings that shape this design:
- **Trigger-bearing subset is the best trade** — triples rank-ext on hub-hop at half the
  budget of `all`. Tension-only links are weak; `all` buys the last recall points at 2×
  budget and near-zero precision.
- **Ceiling is a loose upper bound** — `expansionPrecision` ≈ 0.04–0.07, i.e. inject-all
  drowns results in distractors. The whole engineering problem is *selection*.
- **Synthetic edges are constructed.** The gate proves the mechanism *can* win when edges
  align; it does not prove edges align in the wild. Wild-alignment validation is deferred
  to `off.6`, not a blocker (decision: Option A, Mihir 2026-08-17). Full verdict:
  vault `projects/daftari-off1-edge-expansion-gate-verdict.md`.

## Design

A new composition unit sits **above** `hybridSearch`; `hybrid.ts` is not modified.

```
graphAugmentedSearch(db, vaultRoot, query, opts)
  seeds      = hybridSearch(db, query, { limit: K, ... })         // native ranking, unchanged
  if not opts.graphExpand.enabled: return seeds
  candidates = set of seed paths
  neighbors  = union over seeds of topicEgoGraphFrom(tensions, edges, seed, 1)
                 minus candidates                                  // edges/tensions loaded here
  scored     = neighbors mapped to max cosine(chunk, queryEmbedding)  // semantic affinity
  kept       = scored where affinity >= tau                        // C: query-affinity floor
  injected   = top-N of kept by affinity                           // A: fixed global cap
  return seeds ++ injected(flagged viaEdge)                        // appended, affinity order
```

### Units and boundaries

- **`graphAugmentedSearch`** (new, `src/search/graph-augmented.ts`) — the orchestrator.
  Input: an opened index db, vault root, query, options. Output: an augmented hit list.
  Owns: seed retrieval delegation, neighbor gathering, floor, cap, merge, flagging.
- **Edge loading** — `listEdges` + `listTensions` (existing curation stores), filtered to
  the configured subset. Passed *into* the pure `topicEgoGraphFrom` (no I/O inside traversal).
- **Neighbor affinity** — a focused index helper: for a set of neighbor paths and a query
  embedding, return each path's maximum chunk cosine. This is the only new index I/O. It
  reuses the sqlite-vec chunk store `hybrid.ts` already reads; it does not reuse the global
  KNN scan (neighbors are, by construction, outside the KNN top set).
- **`hybridSearch`** — unchanged. Consumed through its existing interface.
- **`vault_search` tool handler** — calls `graphAugmentedSearch` instead of `hybridSearch`
  when `search.graph_expand.enabled`; the post-rank `canRead` RBAC filter continues to run
  over the merged list (injected docs are authorized like any other hit).

### Edge subset

Default **trigger-bearing**: tensions (all statuses — a resolved tension is still a topic
link) + `derives_from` edges with status `trigger-bearing`. Revoked edges excluded (matches
`topicEgoGraph` semantics). Configurable to `all` (tensions + every non-revoked `derives_from`).
Tension-only is available but not a default (weak in the gate).

### Affinity floor τ

Vector cosine to the query embedding, thresholded. Lexical affinity is deliberately NOT
used: these neighbors are lexically absent from the query by construction (that is why the
ranker missed them), so a lexical floor would discard exactly the docs the edge reached.
τ is configurable; its default is set from a recall-bench sweep, not guessed.

### Budget

Fixed global cap N: at most N expansion docs total, taken by descending affinity across all
seeds. Chosen for a clean matched-budget comparison against rank-extension (the recall-bench
compares at equal add budget) and a hard bound on latency and distractor load. No per-seed
fan-out cap in v1 (YAGNI; add if one hub-like seed monopolizes the budget).

### Output shape

Native ranked hits first (order unchanged), expansion docs appended in descending affinity.
Each injected hit carries `viaEdge: { seed, edgeType }` mirroring the existing `viaCoverage`
transparency flag, so a caller (and the reranker) can see a doc entered via graph expansion
rather than lexical/vector match.

### Config

`search.graph_expand: { enabled: boolean, cap: number, tau: number, subset: "trigger" | "all" | "tensions" }`.
Default `enabled: false` — opt-in, consistent with the other coverage passes. Off means
`graphAugmentedSearch` returns exactly what `hybridSearch` returns (zero behavior change).

## Validation

- **Recall-bench arm** (`integrations/recall-bench/`) comparing `graphAugmentedSearch`
  against rank-extension at **matched add budget** on the multi-hop subsets, reporting recall
  AND distractor load (added-relevant / added-distractor / precision), mirroring
  `baseline-runner.mjs`. Acceptance = positive recall delta on hub-hop / cross-tension at
  equal budget with the kill condition explicit.
- τ and N defaults chosen from a sweep on the synthetic edgehop corpus, recorded in a results
  note. Wild-alignment (organic edges over real content) is `off.6`.

## Testing

- Pure unit tests for `graphAugmentedSearch` with edges/tensions and a stubbed affinity
  scorer injected (same purity discipline as `topicEgoGraphFrom`): seed→neighbor→floor→cap→
  merge, subset filtering, dedup against candidates, `enabled:false` pass-through, empty-graph
  no-op, budget cap honored, ordering (`viaEdge` docs after native hits).
- An integration test over a seeded index exercising the real affinity helper (cosine over
  actual chunks), gated like the other `RB_INTEGRATION` tests that load the embedding model.

## Non-goals

- No change to `hybrid.ts` ranking or weights.
- No per-seed fan-out cap, no multi-hop depth > 1, no `all`-subset default (all deferrable).
- No wild-corpus edge derivation (that is `off.6`).
