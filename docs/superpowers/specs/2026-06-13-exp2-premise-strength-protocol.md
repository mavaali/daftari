# Experiment #2 — Premise-Strength × Prior (Conventionality-Bias) — pre-registered protocol

> **STATUS: pre-registration.** Hypotheses and the §7 decision thresholds are fixed
> HERE, before data. Written 2026-06-13, after Exp #1 PASSed
> (`docs/superpowers/drafts/2026-06-13-exp1-results.md`). Exp #2 **merges** the two
> follow-ups Exp #1 named — the *weaken-don't-flip* robustness test and the
> *conventionality-bias* quantification — into one factorial, because they are the same
> question from two ends: **does the model's prior reassert itself as the premise weakens,
> and does it reassert harder for prior-disfavored (contrarian) claims?**

## 1. The question

Exp #1 showed re-derivation is information-driven under a **strong** manipulation (a
*flipped* premise flips the verdict) and that a **full true premise rescues** contrarian
claims (conventionality-FN = 0%). But in the live loop, premises **decay, are partial, or
are absent** — that is *why* re-derivation runs. So:

- **H_unbiased (ratify optional):** as the premise weakens, confidence degrades
  **gracefully and symmetrically** across prior classes. Contrarian-but-derivable claims
  are not rejected disproportionately.
- **H_bias (ratify mandatory):** as the premise weakens, the model **snaps back to its
  prior**, rejecting prior-disfavored (contrarian) claims more than prior-favored
  (conventional) ones. → re-derivation under-trusts the most valuable (contrarian)
  knowledge once support thins → `vault_ratify` is load-bearing, not optional.

## 2. Design — premise-strength × prior-congruence

A 5-point premise-strength continuum × the frozen prior-congruence label. **Three points
are already collected in Exp #1** and reused as-is:

| Strength | Condition | Status |
|---|---|---|
| Full (entailing) | C1 | reused from Exp #1 |
| Weakened — remove-quantifier | **W1** | new |
| Weakened — vague-hedge | **W2** | new |
| Absent (prior-only) | C2 | reused |
| Flipped (contradictory) | C3 | reused (anchor) |

- **Prior-congruence** = the **frozen C2 labels from Exp #1** (favors>60 / disfavors<40 /
  discard 40–60). Not re-elicited.
- **Two weakening types** (W1, W2) guard against the effect being an artifact of *how* we
  weaken; they must agree (§6 type-robustness) or the result is inconclusive.

## 3. Claim set — reuse Exp #1 (frozen)

Runs on `experiments/exp1-info-vs-priors/claimset_frozen.json` (94 edges, frozen labels).
**No new corpus** — the research doc's "event-validated contrarian" stratum is *not*
required: the bias is measurable from claims that are (a) prior-disfavored [C2<40, frozen]
and (b) genuinely derivable [C1 high, established in Exp #1]. Exp #1's **novel/disfavored
cell (n=18, C1≈83)** is exactly that stratum, and it is contamination-free (post-cutoff
public repos). Net-new authoring: W1 + W2 per non-negative-control edge (~82 × 2).

## 4. Weakening construction (the crux — analog of Exp #1's flip)

For each edge, from the true premise Y:
- **W1 (remove-quantifier):** delete the specific mechanism / causal link / quantifier
  that makes X *follow*, keeping the topical scaffold. Result is *consistent with* X but
  does **not entail** it.
- **W2 (vague-hedge):** rewrite Y with hedged, non-committal language ("can be relevant,"
  "is among the factors"). On-topic, fluent, non-entailing.

**Validation** (held-out model, reusing `flipval.py`'s rubric, re-pointed): each W must be
(i) **coherent** prose AND (ii) **non-entailing** (X should *not* clearly follow) AND
(iii) **not a flip** (must not *contradict* X — that's C3). Failing any → reject and
re-author. Plus a human spot-check of a sample.

## 5. Procedure

Reuse the Exp #1 harness with two new conditions reading `to_premise_weak_quant` /
`to_premise_weak_hedge`. **Blind**, 3 families × 3 repeats (prompt axis), force a 0–100 +
binary survives/fails (threshold 50). ≈ 94 × 2 × 3 × 3 ≈ **1,692 new calls** (C1/C2/C3
reused). Same ZDR routing; the human runs the egress (egress-guardrail pattern).

## 6. Measures

- **Prior-reassertion index** (per edge): `(C1 − W) / (C1 − C2)` where W = mean(W1,W2).
  ~0 = premise still carries the verdict; ~1 = the bare prior has reasserted. **Bias =
  reassertion(disfavored) ≫ reassertion(favored).**
- **Weak-premise FN rate** (the decision number): among **prior-disfavored,
  genuinely-derivable** edges (novel/disfavored, C1≥50), the fraction that now **fail**
  (mean conf < 50) under a weakened premise. (Under the *full* premise this was 0%.)
- **Interaction:** mixed-effects `confidence ~ strength * prior + domain + (1|edge) +
  (1|model)` (strength ordinal: absent 0 / weak 1 / full 2). The **`strength:prior`** term
  is the bias, quantified.
- **Type-robustness:** W1 vs W2 agreement (correlation of per-edge confidence; verdict
  concordance). Disagreement ⇒ INCONCLUSIVE (artifact of weakening style).
- Per-family + per-domain breakdowns (as Exp #1).

## 7. Decision rules (PRE-REGISTERED — do not move after seeing data)

- **RATIFY-MANDATORY (H_bias):** weak-premise FN ≥ **30%** AND a significant
  `strength:prior` interaction (disfavored degrades more). ⇒ re-derivation under-trusts
  contrarian knowledge as premises thin → `vault_ratify` is load-bearing; **write it into
  the loop's Stage-3 envelope as mandatory**, not optional.
- **RATIFY-OPTIONAL (H_unbiased):** weak-premise FN < **15%** AND no significant
  interaction. ⇒ graceful, symmetric degradation → ratify is a safety net, not required
  for correctness; the loop may auto-act on strength alone within the budget.
- **INCONCLUSIVE:** FN in [15%, 30%), OR W1/W2 disagree (type artifact), OR floor-effect
  CIs too wide. ⇒ report; refine weakening and/or expand the novel/disfavored cell; re-run.

(30% reuses Exp #1 §7's PARTIAL line for cross-experiment consistency.)

## 8. Confounds (named)

- **prior↔domain collinearity** (carried from Exp #1: disfavored≈novel) — the interaction
  is prior+domain combined. The **clean decision number is the novel/disfavored
  weak-premise FN**, which stands regardless of the confound.
- **Weakening that accidentally flips** (becomes contradiction, not attenuation) → §4
  validation rejects contradicting W's.
- **Floor effects** — novel/disfavored n=18 → wide CIs; reported. Expanding this cell is
  the INCONCLUSIVE remedy.
- **Weakening-style artifact** → the two-type (W1/W2) robustness check.

## 9. What already exists (reuse, don't rebuild)

- **Harness** (`harness.py`) — add W1/W2 to the condition map + prompt builder; resume
  logic, ZDR routing, blinding all reused.
- **Claim set** (`claimset_frozen.json`) + the C1/C2/C3 records (`raw/results.jsonl`).
- **Flip-validator** (`flipval.py`) — re-point the rubric to "non-entailing, not
  contradicting" for W-validation.
- **Analyzer** (`analyze.py`) — add the reassertion index, weak-FN, and `strength:prior`
  interaction; the loaders/per-family/per-domain machinery is reused.

## 10. NOT in scope (deferred, one-line rationale)

- **Event-validated contrarian corpus** — dissolved by the reframe (§3); not needed to
  measure the bias. Revisit only if external-validity reviewers demand real-world
  vindication (a paper-time concern, not a loop-gating one).
- **Continuous strength gradient (>2 weak levels)** — one level × two types is the first
  test; a finer curve is a v2 follow-up if the slope is interesting.
- **Subtle-premise *paraphrase* (same strength, reworded)** — that's an axis-robustness
  check, not strength; separate.

## 11. What each outcome feeds

- **RATIFY-MANDATORY** → `vault_ratify` is written into the loop's Stage-3 envelope as a
  hard gate for low-strength / contrarian edges; the loop never auto-acts on
  prior-disfavored content without human ratification. Then Exp #3 (§6.1 efficacy).
- **RATIFY-OPTIONAL** → the strength signal alone (within the trust budget) suffices for
  auto-action; ratify stays the escalation path for the always-stage tier only. Proceed to
  Exp #3 with a simpler envelope.
- **INCONCLUSIVE** → refine and re-run before the Stage-3 envelope is finalized; Stage 1
  (scheduler) is epistemics-independent and proceeds regardless.
