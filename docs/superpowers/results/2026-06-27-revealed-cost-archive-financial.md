# Results — Revealed-cost archive (financial/regulatory anchor): the market question

**Date:** 2026-06-27
**Branch:** `feat/contract-bench-arms`
**Design:** `docs/plans/2026-06-27-revealed-cost-archive-design.md`
**Trigger:** [[project_engram]] surfaced the memory-into-weights / token-efficiency pole → exposed the one untested link in the daftari company-vs-feature chain: **is no-mint/provenance worth money to anyone?** (link 2: is stale-restatement fabrication *costly*?)
**Method:** (1) a 4-agent fan-out (SEC/PCAOB, OFAC/FinCEN, FINRA/CFPB/OCC, tax+cross-cutting), then (2) the `deep-research` workflow (100 agents, 17 primary sources, 70 claims extracted, 25 adversarially verified with 3-vote / 2-of-3-to-refute). Primary docs only (treasury.gov, consumerfinance.gov); secondary law-firm summaries used only for corroboration.

---

## The literal result (C1 + cost bar)

Three cases clear a "fits-the-signature + has-a-cost" bar under primary-doc + adversarial verification:

| Case | Cost | Mechanism | Source |
|---|---|---|---|
| MidFirst Bank (OFAC 2022) | **$0** (Finding of Violation, no CMP) | Vendor re-screened existing customers only monthly → stale "clear" status carried for ~14 days after SDN addition | OFAC FOV 2022-07-21 |
| Residential Credit Solutions (CFPB 2015) | $1.5M restitution + $100K CMP | Applied **original** pre-modification loan terms despite a superseding modification on record at transfer | consent order 2015-CFPB-0019 |
| Carrington Mortgage (CFPB 2022) | $5.25M CMP | Furnished **pre-forbearance** delinquent status when its own files reflected the CARES-Act-protected current status | consent order 2022-CFPB-0010 |

**BSI / Servis One (CFPB 2019, $200K + ≥$36.5K)** — the fan-out's survivor — was **REFUTED 1-2** against the primary consent order (¶45, ¶53): the ARM rate data was *received but never entered into the servicing system* ("manually created interest rate adjustment tables… did not keep pace"). That is a data-ingestion/timeliness failure, explicitly excluded. The adversarial pass corrected a fan-out mis-code.

Raw count = **3 → WEAK band** (pre-registered: ≥5 GREEN / 1–4 WEAK / 0 KILL).

## The C4 criterion guts it (the decisive re-reading)

The pre-registered CLEAN definition requires **C4 = "naive recency would *also* fail"** — the test of daftari *differentiation*, not just "better than a broken system." All three survivors share one shape: **the correct value is the MORE RECENT one, and the actor applied an OLDER value.** MidFirst should have used the newer SDN entry; RCS the newer modification; Carrington the newer forbearance status.

[HYPOTHESIS — analysis layered on the report, not the report's own coding] **Naive recency ("return the most-recent value") would get all three RIGHT.** These are *ignore-the-update* failures — solved by recency, by ContextForge's deterministic `wiki.py`, and by Engram's continual-learning alike. They are the **opposite shape** of daftari's keystone (where the correct value is the *older governing* one and recency wrongly grabs the *newer stale mention* — the partial/tainted case from `2026-06-27-a-small-experiments.md`). Under the full pre-registered bar (C4=Y required), the count collapses toward **0–1 → KILL / very-WEAK**: the financial/regulatory anchor does **not** reveal a costly regime daftari *uniquely* addresses.

## The meta-finding (carry this — it spans all three corpora)

**Daftari's distinctive edge (recency-fails) and economic stakes are ANTI-CORRELATED so far.**
- **Contracts:** recency works by drafting convention → daftari's edge is the rare partial subset (`2026-06-27-stale-mention-regime-probe.md`).
- **Financial enforcement:** where there is *money* (RCS $1.5M, Carrington $5.25M), recency works (use-the-newer); the *pure* stale/cadence case daftari fits (MidFirst) carried **$0**; tax/healthcare stale-value errors are real but "settle quietly below the published case record."
- **Wikipedia Current Consensus:** recency fails 5–18% → but low-stakes by construction (`2026-06-27-corpus-b-recency-fails-probe.md`).

Every corpus says the same thing: **where recency fails (daftari's niche), stakes are low or unmonetized; where stakes are high, recency suffices.**

## Confound accounting (the recall guard worked)

The overwhelming majority of candidates across both passes collapsed to the pre-registered exclusions:
- **Recall / ignorance** (never ingested the update / no screening): most OFAC cases (Florida academy did no screening), the PCAOB Total Asia case (never trained on the CAM update).
- **Willful misconduct** (fraud/upcoding): the bulk of SEC revenue-recognition AAERs, healthcare upcoding (UCHealth $23M, Sarasota $12.1M).
- **Data-quality / no-current-value-existed**: BSI (never entered), the OIG wage-index $140.5M (bad input data).
- **Name/entity matching**: Apple ($467K), Cobham ($87K) — current status held, name not connected.
- **Structurally absent**: SEC/PCAOB (GAAP transitions are prospective → mis-adoption or fraud, never stale-restatement).

## Caveats (do not over-kill)
1. **Shallow sweep** — deep-research fetched 17 sources / verified 25 claims; FINRA, SEC/PCAOB, FinCEN-beyond-OFAC, IRS/state-tax, Medicare fee-schedule never reached primary docs. **This count is a floor, not a census.**
2. **Censored sample** — enforcement publishes fraud, not innocent stale-value errors; MidFirst's $0 supports "real but under-monetized." Costly instances may live in private litigation / operational loss the archive cannot see.
3. **C4 re-coding is analysis**, not the workflow's coding — a careful per-case C4 pass would firm it up; the direction is clear.
4. **No doctrinal name** — regulators frame identical mechanics as "inaccurate furnishing," "unfair practices," "data integrity," never "stale-restatement." The regime has no legal handle.
5. **Engram untouched** — they sell efficiency (orthogonal); this says nothing about their commercial thesis.

## Verdict against the design's thresholds

- Raw: **WEAK** (3 by C1+cost).
- Full pre-registered CLEAN bar (C1 ∧ C3≥partial ∧ **C4=Y** ∧ ¬recall): **0–1 → KILL / very-WEAK**.
- **Link 2 (is the fabrication regime costly?) is NOT cleanly confirmed for the financial anchor.** The regime exists; its costly instances are recency-resolvable, and its daftari-differentiated instances are $0 / unadjudicated.

## What it means (displacement named)

This is evidence toward **daftari-is-a-feature, not a company, on the cost-of-fabrication axis specifically.** It does **not** undermine the system/thesis; it redirects the wedge:
- **Strengthens** the framing-(A) pivot to **sovereignty/provenance** (auditability + no-mint as the value, not avoided fines) and the **multi-stakeholder decision-substrate** use case ([[project_decision_substrate_usecase]]), where worth is governance, not dollar-cost-of-error.
- **Weakens** the "costly fabrication regime" *market* thesis — at least where that cost would show up as enforcement dollars.
- **Link 5 (willingness to pay)** remains the open, non-research question (customer discovery).

Full coded candidate tables: fan-out output in session transcript; deep-research result `tasks/wvdjqllkb.output` (run `wf_a50cf3f1-2c9`).
