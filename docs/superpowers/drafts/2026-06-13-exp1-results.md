# Experiment #1 — Information-vs-Priors Discriminator — RESULTS

> **Verdict: PASS (H1 — re-derivation is information-driven; the moat holds).**
> Run 2026-06-13. Pre-registered protocol:
> `docs/superpowers/specs/2026-06-13-exp1-information-vs-priors-protocol.md` (§7
> thresholds frozen *before* data; not moved). Harness, claim set, and analysis:
> `experiments/exp1-info-vs-priors/`. All numbers below are [DATA] from this run
> unless marked.

## 1. One-paragraph answer

Re-derivation **re-evaluates a claim against the premise it is given**, not against the
model's prior. Flip the premise and the verdict flips: information sensitivity
`IS = 86.4` (PASS ≥ 40), flip-rate `95.2%` (PASS ≥ 70%), `β(premise)=86.4 ≫
β(prior)=5.1` (prior not significant, p=0.17). It holds in **all three** model families
and — decisively — **on the contamination-free novel arm on its own** (novel IS=80.6,
flip=100%, conventionality-FN=0%). Daftari's `strength = survived independent
re-derivations` measures what the design claims it measures. The moat does **not** invert
to ElephantBroker's accumulation model. Proceed to Exp #2/#3 and build the loop (Stage 1).

## 2. What was run

- **Claim set:** 94 edges (`experiments/exp1-info-vs-priors/claimset_frozen.json`).
  public/favors 22 · public/disfavors 20 · novel/favors 13 · novel/disfavors 15 ·
  positive controls 12 · negative controls 12. Novel stratum sourced from **public,
  post-cutoff repos** (daftari created 2026-05-17; agentic-trust-protocol 2026-03-04) →
  contamination-free by construction (both postdate the Jan-2026 training cutoff). 13
  private-sourced edges were dropped pre-run to avoid IP egress
  (`claimset_dropped_private.json`).
- **Models (decorrelation axis, protocol §5):** `anthropic/claude-opus-4.8`,
  `openai/gpt-5`, `qwen/qwen3-235b-a22b-2507` — three distinct vendor lineages
  (US/US/CN) via OpenRouter, zero-data-retention routing.
- **Conditions:** C2 prior-only · C1 true-premise · C3 flipped-premise. 3 repeats each
  (prompt-framing axis), blind. **2,538 calls, 0% refusal.**

## 3. The realized design (reported, not corrected — pre-registration intact)

C2 confirmed prior labels (favors > 60 / disfavors < 40 / discard 40–60). The labels
collapsed prior-congruence onto domain:

| | prior-favors | prior-disfavors | discard |
|---|---|---|---|
| public | **40** | 0 | 2 |
| novel | 1 | **18** | 7 |

Models confidently affirm memorized public facts (favors ≈ public) and are skeptical of
unseen post-cutoff institutional claims (disfavors ≈ novel) — *regardless* of which way
each edge was intended. Two consequences, both handled honestly rather than by changing
the frozen set:
1. **prior and domain are collinear** → the β(prior) vs β(domain) split is unreliable;
   but β(premise) dwarfs both, so the headline is unaffected.
2. **the two discriminating probes map onto the diagonal** — C3-flip on prior-favors
   (public) and C1-conventionality on prior-disfavors (novel). Both pass (below).

The novel/favors → disfavors collapse is itself a finding: models *start* skeptical of
novel institutional knowledge. Whether the true premise moves them is exactly what C1
measures — and it does (§4).

## 4. Measures (protocol §6)

| Measure | Result | Threshold | |
|---|---|---|---|
| Information sensitivity `IS = mean(C1−C3)` over prior-favors | **86.4** | PASS ≥ 40 / FAIL < 20 | ✅ |
| Flip-rate (C1≥50 ∧ C3<50) | **95.2%** (40/42) | PASS ≥ 70% / FAIL < 50% | ✅ |
| Mixed-effects β(premise) vs β(prior) | **86.4 vs 5.1** (prior p=0.17, n.s.) | premise > prior | ✅ |
| Axis-prior tell: inter-model agreement C2 vs C1/C3 | C2=0.85 < C1=0.96, C3=0.99 | C2 must NOT exceed | ✅ (not prior-driven) |
| Conventionality-bias FN (C1 × prior-disfavors fails) | **0.0%** (0/18) | PARTIAL if > 30% | ✅ |
| Positive controls (C1-YES, C3-NO) | 100% / 100% | ≈100% | ✅ |
| Negative controls (C1-NO) | 100% | high | ✅ setup valid |

**Per-family** (PASS needs ≥2 of 3; got 3 of 3):

| family | IS | flip | conv-FN |
|---|---|---|---|
| claude-opus-4.8 | 79.8 | 95.2% | 5.6% |
| gpt-5 | 86.9 | 92.9% | 16.7% |
| qwen3-235b | 92.5 | 97.6% | 0.0% |

**Per-domain — the novel arm passes independently** (the thesis is domain-limited to
novel; the aggregate IS is public-dominated, so this is the load-bearing check):

| domain | IS (C1−C3) | flip | n |
|---|---|---|---|
| public | 86.3 | 94.9% | 39 |
| **novel** | **80.6** | **100%** | 21 |

Novel prior-disfavors cell (the conventionality cell, n=18): **C1 mean = 83.3, C3 mean =
3.9.** The true premise rescues contrarian novel claims; the flipped premise crushes them.

## 5. §7 verdict (frozen rules applied)

- PASS gate: `IS≥40` ✅ ∧ `flip≥70%` ✅ ∧ `β(premise)>β(prior)` ✅ ∧ holds in ≥2 families
  (3/3) ✅ ∧ controls clean ✅ → **all met.**
- FAIL gate: `IS<20`? no. `flip<50%`? no. prior-dominated? no (β-prior n.s.). models agree
  more in C2? no (0.85 < 0.96/0.99). → **none triggered.**
- PARTIAL gate: passes novel but fails public? no (both pass). conventionality-FN > 30%?
  no (0%). → **not partial.**

**⇒ PASS.** Strength-by-re-derivation is a real longitudinal-robustness signal, not
corpus-consensus theater.

## 6. Why the cleanest evidence is the novel arm

The public arm has a residual confound: a model can reject a flipped premise because it
*knows the premise is false* (priors-on-the-premise), not because it read the premise.
The **novel arm removes this** — the models have no priors on post-cutoff content, so a
correct C3-flip there can only come from reading the premise. The novel arm passes
(IS=80.6, flip=100%, C1=83.3/C3=3.9). That is the result that actually discriminates H1
from H0, and it is unambiguous.

## 7. Honest assessment (the caveats a reviewer will raise)

1. **Strong manipulation only.** C3 is a *flipped* (contradictory) premise, not a
   *weakened* one. This is the pre-registered first falsifier (protocol §11); it shows
   re-derivation is premise-*sensitive*, not that it does *subtle* derivation. The
   weaken-don't-flip test is the v2 follow-up. **This is the main caveat on the PASS** —
   the result is "reads the premise vs runs the prior," not "performs sophisticated
   reasoning."
2. **Possible surface-entailment.** The premise sits next to the claim; some of the flip
   detection may be shallow textual-entailment. That is still *information-driven*
   (verdict tracks the supplied premise) — which is exactly H1 — but it bounds how much
   "re-derivation" to read into the word.
3. **Flips are model-validated, human spot-check still owed.** Flip-validation (held-out
   gpt-5) is complete: **81/82 passed, 1 rejected** (`pub-pf-004`, excluded from C3
   measures). High flip quality controls the §8 garbage-flip confound. A human spot-check
   of a sample (protocol §4) is the one remaining manual step.
4. **Novel cells at the §15 floor** (favors n≈1–2 after C2; disfavors n=18). The novel IS
   has wide CIs; the strong effect size (80.6) carries it, but a larger novel set would
   tighten it.
5. **Prior↔domain collinearity** (§3) makes β(prior) vs β(domain) unreliable in
   isolation; only β(premise) ≫ both is claimed.
6. **Monoculture caveat (protocol §11).** Three vendor families, but all are web-corpus
   transformers; true real-world independence may be overstated even on this PASS.
7. **Verdict ≠ correctness** (protocol §11). This measures *what drives the re-evaluation*
   (premise vs prior), not whether the verdict is right. Correctness is Exp #3's job.

None of these flip the verdict; (1) is the one to foreground in any write-up.

## 8. What this feeds (protocol §10)

- **Conventionality bias looks small at the strong-manipulation level** (FN 0% aggregate;
  per-family ≤16.7%). The true premise rescued contrarian novel claims, so the
  `vault_ratify` backstop is prudent but **not** load-bearing-by-necessity in this data
  — re-examine after the weaken-don't-flip test (Exp #2). [HYPOTHESIS — kill condition:
  a high FN under *weakened* premises would reinstate ratify as mandatory.]
- **Exp #2** (full conventionality quantification, weakened-premise variant) and **Exp #3**
  (§6.1 efficacy vs the ElephantBroker Rung-2 baseline) are now justified.
- **Build the loop:** Stage 1 (`docs/superpowers/plans/2026-06-13-cortex-loop-stage1-scheduler.md`).
  The §3.5 strength signal has cleared its cheapest falsifier.

## 9. Reproduce

```
cd experiments/exp1-info-vs-priors
# .env holds OPENROUTER_API_KEY (gitignored)
uv run --with httpx python harness.py --phase c2   --concurrency 12   # prior labels
uv run --with httpx python harness.py --phase c1c3 --concurrency 12   # true + flipped premise
uv run --with httpx python flipval.py                                  # flip validation
uv run --with 'pandas,statsmodels,numpy' python analyze.py            # measures + §7 verdict
```
Raw results: `experiments/exp1-info-vs-priors/raw/results.jsonl` (gitignored, rebuildable).
