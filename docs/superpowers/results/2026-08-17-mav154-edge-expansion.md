# MAV-154 / off.1 — Selective edge-expansion vs rank-extension (synthetic edgehop)

**Date:** 2026-08-17
**Arm:** `integrations/recall-bench/edge-expansion-runner.mjs`
**Corpus:** synthetic edgehop (`gen-edgehop-vault.mjs`) — 150 docs, 174 edge observations, 16 tensions, 56 queries
**Pins:** `now=2026-08-17T00:00:00Z`, seed limit 10, subset `trigger` (tensions + trigger-bearing derives_from), `vectorUsed=true`
**Sweep:** cap ∈ {5, 10, 20} × tau ∈ {0.2, 0.3, 0.4}

## What this measures

The `$0` **ceiling arm** (`edge-ceiling.mjs`, banked in `2026-08-17-mav154-edge-ceiling.md`)
proved one hop can *reach* the relevant docs the ranker missed — an inject-ALL upper
bound. This **selective arm** measures how much of that headroom the *shipped* policy
(`src/search/graph-expansion.ts`: tau-floored, affinity-ranked, capped) realizes, against
the honest baseline the bead names: **rank-extension at the same realized add budget**
(reading `SEED_LIMIT + |injected|` deep in the ranked list).

**Kill condition (bead):** if selective expansion recall ≤ rank-extension recall at matched
budget, retire — the graph adds nothing over reading further down the list.

## Result — kill condition NOT triggered

Expansion recall ≥ rank-extension recall in every cell, and strictly greater exactly where
multi-hop reach matters.

### hub-hop (n=24, seedRecall 0.20) — the headline win

| cap | tau | expansionRecall | rankExtRecall | Δ | meanBudget | addedRel | addedDist | precision |
|----:|----:|----------------:|--------------:|----:|-----------:|---------:|----------:|----------:|
| 5  | 0.2–0.4 | 0.3667 | 0.20 | **+0.167** | 5.0 | 0.83 | 4.17 | 0.167 |
| 10 | 0.2–0.4 | 0.5250 | 0.20 | **+0.325** | 10.0 | 1.63 | 8.38 | 0.163 |
| 20 | 0.2–0.4 | 0.5917 | 0.20 | **+0.392** | 19.5 | 1.96 | 17.5 | 0.098 |

Rank-extension stays pinned at 0.20 — the relevant hub-hop docs are simply not in the
ranked tail, so reading deeper cannot recover them. Only the edge does. `tau` has **no
effect** on hub-hop: every aligned neighbor clears even tau=0.4 (a property of the
constructed corpus; on a wild corpus the floor will bite).

### cross-tension (n=8, seedRecall 0.50)

| cap | tau | expansionRecall | rankExtRecall | Δ | meanBudget |
|----:|----:|----------------:|--------------:|----:|-----------:|
| 10 | 0.2 | 0.625 | 0.50 | **+0.125** | 10.0 |
| 10 | 0.3 | 0.5625 | 0.50 | **+0.063** | 3.75 |
| 10 | 0.4 | 0.500 | 0.50 | 0 | 1.0 |
| 20 | 0.2 | 0.7188 | 0.50 | **+0.219** | 19.0 |

Expansion wins at low tau; **tau=0.4 over-prunes** the tension neighbors (budget collapses
to 1, Δ→0). tau=0.3 keeps a positive delta at a fraction of the distractor load.

### lex-reachable (n=24, seedRecall 1.00) — no harm, tau earns its keep

Seeds already fully recall these. Expansion adds only distractors (addedRelevant 0,
precision 0) but **never lowers recall (Δ=0)**. Raising tau 0.2→0.3 sheds distractor load
(meanBudget 4.5→3.1) at zero recall cost — the floor's job on already-solved queries.

## Default choice: cap=10, tau=0.3 (the seeded defaults hold)

- **cap=10** captures most of the hub-hop win (0.525) at half the distractor load of cap=20
  (8.4 vs 17.5 added distractors for +0.067 more recall — diminishing returns).
- **tau=0.3** is the balance point: hub-hop is tau-insensitive (win preserved), cross-tension
  keeps a positive delta (tau=0.4 would kill it), and lex-reachable distractor load drops
  vs tau=0.2. `SEARCH_TUNING_DEFAULTS.graphExpand` is unchanged (`cap:10, tau:0.3`).

## Honest caveat

This is the **synthetic** edgehop corpus: its aligned edges are constructed, so this
validates the harness **and the selection policy** — not wild alignment. Whether real
vault edges carry the same query-affinity signal is unproven and deferred to **bead off.6**
(wild-alignment validation on the frozen EA-180d corpus). Ship remains **default-off**
until off.6 clears.

## Repro

```bash
node integrations/recall-bench/gen-edgehop-vault.mjs
npm run build
node integrations/recall-bench/edge-expansion-runner.mjs
# → /tmp/edgehop/expansion-summary.json, expansion-perq.json
```
