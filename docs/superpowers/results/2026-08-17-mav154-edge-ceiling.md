# MAV-154 (off.1) edge-expansion — $0 reachability-ceiling gate

**Date:** 2026-08-17 · **Branch:** `feat/off1-edge-ceiling` · **Arm:** `integrations/recall-bench/edge-ceiling.mjs`

The core bet of the multi-hop retrieval epic (MAV-155): after Top-K hybrid ranking,
expand one hop along `derives_from` + `tension` edges (`topicEgoGraphFrom`) to reach
multi-hop docs lexical+vector miss. This note records the $0 go/no-go arm that runs
*before* any retrieval integration is built.

## Method

Per labeled question: seeds = top-10 hybrid hits; expansion = docs within one hop of a
seed over an edge subset {`all` | `trigger` | `tensions`}; **ceiling** assumes inject-ALL
(upper bound, no selection policy). Honest comparison = **rank-extension** at the SAME add
budget (top-(10 + |expansion|) by relevance). **Kill:** if `ceilingRecall <= rankExtRecall`
at matched budget, retire before building.

Model-free: seeds via local BM25 + MiniLM (`vectorUsed=true`), expansion via in-memory
BFS, recall scored against pre-existing labels. Zero API spend.

## Result — synthetic edgehop corpus

`gen-edgehop-vault.mjs`: 150 docs, 174 edge observations, 16 tensions, 56 queries.

| type | n | seedRecall | subset | ceiling | rankExt | budget |
|---|---|---|---|---|---|---|
| hub-hop | 24 | 0.20 | all | **1.00** | 0.68 | ~50 |
| hub-hop | 24 | 0.20 | trigger | **0.60** | 0.20 | ~24 |
| cross-tension | 8 | 0.50 | all | **1.00** | 0.56 | ~50 |
| cross-tension | 8 | 0.50 | trigger | **0.75** | 0.50 | ~24 |
| lex-reachable | 24 | 1.00 | all/trigger | 1.00 | 1.00 | — |

Raw: `/tmp/edgehop/ceiling-summary.json`, `/tmp/edgehop/ceiling-perq.json`.

## Verdict

**NOT killed.** On the hard multi-hop types (hub-hop, cross-tension) where seeds miss
relevant docs, edge-expansion beats rank-extension at matched budget. The **trigger-bearing**
subset is the standout — triples rank-ext on hub-hop (0.6 vs 0.2) at half the budget of `all`.
`lex-reachable` is a correct null. Tension-only links are weak.

Two caveats:
1. **Synthetic edges are constructed.** This validates the harness and proves the mechanism
   *can* win when edges align — not that they align in the wild.
2. **Ceiling is a loose upper bound.** `expansionPrecision` ≈ 0.04–0.07 on `all`; a real
   selection policy must fight heavy distractor load to realize the headroom.

## The real-corpus ceiling does not exist for $0

The real EA-180d frozen corpus (`baseline-runner.mjs`/`prep-vault.mjs`) is ingest + reindex
only — it creates **no edges**. `edge-ceiling` there would traverse an empty graph → false
kill. Wild-alignment (derive organic edges over real content, then measure) is deferred to a
follow-up bead (`off.6`), not a blocker.

## Decision

**Option A (Mihir, 2026-08-17):** accept synthetic as the gate; proceed to design the
selective, bounded edge-expansion into `hybridSearch`. Trigger-subset favored. Wild-alignment
de-risked later, after the selective policy is shown to work.
