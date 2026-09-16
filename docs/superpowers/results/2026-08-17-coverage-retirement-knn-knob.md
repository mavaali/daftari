# Results — MAV-156a coverage retirement + MAV-159 KNN fan-out knob

**Date:** 2026-08-17
**Beads:** MAV-156 option (a) and MAV-159 (multi-hop retrieval epic MAV-155); order per the Fable review — the quantity-frontier knobs land before the graph bet (MAV-154) so the honest baseline exists first.
**Baseline scored against:** the MAV-160 frozen baseline (`integrations/recall-bench/baseline/manifest.json`, results in `2026-08-17-mav160-frozen-baseline.md`).

**One line:** The date-window coverage pass is retired to default-off on twice-confirmed evidence (config opt-in retained for the untested tag half), and the vector KNN fan-out is now a measurable config knob with a ready-to-run sweep instead of a hard-coded 64.

## MAV-156a — the retirement [DATA]

The decision needed no new experiment; the bead's A/B was already run twice:

- 2026-06-22 (original kill, 979 multi-day questions): coverage 0.265 vs rank-extension 0.292 at the shipped budget of 5; rank-extension dominated at **every** budget; per-question, coverage won 6.4% / lost 21.2%. Added-day precision 5.7%.
- 2026-08-17 (frozen 3.7.0 baseline, 191 multi-day questions, upstream-pinned labels, lexical-only): coverage 0.293 vs rank-extension 0.300 at +5, dominance again at every budget ≥ 5, coverage plateau ~0.50, ~4.6 added distractors per fire at ~8% precision.

What shipped:

- A `search.coverage` config knob (`src/utils/config.ts`), default **false**. The gate lives in `vault_search`'s two call sites (local + federation mount) via a module-level `setCoverageEnabled` applied at startup — the same per-process lifecycle as `setProvider`.
- The mechanism (`applyCoveragePass` and its `enabled` option) is unchanged: experiment harnesses keep full explicit control, and the frozen-baseline runner's coverage arm still measures the mechanism against future corpora.
- Not deleted, deliberately: the kill condemned the **date-window half on journals**. The discriminating-tag half was untestable on RB (uniform tags) and remains untested on a native vault — `search.coverage: true` opts a vault back in. If a future native-vault test also fails, deletion is the follow-up; if it wins there, the right fix is splitting the tag-gather from the date-window rather than resurrecting both.
- The third arm of the bead's A/B (edge-guided widening) is MAV-154's bet and stays gated on its $0 reachability ceiling over a consolidation-birthed edge graph.

**Effect on a default vault:** `vault_search` no longer appends score-zero same-tag/date-window docs. Callers who relied on the widening get the measured-better substitute directly: raise `limit` (rank-extension), which dominated coverage at every budget on both runs.

## MAV-159 — the knob, not yet the curve [DATA / gap]

- `search.vec_knn_k` config knob (1–4096, default 64 — the historical constant), applied at startup via `setVecKnnK`; the SQL KNN bound in `src/search/hybrid.ts` now reads it.
- `integrations/recall-bench/knn-sweep.mjs` sweeps K ∈ {16, 32, 64, 128, 256, 512} at budgets {0, 5, 10, 20} over the same frozen corpus, recording multi-day recall and context-distractor load per (K, budget). It **refuses to run lexical-only** (verified: exits 2 with a clear message in this container) because K only affects the vector arm.
- **The recall-vs-K curve itself is the gap**: it needs a machine that can load MiniLM (or an API embedding provider). Until that run exists, 64 stays the default on zero evidence either way — the knob converts the bead's hypothesis from unmeasurable to a one-command experiment: `RB_CORPUS=<recall clone> node integrations/recall-bench/knn-sweep.mjs`.

## Honest assessment

- The retirement's second confirmation is lexical-only. A vector-armed rerun could narrow the coverage-vs-rank-extension gap, but for the decision to flip, coverage would have to go from losing at every budget to **winning by ≥5pp** (the original spec's gate) — nothing in either run's shape suggests the vector arm favors date-proximity over relevance.
- Retirement-by-default changes shipped `vault_search` behavior. The paper trail (June kill → Fable review → frozen-baseline reconfirmation → this note) is the justification; the one-line rollback is `search.coverage: true`.
- MAV-159's acceptance criteria ("recall-vs-K curve; pick K") are **not** met by this change alone — the bead stays open until the sweep runs on a vector-capable machine. What's done: the knob, the sweep, the refusal guard, and comparability with the frozen baseline.
