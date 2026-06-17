# Experiment #1 — Information-vs-Priors Discriminator (pre-registered protocol)

> **STATUS: pre-registration.** The hypotheses, the kill condition, and the decision
> thresholds are fixed HERE, before any data is collected — otherwise the falsifier
> isn't a falsifier. Written 2026-06-13. Gates the whole cortex vision (see
> `docs/superpowers/drafts/2026-06-13-rigorous-memory-landscape-research.md`,
> pressure-test §). **This experiment requires NO consolidation loop** — only the
> re-derivation operation Component A would run, a claim set, and a premise
> manipulation. It can falsify the vision before Stage 1 of the loop is built.

## 1. The question

Daftari's entire moat rests on: **trust = survived independent re-derivations** is a
real signal of *longitudinal robustness*. That only holds if re-derivation
**re-evaluates a claim against the premises/information it is given** rather than
**re-running the model's priors dressed as fresh judgment**. This experiment
measures which.

- **H1 (information-driven — moat holds):** re-derivation verdicts are driven by the
  *premise* a claim is given. Replace the premise with a contradictory one and the
  verdict flips.
- **H0 (prior-driven — moat inverts to ElephantBroker):** verdicts are driven by the
  model's prior about the claim. The verdict is the same whether the premise is true,
  absent, or contradictory → strength is corpus-consensus theater.

## 2. Grounding — test the ACTUAL mechanism

The "claim" is a `derives_from` **edge** (the loop's unit), not an abstract
proposition. For edge `from → to`: *does `from`'s assertion X depend on / derive from
`to`'s assertion Y?* The re-derivation operation is exactly what Component A's pass
would call (the thing that produces `vault_edge_observe` / `vault_edge_contest`). We
manipulate the **premise** = the content of the `to` document.

## 3. Design — one factorial, two questions answered

A premise-validity × prior-congruence × domain design. Premise-validity is
**manipulated**; prior-congruence and domain are **selected** (claim-set strata).

| Factor | Levels | Role |
|---|---|---|
| **Premise validity** | C1 true premise · C3 flipped (coherent contradictory) premise | manipulated within-claim |
| **Prior congruence** | prior-favors · prior-disfavors the claim | selected stratum |
| **Domain** | public/factual · novel/interpretive-institutional | selected stratum |

Plus **C2 prior-only** (claim shown with NO premise) — measures the pure-prior verdict
used to (a) label prior-congruence and (b) test whether axis-agreement is prior-driven.

The discriminating cells:
- **Flipped premise (C3) × prior-favors:** info-driven ⇒ verdict NO; prior-driven ⇒
  verdict YES (prior unmoved). *Cleanest info-vs-prior probe.*
- **True premise (C1) × prior-disfavors (contrarian):** info-driven ⇒ verdict YES;
  prior-driven ⇒ verdict NO. *This is the conventionality-bias cell — folds Exp #2 in.*

## 4. Claim set construction

**Target: ≥120 edges, ≥15 per (prior × domain) cell (2×2 = 4 cells × ~30).**

- **Source.** Mix for validity + control: (a) **real** candidate `derives_from` edges
  mined from a structured vault (FabricSpecs / the test vault) for ecological validity;
  (b) **hand-constructed** edges for the divergent cells (real vaults under-sample
  contrarian + prior-disfavored claims). Label each `real` / `synthetic`.
- **Domain stratum.** *Public/factual* = claims whose truth is in the training corpus
  (the model's "prior" is really memorized fact). *Novel/interpretive* = proprietary
  institutional decisions/framings NOT in any corpus (Daftari's actual domain). The
  thesis is supposed to hold on the novel side; the public side is a contrast.
- **Prior-congruence label.** From C2 (prior-only): elicit each model's verdict on the
  bare claim. `prior-favors` if mean C2 confidence > 60; `prior-disfavors` if < 40;
  discard 40–60 (ambiguous priors don't discriminate). **Pre-register the claim set
  with these labels frozen before C1/C3 collection.**
- **C3 flip construction.** The flipped premise must be a **minimal, coherent,
  genuinely-contradictory** edit of the `to` content — NOT nonsense (a garbage premise
  triggers a NO for the wrong reason = false signal of info-sensitivity). Each flip is
  validated by a held-out strong model + spot human check on two criteria: (i) coherent
  prose, (ii) removes/contradicts the specific support X relied on. Reject flips failing
  either.
- **Controls (≈20% of set):**
  - *Positive control:* trivially-entailed edges (X obviously follows from Y).
    Re-derivation MUST say YES in C1, NO in C3. Failing this = broken setup, abort.
  - *Negative control:* edges where X genuinely does NOT derive from Y (true
    non-edges). Re-derivation should say NO in C1. Catches a yes-bias that would fake
    info-insensitivity.

## 5. Procedure

For each edge, **blind** (the re-deriver never sees that this is an experiment, never
sees any prior strength/verdict), elicit a 0–100 confidence + binary
survives/fails (threshold 50) under three conditions:

- **C2 prior-only:** "Claim: «X». From your own knowledge, how strongly does this claim
  hold? (0–100)" — no premise.
- **C1 true-premise:** "Premise: «Y». Claim: «X». Does the claim derive from / depend
  on the premise as stated? Re-derive it independently; do not assume it is true.
  Confidence (0–100)."
- **C3 flipped-premise:** identical to C1 but with the flipped «Y′».

**Axes (independence/decorrelation sub-measure).** Run every condition across **≥3
genuinely distinct model families** (e.g. Claude + an open model + a third vendor) —
model-diversity is the only axis that truly decorrelates priors. ≥3 repeats per
(edge × condition × model) for stability (vary prompt-framing per repeat = the
prompt axis). ≈ 120 × 3 conditions × 3 models × 3 repeats ≈ 3,200 calls — cheap, days.

## 6. Measures

- **Information sensitivity** `IS = mean(conf_C1 − conf_C3)` over prior-favors edges
  (where info and prior disagree on C3). High IS = premise drives the verdict.
- **Flip rate** = fraction of edges that cross the survives/fails threshold C1→C3.
- **Prior dependence** = partial effect of prior-congruence on verdict after
  controlling for premise-validity (mixed-effects model below).
- **Decomposition (the master variable, quantified):** mixed-effects regression
  `confidence ~ premise_validity + prior_congruence + domain + premise_validity:domain`,
  random intercepts per edge and per model. **`β(premise_validity)` vs
  `β(prior_congruence)` is the answer.**
- **Axis-prior tell:** inter-model agreement in C2 (prior-only) vs C1/C3. If models
  agree MORE in C2 than C1/C3, their agreement is prior-driven, not information-driven
  → the "independent re-derivations" are correlated by shared priors.
- **Conventionality-bias FN rate (folds in Exp #2):** among C1 × prior-disfavors
  (contrarian, true-premise) edges, the fraction the re-deriver wrongly fails.

## 7. Decision rules (PRE-REGISTERED — do not move after seeing data)

- **PASS (H1 — moat holds, proceed to Exp #3 / build the loop):**
  `IS ≥ 40` (on 0–100) **AND** flip-rate ≥ 70% **AND** `β(premise_validity)`
  significantly > `β(prior_congruence)` **AND** holds in ≥2 of 3 model families
  **AND** positive/negative controls behave correctly.
- **FAIL (H0 — moat inverts, STOP and re-think the whole trust model):**
  `IS < 20` **OR** flip-rate < 50% **OR** verdict variance dominated by
  `prior_congruence` **OR** models agree more in C2 than C1/C3. → re-derivation is
  prior-theater; ElephantBroker's external-evidence model is the better signal;
  Daftari's strength signal does not measure what the design claims.
- **PARTIAL (domain-limited thesis):** PASS on novel/interpretive but FAIL on public,
  *or* PASS overall but conventionality-bias FN rate is high (> 30%). → the thesis
  holds only for novel institutional knowledge AND the human `vault_ratify` backstop is
  **mandatory, not optional** — write that into the loop spec's envelope section.

## 8. Confounds + controls (named)

- **Garbage-flip artifact** → §4 flip-validation (coherent + genuinely contradictory).
- **Yes-bias faking info-insensitivity** → negative controls.
- **Tautological claims** (X restates Y) → screen out self-evident edges in §4.
- **Contamination** (public claims memorized) → that's *why* the domain stratum exists;
  the novel/interpretive stratum is contamination-free by construction (post-cutoff /
  proprietary). [See paper-feasibility memo: post-cutoff edits dodge contamination.]
- **Refusal/hedging** → force a 0–100; treat refusal as missing, report refusal rate.
- **Order/wording** → randomize edge order; fixed templates per condition; prompt axis
  varied only in controlled repeats.

## 9. Power / cost

~120 edges × 3 conditions × 3 models × 3 repeats ≈ 3,200 LLM calls. No infrastructure
beyond the re-derivation prompt + the claim set. Days of work. The decomposition needs
~30 edges/cell for a stable mixed-effects estimate — hence the ≥120 target.

## 10. What each outcome feeds

- **PASS** → strength is a real longitudinal-robustness signal; run **Exp #2** (full
  conventionality-bias quantification) then **Exp #3** (§6.1 efficacy vs the
  ElephantBroker Rung-2 baseline). Build the loop (Stage 1) with confidence.
- **FAIL** → the vision's premise is false. The honest pivot: either (a) re-derivation
  must be re-architected to force premise-grounding (e.g. require the re-deriver to
  quote the premise step it used, and reject verdicts that don't), then re-run; or (b)
  concede EB's accumulation model and re-position Daftari on governance/tensions alone.
- **PARTIAL** → narrow the thesis to novel/interpretive knowledge, make `vault_ratify`
  load-bearing, and say so in the paper and the loop spec.

## 11. Limitations

- C3's "flipped premise" tests sensitivity to *contradiction*, a strong manipulation;
  a subtler test (premise *weakened* not *flipped*) is a v2 follow-up — but the strong
  version is the right first falsifier.
- Verdict ≠ ground truth: this measures *what drives the verdict*, not whether the
  verdict is correct. Correctness is Exp #3's job. (Per the reframe, currency not truth
  is the objective — so "what drives re-evaluation" is the right thing to measure first.)
- Model-family diversity is the decorrelation proxy; if all available frontier models
  share a training-data monoculture, even a PASS may overstate real-world independence.
  Report the model set explicitly.
