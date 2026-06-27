# Corpus (B) step-1 probe — does recency fail on Wikipedia consensus articles?

**Date:** 2026-06-27
**Gate:** (B) only stands if Wikipedia talk/article history exhibits **recency-failure** (the most-recent assertion of a decided topic ≠ the governing decision) — the same probe contracts *failed* (>100:1 toward clean). Read-only, via the Wikipedia API.

## Verdict: PASSES. Recency fails frequently, with clean human ground truth and editor-provided alignment.

This is the exact mirror image of the contract result, on the same axis (does the most-recent assertion match the governing value).

## Method + findings

**1. Re-discussion volume.** Talk-archive page counts vs. number of settled consensus items:
- Donald Trump: **~214 archive pages** vs. ~76 consensus items.
- COVID-19 pandemic: ~50 archives. Joe Biden: ~23.

**2. Recency-failures, directly observed (the decisive signal).** Scanned the last 500 article revisions per article; counted reverts and consensus-citing reverts. A revert that restores the governing consensus is a *recency-failure*: the most-recent edit asserted a value ≠ the current decision.

| Article | Span | Revert rate | Consensus-citing reverts |
|---|---|---|---|
| Donald Trump | 2026-04-23 → 06-27 (~2 mo) | **18%** (91/500) | 13 — e.g. *"manual rv per [[…#C76\|consensus 76]]"*, *"partial rv per consensus 70"* |
| Joe Biden | 2025-07 → 2026-06 (~1 yr) | 6% (29/500) | 2 — *"…per … RfC 5, after a consensus confirmed…"* |
| COVID-19 pandemic | 2023-10 → 2026-06 | 5% (25/500) | 8 — *"Per talk page current consensus #19; discuss there if there exists a strong case to change it"* |

The consensus-citing reverts target the **current** items of supersession chains (Trump lead wording #11→#17→#50→**#70**; #76 is the latest 2026 item), i.e. editors keep re-asserting against the governing decision and are reverted back to it.

## The two-corpus contrast (same axis, opposite result)

| | Stale/non-governing assertion in a later position? | Why |
|---|---|---|
| **Contracts** (probe 2026-06-27) | **~0** (>100:1 operative-amendment vs. recital-of-text) | drafting hygiene: incorporation-by-reference, wholesale restatement |
| **Wikipedia consensus** | **5–18%** of recent edits reverted; explicit consensus-citing reverts | no hygiene: humans re-litigate, restate, and assert against settled consensus |

## Why this clears two gates at once

1. **Recency-fails (the kill condition):** cleared — the regime is real and frequent.
2. **Alignment labeling (the framing-(A) worry):** substantially cleared — editors *cite the governing consensus item in the edit summary* (`rv per consensus #N`), giving **deterministic, human-provided alignment** between a stale assertion and its governing decision. No LLM aligner needed for that subset → no contamination there either.

Ground truth (the consensus box) is human-maintained; post-cutoff items (Trump #67–76 are 2025–26) handle training contamination. So contamination + alignment + the regime are all addressed.

## Honest precision (don't overclaim)

- A consensus-citing revert proves *most-recent assertion ≠ governing decision* (recency-fails, broadly). It does **not** prove every such edit is a *stale restatement* (re-asserting a specifically superseded value, e.g. an old #50 lead wording) vs. a *novel* non-consensus edit. Both defeat a recency baseline, but the clean daftari case is the stale-restatement subset. The exact split is a **build-time labeling question** — and the edit summaries + diffs let you determine it per instance.
- Revert *rate* varies with contentiousness (Trump 18% is the rich case; Biden/COVID 5–6%). Across the ~8 formal-consensus articles + RfC-closure chains, this is ample labeled signal, but Trump-class articles carry most of it.
- These are public, training-data-heavy topics → the test set must lean on post-cutoff items + perturbation (constrains usable N, same as contracts).

## Status

(B) kill condition **CLEARED**. Wikipedia "Current consensus" is a validated corpus for the accuracy regime: recency fails (5–18%), ground truth is human-labeled (consensus box), alignment is editor-provided (consensus-citing reverts), tensions are genuine, contamination is controllable (post-cutoff + perturbation). **Next: brainstorm the corpus design as a unit** (QA buckets: current-decision / stale-restatement-trap / live-tension-not-supersession; the post-cutoff+perturbation plan; deterministic-vs-aligner labeling), then build the acquisition + the first real run.
