# Recall Bench — daftari SP1 baseline (EA-180d)

> **⚠ CORRECTION (2026-06-21):** the "Honest assessment" claim below that daftari *"isn't losing on recall — it's losing on disambiguation"* is **wrong for the majority of failures.** A re-analysis of `questions.jsonl` by `relevantDays` coverage found **68% of hallucinations are recall/coverage misses** (the relevant days were never retrieved), only 32% disambiguation; multi-day questions hallucinate 18.2% vs single-day 9.4%. Many "supersession" failures here are recall failures in disguise (the revision day was never retrieved). The disambiguation story below holds for the *single-day* subset and the Condor spotlight, but not in aggregate. See `2026-06-21-recall-vs-disambiguation.md`.


**Date:** 2026-06-21
**Status:** Baseline complete enough to report. Run stopped at **27/30 checkpoints (days 6–162)** on cost grounds; the remaining 3 (days 168–180) are marginal. **1,489 questions** evaluated — ample.
**Arm:** SP1 baseline only (daftari as-is — `hybrid.ts` untouched, no supersession edges). This is the number SP2/SP3 must beat.

## Setup

- **System under test:** daftari in-process (the `vault_search`/`vault_read` agent loop over a temp vault), **native Claude (`claude-opus-4-8`) answerer + native MiniLM embeddings**.
- **Corpus:** Recall Bench `executive-assistant` 180-day persona (Steven Ickman / Microsoft, MIT). Raw daily-markdown ingest — **zero supersession edges** (`vault_supersede` never called; cortex loop not run).
- **Judges:** `gpt-5.4-mini` (primary) + `gpt-5.4` (appellate), routed through OpenRouter — **same judge models as the published runs**, so judge parity holds.
- **Run config:** sample 50, appellate on, `judgeMemoryWindow` 1, seed 42, parallelism 6.
- Adapter: `integrations/recall-bench/`. Profile: `integrations/recall-bench/profiles/ea-180d-daftari.yaml`. Raw data: `integrations/recall-bench/results/ea-180d-partial-2026-06-21/` (gitignored).

## Headline

| Metric | Value |
|---|---|
| Overall composite | **81.8%** (4.91 / 6) |
| Correctness | 2.41 / 3 |
| Completeness | 1.65 / 2 |
| **Hallucination rate** | **15.2%** (judge flags a fabricated/contradictory atom) |
| Appellate-escalation rate | 22.6% |

**The curve is flat, not a degradation cliff.** Across days 6→162 the composite stays in a tight low-to-mid-80s band (78–88%, two outliers: day-12 99% / day-90 70%); hallucination holds ~10–24%. There's a mild back-half softening (days 120–162 average a few points lower), but no collapse with corpus age. The stale-retrieval rate is a property of the **query mix** (how many questions touch a revised fact), not of how big the corpus has grown.

## Per-category (sorted worst → best)

| Category | n | Composite | Hallucination |
|---|---|---|---|
| recency-bias-resistance | 29 | 66% | **28%** |
| synthesis | 126 | 66% | 21% |
| decision-tracking | 133 | 68% | **24%** |
| cross-reference | 87 | 79% | 20% |
| contradiction-resolution | 113 | 82% | 10% |
| factual-recall | 754 | 85% | 14% |
| negative-recall | 202 | 87% | 13% |
| temporal-reasoning | 45 | 99% | 2% |

## The finding: supersession-blind ranking → confident stale answers

The hallucinations are **not random confabulation** — they are **real corpus values, superseded ones**, reported confidently. Verified chain for the canonical case (Project Condor synergies):

- `day-0005.md` (early draft): base **$18M** / stretch **$26M** cost synergies
- `day-0013/0014.md` (revision — the question's relevant days): base **$28M** / upside **$38M** EBITDA synergies

The question asks for the value as of day 14 (ref = $28M/$38M). daftari's retrieval returned **both** the day-5 draft and the day-13/14 revision; the opus answerer picked the **stale day-5 figure** ("I found the answer in the Day 5 Condor diligence synthesis"). Same pattern on financing ($250M term loan / $50M revolver / 2.8x leverage from early days vs. cash + term debt / 3.2x from the revision) and purchase price ($420–475M early vs. $620–760M revised) — the *same* wrong numbers recur across dozens of independent questions, which is the signature of stale retrieval, not invention.

**Root cause (verified in code), not an artifact:**
- Ranking score is `score = w_bm25·bm25 + w_vector·vector` ([`hybrid.ts:210`](../../../src/search/hybrid.ts)) — pure lexical + semantic similarity. The draft and the revision are *equally* on-topic, so both rank high with no signal distinguishing current from stale.
- daftari *computes* a supersession-aware `decay` and carries `superseded_by` ([`hybrid.ts:221-227`](../../../src/search/hybrid.ts)) — but only as an **annotation attached to the hit**; it never re-enters the score. The decisive signal is calculated and discarded for ranking.
- In a raw corpus there are **zero** supersession edges to even annotate.

This is exactly the seam SP2 (wire supersession into scoring) and SP3 (auto-detect supersession in the cortex loop) target.

**The pattern is sharp in the category data.** The three categories above the 15.2% mean — **recency-bias-resistance (28%)**, decision-tracking (24%), synthesis (21%) — are the ones that probe temporal/supersession robustness; the category *literally named for resisting stale-value bias* is daftari's single worst. The compounding answerer effect is real too: opus doesn't just surface the stale value, it dresses it with fabricated specificity (invents a "2026-01-05" date, $250M/$50M structure) — the Recall Bench postmortem pattern: confident synthesis on top of imperfect retrieval.

## DoD checks

- **Revised-fact categories evaluated post-revision:** the 275 recency-bias-resistance + decision-tracking + contradiction-resolution QAs span relevant days 1–168 and were each evaluated across every checkpoint out to day 162 — i.e. well past their revision day. The headline supersession analysis has data. ✓
- **First retrieval-only evaluation of daftari.** `daftari eval` measures cortex *answer quality* (LLM-judged over a generated subgraph); it has no recall@k/nDCG over a labeled query→doc set. This is the first time daftari's *retrieval fidelity* has been measured against ground truth. ✓

## Honest assessment

- **Cross-system numbers are directional only.** daftari ran native Claude + MiniLM; the published Recall Bench systems ran gpt-5.4 + OpenAI embeddings. The clean, defensible claims here are the **within-daftari** picture and the **failure modes** — not "daftari scores 82% vs system X's Y%."
- **`contradiction-resolution` scoring 82% / 10% halluc is a genuine surprise** and worth not overselling: the category named for contradictions is *not* the worst. The supersession failures concentrate where the stale value is a strong lexical match *and* the question doesn't explicitly cue the correction (recency-bias-resistance, decision-tracking). The simplistic "daftari fails at contradictions" story is too coarse; "daftari has no current-vs-stale signal in ranking, so it fails when the stale value is the better lexical match" is the accurate one.
- **negative-recall (87%) has a real tail:** in some cases daftari over-refuses — claims an entity isn't in the vault when it is — a *retrieval-miss* failure mode distinct from supersession.
- **Run is incomplete (27/30) and cost overran badly.** Measured Anthropic spend ≈ **$400** (~$25 per 7 min), ~3× the pre-run estimate. Driver: ~1.8 full-document `vault_read` calls/question on long dailies, re-sent across a cumulative agent loop (~4.8 tool calls/question) with **no prompt caching**. This gates the SP2/SP3 ablation (3 arms ≈ $1,200 as-is) until caching + token-logging land.

## Kill condition (for the SP2 thesis)

If, on this same corpus, an oracle arm that injects ground-truth supersession edges into ranking does **not** materially cut the hallucination rate in recency-bias-resistance / decision-tracking, the "supersession-blind ranking is the bottleneck" thesis is wrong and the failure is elsewhere (answerer confabulation, retrieval recall). The baseline above is the control for that test.

## Next

1. **Cost controls before any re-run** (prerequisite): prompt caching on the cumulative transcript; cap `maxRounds`/rethink full-doc `vault_read`; log actual token usage (the adapter discards it today).
2. **SP2 oracle arm:** inject supersession edges from the benchmark's `irrelevantAfter`/arc ground truth into `hybrid.ts` scoring; re-measure the three flagged categories.
