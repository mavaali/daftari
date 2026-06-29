# Design — Revealed-cost archive: does a costly stale-restatement regime exist? (the market question)

**Date:** 2026-06-27
**Branch:** `feat/contract-bench-arms`
**Status:** design only — not yet run.
**Provenance:** brainstormed after surfacing Engram (engram.com, `project_engram`) as the memory-into-weights / token-efficiency pole. Engram's commercial thesis is stronger than daftari's *as a business* (universal, measurable, billable pain); it does not refute daftari's *correctness* thesis, but it exposes the one link daftari has never tested: **is the fabrication-resistance daftari guarantees worth money to anyone?**

---

## The question (and why it is THIS question)

Prior work localized daftari's contract edge to the **partial/tainted clause subset** — the keystone (`docs/superpowers/results/2026-06-27-a-small-experiments.md`): forced Arm B fabricates 4/7 on partial clauses, LLM provenance mis-attributes governing 0/2, daftari 0 by design. That is a *measured correctness* result. It is **not** a market result.

Engram makes the gap unavoidable. They sell **cost reduction** (≈100× fewer tokens) to enterprises including **Harvey (legal)** — daftari's ideal provenance vertical. If the buyer in daftari's strongest vertical accepts lossy-cheap memory, the implicit daftari assumption — *buyers pay for no-mint/provenance over cheaper+lossy* — is live and untested.

So the experiment answers exactly one link in the company-vs-feature chain: **does costly stale-restatement fabrication actually happen to real actors who bear a measurable loss?**

### Premise challenges already resolved (do not re-open)
- **Not the contract corpus.** The accuracy regime is structurally absent in contracts (operative-amendment idioms beat stale-recital idioms >100:1 by drafting convention — `docs/superpowers/results/2026-06-27-stale-mention-regime-probe.md`). Recency wins on contracts. Powering up the contract bench re-runs a refuted premise.
- **Not "more N."** The partial subset is rare *by drafting convention* (2 of 14 NGS clauses), not by sample size. Scaling chains grows the keystone, not the market.
- **Not a simulated Engram arm.** A hand-rolled lossy compressor is a strawman; Engram's claim is *match frontier quality*. Beating a weak compressor proves nothing about them. Testing Engram specifically requires real Engram/Cartridges access (deferred — see NOT in scope).
- **This is not a benchmark.** A corpus can show recency *fails*; it can never show the failure *costs* anyone. Cost must be **revealed**, not asserted. The instrument is therefore an evidence archive, not a runner.

---

## The claim chain (each link is a kill condition)

For daftari to be a company and not a feature:

1. **Regime exists** — systems assert a *superseded* value as current (stale-restatement). *Survived: (B) probe, recency fails 5–18% on Wikipedia Current Consensus.*
2. **Failure is costly** — someone bears a real, attributable loss. **← THIS EXPERIMENT.**
3. **Failure is frequent** — not a once-a-year freak. **← THIS EXPERIMENT.**
4. **Incumbents fail there in practice** — recency / LLM-synth / lossy-learned-memory mint the stale value. *Partially tested (forced Arm B 4/7).*
5. **Buyers prefer no-mint over cheaper+lossy** — willingness to pay. *OUT OF SCOPE — customer discovery, Mihir's to run, not a research task.*

---

## Instrument: a revealed-cost archive (anchor domain = financial / regulatory)

Anchor chosen for one reason: revealed dollar cost is public there. "Firm acted on a superseded rule/threshold" is a documented enforcement genre.

### Search surfaces (public, dollar-denominated)
- SEC / FINRA enforcement actions + AAERs (Accounting & Auditing Enforcement Releases)
- **OFAC sanctions actions** — acting on a delisted/relisted SDN entry is literally stale-restatement
- FinCEN / OCC / CFPB enforcement; PCAOB audit-deficiency reports
- IRS / state-tax penalty rulings where a superseded threshold or rate was applied

### Coding scheme — every candidate incident scored on the chain
| Code | Field | Values |
|---|---|---|
| C1 | **Regime** — value updated, actor asserted the OLD one as current? | `Y / N / ambiguous` (only Y counts) |
| C2 | **Cost** — documented loss | $ figure + source |
| C3 | **Attribution** — loss attributable to the stale value specifically? | `strong / partial / weak` |
| C4 | **Incumbent failure** — would recency / lossy memory reproduce it? | `Y / N` |
| C5 | **Daftari catch** — would no-mint + supersession edge flag it? | `Y / N` + honest note where it would NOT |

### Pre-registered kill thresholds
- **≥5** cases with `C1=Y ∧ C3∈{strong,partial} ∧ C4=Y` → **GREEN** — regime is real and costly; proceed to build.
- **1–4** → **WEAK** — a niche, not a market; revisit framing.
- **0** clean cases after the surfaces are exhausted → **KILL** — in the strongest domain, costly stale-restatement is not revealed → Engram's efficiency thesis wins; daftari is a feature, not a company.

### The decisive adversarial guard (pre-registered)
The dominant confound is **recall vs stale-restatement** — the same one from `project_recall_bench_experiment` ("recall not disambiguation is the dominant failure"; 68% of RB hallucinations were missed-relevant-days). Most compliance failures are *ignorance* ("didn't know the rule changed"), which **daftari also fails** — it cannot supersede with an edge it never received. A case counts **only if** the updated value was *available in the actor's information environment* and the stale one still surfaced. **If most financial cases are recall failures, that is itself the finding: daftari's edge is narrower than even the keystone suggests.** Code this explicitly per case; do not let it pass silently.

### Cross-domain pattern borrowed
Operational-risk **loss-event databases** (ORX, SAS OpRisk): insurers price tail risk by archiving loss events coded by root cause. Borrow their attribution-confidence tiers and dedup discipline — **count the event, not the document** (one enforcement saga spans many filings).

---

## Failure modes
- **Succeeds wildly:** dedup hazard — collapse multi-filing sagas to one event.
- **Fails (0 cases):** a *valid, publishable kill*. Trap to refuse: "but the (B) corpus probe still passed" — corpus ≠ cost.
- **6-month consequence:** GREEN on a confound-laden read → build no-mint for a market that is actually recall-bound → ship the wrong thing (retrieval, not no-mint). The C4 + recall-guard is the only thing that prevents this.

---

## Deliverable
A coded archive table + a written verdict against the pre-registered thresholds, in `docs/superpowers/results/`. Publishable as the "is there a market" section of framing (A) / a build-or-not decision memo.

## How it runs
Web-research evidence hunt via fan-out research agents (banner / deep-research), ~a couple hours of agent time. No code. Anchor domain only (financial/regulatory) for the first pass.

---

## NOT in scope (deferred, with rationale)
- **Other domains** (clinical, software/on-call, org decision records) — anchor on one for depth first; widen only if financial is GREEN or ambiguous. Org-decision-records (`project_decision_substrate_usecase`) is better suited to customer discovery than a revealed-cost archive (soft, undocumented cost).
- **Link 5 (willingness to pay)** — customer discovery, not research; Mihir's to run.
- **Real Engram / Cartridges head-to-head** — the only fair test of Engram specifically; gated on enterprise access daftari does not have. Revisit if access opens.
- **A simulated lossy-memory arm** — strawman risk; excluded deliberately (see premise challenges).
- **Building anything in daftari** — this experiment gates a build decision; it is not itself a build.

## What already exists (reuse, don't rebuild)
- Contract-bench arms + corpus machinery (`integrations/contract-bench/`) — *not reused here* (wrong instrument), but the arm definitions (recency = C4 incumbent model; daftari = C5) are the conceptual baselines.
- (B) Wikipedia Current Consensus corpus + recency-fails probe — already establishes link 1; this experiment does not re-test it.
- Recall-vs-supersession confound analysis (`project_recall_bench_experiment`) — the C4/recall guard is a direct lift.
- Research-agent fan-out (banner / deep-research skill) — the execution harness.

## Related memory
`project_engram`, `project_contract_supersession_benchmark`, `project_recall_bench_experiment`, `project_decision_substrate_usecase`, `project_daftari_thesis`, `project_daftari_paper`.
