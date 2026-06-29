# Probe — does the stale value-mention regime exist in real contracts?

**Date:** 2026-06-27
**Branch:** `feat/contract-bench-arms`
**Question:** The accuracy half of the contract benchmark assumes real chains contain the regime where *most-recent-mentioning recency fails* — i.e. a **later** document states an **earlier-governed** clause at a **stale value**. Does that structural feature actually occur in real SEC contracts, and how often? (Read-only; no pipeline.)

## Method

1. **Chain scan (cached real data).** For both cached chains (NGS, 5 docs; PetroQuest, 5 amendment docs), for every clause that receives an operative amendment, check whether any *later* doc re-mentions it non-operatively (a candidate stale mention).
2. **Recital inspection.** Read the recitals of the *later* docs in each chain — the place a stale prior-value recital would live.
3. **Corpus-wide frequency (EFTS hit counts, 8-K).** Compare the operative-amendment idioms against the recital-of-current-text idioms (the only construction that quotes existing clause text).

## Findings

**1. Zero stale mentions across both chains.** No amended clause in NGS or PetroQuest (10 amendment docs) is re-mentioned non-operatively by any later doc. Most-recent-mentioning == governing for every clause.

**2. Structural reason — incorporation by reference, not value recitation.** The recitals show *why*:
- NGS amd-3: *"Capitalized terms used but not defined herein have the meaning set forth in the Credit Agreement, **as amended by this Third Amendment**."* — points to the current consolidated meaning; never quotes a value.
- NGS amd-4: references a Commitment *"in the amount shown opposite the New Lender's name on **Schedule 2.1**"* — points to a (wholesale-replaced, current) schedule.
- PetroQuest amd-12: recitals *describe the change* (*"amend the ratio of Total Debt to EBITDAX"*) — never recite the old value.

**3. Corpus-wide, the operative idiom dominates >100:1.** EFTS 8-K hit counts:

| Idiom | Count | Kind |
|---|---|---|
| `is hereby amended and restated in its entirety` | 10,000 (window cap) | operative → recency-resolvable |
| `is hereby amended to read as follows` | 3,021 | operative → recency-resolvable |
| `currently reads as follows` | 90 | recital-of-current-text |
| `presently reads as follows` | 17 | recital-of-current-text |
| `as currently in effect reads` | 1 | recital-of-current-text |

Operative amendment (≥13,000) outnumbers the *only* construction that quotes existing clause text (~108) by more than 100:1 — and those ~108 co-locate the quoted old text **inside the same operative doc** that amends it (an in-place before/after), not in a *later* doc. The cross-document stale value-mention is essentially nonexistent.

## Conclusion

**The accuracy regime — where most-recent-mentioning recency returns a stale value — is structurally absent in real SEC contract amendments.** It's not an N=2 fluke: it follows from universal drafting conventions (incorporation-by-reference, wholesale schedule/clause restatement, change-description recitals) that keep the most-recent mention current. **On contracts, recency is sufficient for accuracy.**

This is a clean **negative result with a structural + quantitative explanation**, and it refutes the benchmark's original headline premise ("contracts are THE regime where recency fails on accuracy").

## What it means for the arc

Contracts have **explicit, labelable supersession** (why they were chosen) but **good drafting hygiene** (why recency works). The two are linked: the same formality that makes supersession explicit also makes it recency-resolvable. So contracts demonstrate:
- daftari's **mechanism** (resolveCurrentSource follows the chain) — ✅ real data;
- daftari's **no-mint sovereignty** (Arm B; model-dependent advantage) — ✅;
- daftari's **provenance/auditability** (governing source + supersession history per clause) — ✅;
- but **NOT an accuracy regime** where daftari beats recency — ✅ refuted.

**The accuracy regime requires stale value-mentions, which require poor drafting hygiene — i.e. human decision records, not formal contracts.** Where stakeholders restate superseded positions in new threads/meetings without incorporation-by-reference (the [[project_decision_substrate_usecase]] / WorkIQ pain), most-recent-mentioning recency *does* fail. That is the corpus tension: **contracts give explicit-supersession-but-recency-works; human decision streams give recency-fails-but-supersession-implicit.** daftari is built for the intersection (explicit supersession *and* recency fails), which neither corpus alone fully exhibits.

## Recommendation (for the paper direction)

Do **not** keep mining contracts for an accuracy win — it isn't there, structurally. Two honest paths:
1. **Reframe the contract result as sovereignty + provenance** (the no-mint guarantee + per-clause governing-source auditability), with this probe as the headline negative result that *explains why* recency suffices on contracts and where it wouldn't.
2. **Move the accuracy claim to a poor-hygiene corpus** (human decision/stakeholder records) where stale mentions are the norm — the regime daftari was actually built for — using contracts only as the explicit-supersession control.
