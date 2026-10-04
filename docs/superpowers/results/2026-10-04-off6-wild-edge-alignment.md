# Results — off.6 / MAV-181: edge expansion on organically-born edges

**Date:** 2026-10-04
**Bead:** off.6 / MAV-181 (follow-up to off.1 graph-augmented retrieval, epic MAV-155)
**Harness:** `integrations/recall-bench/off6-rb-birth.sh` → `consolidate --mode birth` → `replay-birth-trace.mjs` → `edge-ceiling.mjs`
**Daftari commit measured:** `69a5a18` (3.16.0 line)
**Corpus:** frozen RB baseline (`baseline/manifest.json`, `Stevenic/recall @ 8f9340c`), 180 day-docs, 273 ANSWERABLE questions, `vectorUsed=true`

**One line:** The kill condition tripped. On edges born by the real consolidate loop, one hop of edge expansion reaches *fewer* relevant docs than plain rank-extension at the same add budget — 0.733 vs 0.850 recall — and only 2.6% of what it adds is relevant. Edge expansion stays off.

## Why this run

off.1's $0 ceiling cleared only on the synthetic edgehop corpus, where the aligned edges are constructed. Whether edges born from real content align with labeled relevance was unmeasured. The 2026-08-18 birth trace that would have answered it lived in `/tmp` and was wiped on 08-23; this run rebuilt it through a durable pipeline.

## Birth + replay [DATA]

- 180/180 docs born, 7,200 Haiku 4.5 calls (cap 8,000), 8.08M input / 1.18M output tokens.
- Replay re-applied every journaled verdict the per-session envelope refused: 1,640 observed, 1,574 judged unrelated, 371 duplicate pairs skipped, 0 errored → **1,650 edges in store**.

## Ceiling [DATA]

Seeds = top-10 hybrid hits (seed recall 0.3432; 213/273 questions miss at least one relevant doc). Rank-extension gets the same add budget as the expansion set.

| subset | mean add budget | ceiling recall | rank-ext recall | expansion precision |
|---|---|---|---|---|
| all (tensions + every non-revoked derives_from) | 77.2 | **0.733** | **0.850** | 0.026 |
| trigger-bearing only | 0 | 0.343 | 0.343 | — |
| tensions only | 0 | 0.343 | 0.343 | — |

Per question on `all`: edges win 39, lose 96, tie 138.

## Reading

- **Kill (MAV-154 reading):** `ceilingRecall <= rankExtRecall` at matched budget on the target corpus → edge expansion cannot win; do not build further on it. The `all` arm is an upper bound (it assumes every expansion doc is used), and it still loses by 0.117.
- **Why:** birth edges are dense and weakly selective — ~9 per doc, and a one-hop neighborhood of the top-10 spans ~77 docs, of which ~2.6% are relevant. Rank-extension spends the same budget on the ranker's own next-best docs and does better.
- **Untested:** the `trigger` subset is empty because births are k=0 candidates; only revision panels earn trigger-bearing strength. Whether *reinforced* edges align better is open, and only worth testing if revision runs in production.

## Consequence

`search.graph_expand` already defaults to `enabled: false` (subset `trigger`), and no live vault enables it — no code change. Revisit only behind a revision-reinforced edge set, with this run as the baseline. Artifacts: `ceiling-summary.json` / `ceiling-perq.json` from the run's `WORK/rb/ceiling`.
