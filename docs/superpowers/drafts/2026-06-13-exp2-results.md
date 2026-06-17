# Experiment #2 — Premise-Strength × Prior (Conventionality-Bias) — RESULTS

> **Pre-registered verdict (frozen rule, applied as written): RATIFY-MANDATORY**
> (weak-premise FN = 100% ≥ 30%, `strength:prior` interaction significant p≈1e-52).
> **But the disaggregated data shows this is driven mainly by *premise-brittleness*
> (re-derivation correctly withholds support under thin premises, for conventional AND
> contrarian claims) — NOT by a clean prior-driven collapse of contrarian claims.** The
> honest conclusion is narrower and more useful than the label. Run 2026-06-13. Protocol:
> `docs/superpowers/specs/2026-06-13-exp2-premise-strength-protocol.md`. All [DATA].

## 1. The number that matters and what it actually means

| cell | C1 full | C2 absent (=prior) | W weakened | FN under W |
|---|---|---|---|---|
| **prior-favors** (public, n=41) | 93 | **94** | **~40** | W1 52% · W2 85% |
| **prior-disfavors** (novel, n=18) | 83 | 24 | ~20 | W1 94% · W2 100% |

**The tell:** prior-favored claims have a prior of 94 but collapse to ~40 under a weakened
premise. A *prior-driven* (conventionality-bias) model would keep them near 94 — the prior
says "true." They didn't collapse a little; they collapsed below their own prior. So
re-derivation is **reading the weakened premise and judging "X doesn't strongly follow from
this thin support"** — for both classes. That is information-driven behavior (Exp #1's H1),
operating even at intermediate premise strength.

**What's genuine conventionality bias:** the residual gap at *equal* premise strength —
contrarian-weak ≈20 vs conventional-weak ≈40, a ~20-point extra penalty on contrarian
claims. Real, but modest, and partly attributable to the contrarian weakenings removing
slightly more support, not purely to priors.

## 2. Pre-registered metric caveat (discovered after data, reported not hidden)

The frozen FN metric — "prior-disfavored, derivable (C1≥50) claims failing (W<50)" —
**conflates two outcomes**: (a) correctly concluding X does not follow from a *genuinely
weakened* premise (desired), and (b) wrongly rejecting a true claim on priors (the bias).
At W≈C2 for the disfavored cell, the weakening was strong enough to approximate *absence*,
so much of the 100% FN is outcome (a), not (b). The pre-registered rule still fires
RATIFY-MANDATORY (applied as written — no goalpost-moving), but the **label overstates a
clean conventionality bias**; §1's disaggregation is the real finding. A v2 metric needs a
ground-truth anchor for "how much support should W provide" (e.g. a human/again-held-out
rating per weakening), and a *finer* strength gradient to locate where collapse begins.

## 3. Measures (as computed)

- **Weak-premise FN** (disfavored & derivable): **100%** (per-family: claude 100, gpt 100,
  qwen 94). Full-premise FN was 0% (Exp #1).
- **Reassertion index** `(C1−W)/(C1−C2)`: disfavors ≈ **1.0** (W landed at the bare-prior
  level); favors numerically unstable (C1≈C2 → near-zero denominator) — *do not report the
  −18 as meaningful*; use §1's raw levels instead (favors W≈40 ≪ prior 94).
- **Interaction** `strength:prior`: β=−31.2, p≈1e-52 — premise strength matters
  *differently* by prior class, highly significant. Direction: disfavored confidence is
  *more* premise-dependent (no prior cushion); favored has a high prior but, crucially,
  **still collapses under weak premises** (§1).
- **Type-robustness (W1 vs W2):** overall per-edge corr 0.44, verdict-concordance 71.6%
  (moderate; depressed by the high-variance favored cell). On the decision cell both
  variants agree: disfavored FN W1 94% / W2 100%. W2 (vague-hedge) is slightly more
  suppressive than W1 (remove-quantifier), esp. for favored (35 vs 45).
- **Weakening validation:** 155/164 weakenings passed; 9 rejected (7 positive controls +
  pub-pf-022 — entailment-leakage, as flagged pre-run), **zero rejections in the
  novel/disfavored decision cell.**

## 4. The honest conclusion

1. **Re-derivation is premise-driven even at weak strength** (reinforces Exp #1): a thin
   premise yields low derivation confidence regardless of prior. Conventional true claims
   are *not* propped up by their priors when the premise is gutted.
2. **A modest residual conventionality penalty exists** (~20 pts harder on contrarian
   claims at equal premise strength) — present, not dominant.
3. **Re-derivation is brittle to premise quality** — it needs a strong premise to affirm
   *anything* (conventional claims fail 52–85% under weak premises). This is the loudest
   signal in the data and the most consequential for the loop.

## 5. What it means for the loop (the actionable part)

The practical implication **validates the spec's existing design rather than demanding a
new gate.** Cortex-loop spec §4.2 already routes **any action on an edge below
trigger-bearing strength → always-stage → human `vault_ratify`.** Exp #2 shows that weak/
decayed premises drive re-derivation confidence down (low strength) for conventional and
contrarian edges alike — so those edges land in exactly that always-stage tier. Therefore:

- **`vault_ratify` is load-bearing for low-strength / weak-premise edges — confirmed, not
  optional.** The spec's always-stage-below-trigger-strength tier is necessary, not
  decorative. [Resolves the Exp #1 open question: ratify is mandatory *for the weak-premise
  regime*, for a broader reason (premise-brittleness) than narrow conventionality bias.]
- **Currency-tracking works as designed:** a genuinely weakened premise → lower
  re-derivation confidence → the edge surfaces/contests. That's the loop *working*
  (standing-in-light-of-new-information), not failing.
- **Watch over-contestation:** because re-derivation needs airtight premises to affirm,
  aging premises will trigger broad contestation. The aging curve + MIN/MAX interval
  (calibration constants, spec §3.2/§10) should be tuned against this — don't let
  ordinary premise decay mass-contest the conventional core. **New calibration concern for
  the shadow phase.**

## 6. Honest assessment (caveats)

1. **Metric validity** (§2) — the headline FN conflates correct-premise-reading with bias;
   the disaggregation (§1) is the trustworthy finding. The clean "RATIFY-MANDATORY" should
   be read as "ratify is load-bearing in the weak-premise regime," not "re-derivation is
   prior-theater" (Exp #1 already refuted that).
2. **Weakening strength** — for disfavored, W≈C2 (absent); the manipulation approached
   removal. A finer gradient (partial-but-substantive support) is needed to locate where
   the conventional/contrarian split actually opens. v2.
3. **prior↔domain collinearity** (carried from Exp #1: disfavored≈novel) — the interaction
   is prior+domain combined; the favored-collapse argument (§1) is domain-internal to
   public, so it stands.
4. **Floor n** (disfavored n=18) — wide CIs on the residual-bias estimate.
5. **Type-robustness moderate** (corr 0.44) — directionally consistent on the decision
   cell, but W1/W2 differ in degree; report both.

## 7. What it feeds

- **Loop:** make the always-stage-below-trigger-strength tier explicit-and-tested in the
  Stage-3 envelope; add "premise-decay → over-contestation" to the shadow-phase
  calibration watchlist (§5).
- **Exp #3 (§6.1 efficacy)** is the next gate — now with a sharpened expectation:
  re-derivation's value is premise-faithful currency-tracking, and its failure mode is
  brittleness under thin premises, which the budget/ratify envelope must absorb.
- **Exp #2.1 (v2, optional):** finer strength gradient + a ground-truth "support provided"
  anchor, to cleanly separate premise-brittleness from conventionality bias.

## 7a. Addendum — Exp #2.1 cheap probe (Partial level): GRADED, bias peaks at partial

Added one intermediate **Partial (P)** premise level (moderate support) between Full and
Weakened (738 calls), to settle cliff-vs-graded. Mean confidence:

| cell | C1 full | **P partial** | W weak | C2 absent |
|---|---|---|---|---|
| favors (public) | 93 | **80** | 41 | 94 |
| disfavors (novel) | 83 | **47** | 20 | 24 |

- **GRADED, not cliff.** Both classes degrade monotonically; P sits clearly between C1 and
  W (favors retention 0.94; disfavors retention 0.42). The loop's aging curve faces **no
  cliff** — gentle aging is sufficient, mild premise decay does not mass-collapse.
- **The bias peaks at *partial* strength** (the realistic decay regime): conventional
  claims **survive** at P (80) while contrarian claims **fail** (47 < 50) — gap 33, vs 10
  at full. Yet contrarian P=47 is **above** their prior (24), so re-derivation *is* reading
  the partial premise (information-driven), it just **demands a stronger premise to clear
  the survive bar for prior-disfavored claims.** Conventional survive on partial support;
  contrarian need near-full.
- **This resolves §2's metric ambiguity:** the bias is real, not merely a
  weakening-too-aggressive artifact — at partial strength contrarian claims retain genuine
  lift (47 > prior 24) and still fail while conventional pass. Higher evidence bar for
  contrarian claims, quantified.
- **Refined loop implication:** danger zone = **partial premise decay**, where contrarian
  edges slip below trigger-strength while conventional stay safe → they contest/stage
  faster → `vault_ratify` for low-strength contrarian edges is load-bearing *there*. No
  cliff ⇒ aging-curve calibration is freer than §5 feared (gentle aging suffices); the
  over-contestation risk is concentrated on contrarian, not conventional, edges.
- Probe limits: partials not formally validated (intentionally in-between); favors
  retention metric unstable (C1≈C2) — read the raw slope, not the ratio, for favors.

## 8. Reproduce

```
cd experiments/exp1-info-vs-priors
uv run --with httpx python harness.py --phase weak --concurrency 12   # W1 + W2
uv run --with httpx python weakval.py                                  # weakening validation
uv run --with 'pandas,statsmodels,numpy' python analyze_exp2.py        # measures + frozen verdict
uv run --with httpx python harness.py --phase partial --concurrency 12 # §7a cheap probe (Partial level)
uv run --with numpy python slope.py                                    # cliff-vs-graded slope
```
