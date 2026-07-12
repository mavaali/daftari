# Regression Suite — Design

**Date:** 2026-07-07
**Status:** Approved (brainstormed with Claude in career session; picked up here)
**Problem:** daftari has ~20 measurement results, seven benchmark runners, and a Recall Bench adapter — and none of it gates a release. The runners are hand-run scripts with hardcoded paths. A regression in supersession ranking or staleness detection ships silently, and the June results (e.g. "never stale, 12/12") decay into unverified claims.

**Goal:** promote the existing one-off measurements into a pinned regression suite that CI runs. Mostly plumbing and fixture-pinning, not new science.

## Architecture: three tiers, two harnesses

```
Tier 1  PR gate      vitest   test/regression/staleness/   supersession & staleness properties
                              test/regression/retrieval/   lexical BM25 hit@1/hit@5
                              → diff vs committed baselines/*.json; any per-query regression fails CI

Tier 2  Nightly      bench/   vector + hybrid retrieval (MiniLM), granularity arms
Tier 3  Pre-release  bench/   LLM-judge answer quality (Recall Bench adapter path)
                              → tolerance semantics; retry-once on MiniLM load flake
```

- **Tier 1** runs hermetic: committed fixture vaults and query sets in `test/regression/fixtures/`, no `/tmp`, no network, no model loads. One new job in `ci.yml`.
- **Tiers 2–3** live in `bench/` (promoted from `integrations/recall-bench/`, paths de-hardcoded), run by a new `bench.yml` workflow: cron + manual dispatch for Tier 2, manual dispatch for Tier 3.

## Baseline philosophy: committed goldens, not thresholds

The suite writes `baseline.json` with **per-query outcomes**, not aggregates. CI fails on any regression against the committed file. An improving PR re-commits the baseline, so every behavior change is visible in review. Fixed thresholds were rejected (silent drift; hand-edited floors); tolerance bands were rejected for hermetic tiers (BM25 is deterministic — a noisy hermetic metric is a bug, not a band).

`npm run regression:update-baseline` regenerates the files and refuses to run on a dirty tree, so the delta always travels with the PR that caused it.

## Tier 1 suites: invariants vs. goldens

The staleness suite reuses the CO2 corpus and Arm C resolver (`docs/superpowers/results/2026-06-28-corpus-b-co2-pilot.md`). Assertions split into two classes because they fail differently:

**Invariants** — property assertions, never baseline-diffed; a violation is red regardless of history:
- *Never stale:* every scorable instance resolves to governing or abstain (currently 12/12). A stale value returned as current fails unconditionally.
- *Abstain on dead-ends:* all no-mint dead-ends abstain rather than guess (currently 5/5).

**Goldens** — per-instance snapshots in `baseline.json`:
- *Governing coverage:* which instances marker-confirm (currently 7/12). Widening the diff window — the deferred CO2 refinement — updates this 7→10 in the same PR; a refactor that drops 7→5 fails CI naming the two instances.
- *Scorability classification:* which instances flag multi-hunk (currently 2/14), so classifier drift cannot quietly shrink the corpus.

An invariant flip means the product's promise broke. A golden flip means behavior changed and a human must confirm that was the point of the PR.

The retrieval suite is all goldens: port `integrations/recall-bench/native-regression-runner.mjs` — commit the native-shape vault and `queries.jsonl` as fixtures; record hit@1/hit@5 per query per granularity arm, lexical-only weights (`{bm25: 1, vector: 0}`).

Estimated new code: fixture relocation, a vitest wrapper around the existing Arm C resolver and `hybridSearch` calls, baseline load/diff/update helpers — ~200 lines.

## Tiers 2–3: semantics

**Tier 2 (nightly):** vector/hybrid runners (`chunkbm25`, `granularity`) with repo-relative paths and `RUNNER_TMPDIR`; retry-once on the known MiniLM load flake. Compare against `bench/baselines/nightly.json` with tolerance bands (±0.02 on aggregate hit rates; per-query flips reported, only aggregate breaches fail — vector scores are float-unstable across platforms). A red files a GitHub issue with the diff; it blocks nothing. Nightly reds must be cheap to triage or they get ignored.

**Tier 3 (pre-release, manual dispatch):** Recall Bench adapter path with the Claude answerer and LLM judge. Requires `ANTHROPIC_API_KEY` from repo secrets, a hard per-run request cap, and a fixed question set so runs are comparable. Gate: release tags require a Tier 3 run newer than the last baseline-affecting merge — enforced by convention in `CONTRIBUTING.md` first, automatable later. Results append a dated note to `docs/superpowers/results/`.

## Failure semantics

| Tier | Red means |
|---|---|
| 1 | Merge blocked |
| 2 | Issue filed |
| 3 | Release blocked |

## Vector-arm placement

The PR gate stays lexical-only plus supersession properties. MiniLM-weighted retrieval runs in Tier 2, where a retry policy is acceptable — the flake risk lives there, not in the gate.

## Sequencing

Tier 1 alone is a shippable milestone and the highest value: roughly a day, since the CO2 fixtures and runners exist. Tiers 2–3 are separable follow-ups. Ship Tier 1 first.
