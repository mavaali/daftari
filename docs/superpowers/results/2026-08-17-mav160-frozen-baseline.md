# Results — MAV-160: frozen recall baseline + edge-bearing labeled corpus

**Date:** 2026-08-17
**Bead:** MAV-160 (blocking `.0` of the multi-hop retrieval epic MAV-155; added per the Fable review, `docs/superpowers/drafts/2026-08-17-off-epic-fable-review.md` findings 2/4/9)
**Harness:** `integrations/recall-bench/{baseline/manifest.json,baseline-runner.mjs,gen-edgehop-vault.mjs,edge-ceiling.mjs}`
**Daftari commit measured:** `29d6a5d` (v3.7.0 line; ranking core unchanged since the 2026-06 benchmarks — only federation plumbing touched `src/search/` after 2026-06-22)

**One line:** The epic's shared scoreboard now exists — a hash-pinned RB baseline every child scores against (with distractor load measured next to recall), plus the first corpus that has BOTH a labeled multi-hop relevant set and an edge graph, and the $0 reachability-ceiling arm MAV-154 is gated on, validated end-to-end.

## What shipped

1. **The freeze** — `baseline/manifest.json` pins the corpus by content, not by reference: upstream repo + commit (`Stevenic/recall @ 8f9340c`), SHA-256 over the 180 day-files and over the QA label file, question filter, vault-construction parameters, seed limit, and the budget grid. `baseline-runner.mjs` refuses to run on a corpus whose hashes drift. Every sibling kill condition references this manifest instead of taking a fresh snapshot.
2. **Distractor load next to recall** — the runner records, per arm per budget: recall over `relevant_days`, added-relevant vs added-distractor counts, added precision, and total context distractor load. This is the deterministic half of the review's finding 1 (the 2026-06-21 placebo showed co-ranked distractors are causally hallucinogenic): a child that raises recall while silently adding distractors is now visible on the shared scoreboard. The LLM-judged hallucination arm reuses these same per-arm candidate sets and stays gated on `ANTHROPIC_API_KEY`.
3. **Labels from upstream, not from a private run** — the June experiments read `questions.jsonl` from an uncommitted results directory (1,489 per-question records). The frozen baseline instead uses the upstream `qa-180d/deep-verification.jsonl`: 316 questions, 273 `ANSWERABLE` after the pinned filter, 191 multi-day. Smaller but citable, hash-pinned, and reproducible by anyone.
4. **The edge-bearing labeled corpus** — `gen-edgehop-vault.mjs` deterministically generates a 150-doc native-shape vault where questions share vocabulary with hub docs while the evidence docs they need are lexically disjoint but edge-connected; edges are written through the real `observeEdge`/`addTension` stores (174 observations, 16 tensions), with half the clusters earned to trigger-bearing, plus deliberate lineage-noise edges so expansion pays a measurable precision cost.
5. **The $0 ceiling arm** — `edge-ceiling.mjs` computes, per question, whether one hop over {all edges | trigger-bearing only | tensions only} can even reach the relevant docs the seeds missed, against rank-extension at the same add budget. Pure graph arithmetic; the analog of the structural-ceiling computation that killed the coverage pass for $0.

## Baseline numbers (3.7.0, lexical-only) [DATA]

`vectorUsed=false` for the whole run — this container cannot load MiniLM (the runner records the flag; arms are only comparable at equal `vectorUsed`). Multi-day subset (n=191), recall over `relevant_days`:

| add budget m | rank-ext recall | coverage recall | rank-ext added distractors | coverage added distractors |
|---|---|---|---|---|
| 0 (top-10) | 0.224 | 0.224 | 0 | 0 |
| 5 | 0.300 | 0.293 | 4.5 | 4.6 |
| 10 | 0.379 | 0.345 | 9.0 | 8.9 |
| 20 | 0.473 | 0.393 | 18.4 | 15.2 |
| 50 | 0.696 | 0.470 | 47.0 | 23.9 |
| 90 | 0.856 | 0.502 | 86.0 | 28.7 |

- **The June shape reproduces on 3.7.0**: seed recall 0.224 (June: 0.22 on the 1,489-question set), rank-extension above coverage at every budget ≥ 5, coverage plateauing at ~0.50 (its structural ceiling; June measured 0.52). The ranker really is unchanged — the corpus-narrowness concern, not staleness, was the right read.
- **The distractor tax is now a number**: reaching 0.70 recall via rank-extension costs ~47 added distractors per question; added precision never exceeds ~10% for either arm. This is the quantity frontier MAV-159/MAV-156a sharpen and the pool MAV-161's suppression must clean.

## Ceiling-arm validation on the edgehop corpus [DATA]

| question type | seed recall | ceiling (all edges) | rank-ext @ same budget | expansion precision |
|---|---|---|---|---|
| hub-hop (n=24) | 0.20 | 1.00 | 0.22 | 0.086 |
| lex-reachable control (n=24) | 1.00 | 1.00 | 1.00 | — |
| cross-tension (n=8) | 0.50 | 1.00 | 0.50 | 0.099 |

Trigger-bearing-only reaches 0.60 on hub-hop (exactly the constructed half), tensions-only 0.69 on cross-tension. The harness discriminates in both directions: edges win where they were built to win, the control shows rank-extension is not strawmanned, and the noise edges keep expansion precision honestly ugly (~9%).

**These synthetic numbers are harness validation, not field evidence.** The edges are constructed to align with the questions, so hub-hop's ceiling=1.0 is true by construction — it demonstrates the *instrument*, not the *bet*. MAV-154's real gate runs this same script on a corpus whose edges were birthed by the consolidation loop (embedding-neighbor candidates), where alignment is the open question the Fable review flagged.

## Honest assessment

- **Lexical-only.** The container cannot reach huggingface.co, so the vector arm never engaged. The manifest and outputs carry `vectorUsed`, and the identical run on a machine with the model is the missing half of the freeze — until it exists, children should quote lexical-only numbers against this run only.
- **273 vs 1,489 questions.** The June analyses used the full generated run set; the frozen set is the upstream-pinned 316/273. The shape agreement (0.224 vs 0.22 seed recall; same dominance ordering) says the smaller set measures the same phenomenon, but point estimates differ in the second decimal and should not be cross-quoted.
- **The consolidation-birthed edge corpus is the remaining gap.** Running `daftari consolidate --mode birth` over the RB vault needs an LLM; it is the one MAV-160 deliverable that cannot be produced offline. Until it lands, MAV-154's $0 ceiling can run only on the synthetic corpus (mechanism check) — its go/no-go still needs the birthed graph.

## What ships from this

- Manifest + runner + generator + ceiling script committed and reproducible (`RB_CORPUS=<recall clone> node baseline-runner.mjs`; `node gen-edgehop-vault.mjs && node edge-ceiling.mjs`).
- MAV-160 acceptance: frozen snapshot ✔ (hash-enforced), recall + distractor curves per budget ✔, edge-bearing labeled corpus ✔ (synthetic; birthed-edge variant documented as the gap), sibling kill conditions can now cite one baseline ✔. Hallucination-judged scoring: harness-ready, key-gated.
