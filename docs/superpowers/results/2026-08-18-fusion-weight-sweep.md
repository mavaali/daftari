# Results — fusion weight sweep: DEFAULT_WEIGHTS 0.5/0.5 → 0.8/0.2

**Date:** 2026-08-18
**Thread:** the fusion-weights question opened by the MAV-159 K-sweep and confirmed by the vector-armed MAV-160 baseline (both found the 0.5/0.5 hybrid trailing lexical-only on multi-day recall).
**Run:** `weight-sweep.mjs` on the operator's machine (local MiniLM, K=256, frozen `rb-ea180d` corpus hash-verified, 273 questions, 191 multi-day).

**One line:** The recall-vs-weight curve is an inverted U — a light vector contribution (bm25 0.7–0.9) beats both the historical 0.5/0.5 (the worst measured vector-on setting) and pure lexical at most budgets — so the fusion default moves to 0.8/0.2 and becomes a per-vault config knob (`search.weights`).

## The curve [DATA]

Multi-day subset (n=191), recall over `relevant_days`:

| bm25 weight | @+0 | @+5 | @+10 | @+20 |
|---|---|---|---|---|
| 0.5 (old default) | 0.218 | 0.292 | 0.354 | 0.458 |
| 0.6 | 0.228 | 0.304 | 0.372 | 0.472 |
| 0.7 | 0.237 | 0.313 | 0.370 | **0.479** |
| **0.8 (new default)** | **0.239** | **0.314** | 0.373 | 0.478 |
| 0.9 | 0.238 | 0.314 | 0.375 | 0.475 |
| 1.0 (pure lexical) | 0.224 | 0.300 | **0.379** | 0.473 |

- **The vector arm earns its keep as a tiebreaker, not a co-ranker.** The 0.7–0.9 plateau beats *both* endpoints at three of four budgets: ~+1.4–1.5pp over pure lexical at the default-serve budgets (+0 and +5), while the equal split costs ~2pp everywhere. The earlier "MiniLM hurts" finding sharpens to "the *weighting* hurt, not the arm."
- **0.5/0.5 was the worst measured vector-on setting** — a uniform ~−2pp against the plateau at every budget. The flip fixes a measured regression in the shipped default.
- **The plateau is broad** (0.7–0.9 within ~0.3pp of each other), so the exact point is not load-bearing; 0.8 is its center. Distractor load is flat across the grid (~8.65–8.74 at +0, marginally lowest on the plateau).

## Harness integrity [DATA]

- The bm25=1.0 arm reproduces the in-container lexical-only baseline **to four decimals in every cell** — the deterministic lexical ranker is byte-identical across machines.
- The bm25=0.5 arm reproduces the vector-armed baseline identically. Three runs, two machines, exact agreement wherever determinism predicts it.
- The per-query `vectorUsed` guard (added in #444 review) held throughout — no silent lexical fallback blended into any arm.

## What shipped

- `DEFAULT_WEIGHTS` (a compile-time constant since the first release) becomes runtime state: default `{ bm25: 0.8, vector: 0.2 }`, set at startup from the new `search.weights` config block (validated: numeric, non-negative, sum > 0, unknown keys rejected), same lifecycle as the other retrieval knobs. Per-query `weights` on `vault_search` still override everything.
- The baseline manifest's weights note updated to describe the new default.

## Honest assessment

- Same evidentiary shape as the K flip: one corpus, unpaired means, individual deltas at the ~±2pp noise floor — but uniform in direction across every budget and the whole plateau, and the flip corrects the *worst* measured setting rather than chasing the best.
- Journal-shaped corpus; a vault whose queries are paraphrase-heavy (where BM25 has nothing to grip) may want more vector weight — that is exactly what the config knob is for. The pure-semantic path (`weights: {bm25: 0, vector: 1}`) is unaffected.
- Day-level recall, not answer quality; the hallucination-judged arm remains the epic's outstanding scoreboard.
