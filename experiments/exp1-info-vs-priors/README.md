# Experiment #1 — Information-vs-Priors Discriminator (harness + claim set)

Executes `docs/superpowers/specs/2026-06-13-exp1-information-vs-priors-protocol.md`
(the pre-registered protocol; source of truth). Results land in
`docs/superpowers/drafts/2026-06-13-exp1-results.md`.

**Run mode (decided 2026-06-13):** FULL multi-family experiment via OpenRouter
(Mihir provided the key path). Three genuinely distinct families:
Anthropic Claude · OpenAI GPT · Qwen (Chinese-lineage open model). Exact model IDs
verified against OpenRouter's live model list at build time — see `models.json`.

> The §7 decision thresholds are **frozen** (pre-registration). They are NOT moved
> after seeing data. PASS: IS≥40 ∧ flip≥70% ∧ β(premise)>β(prior) ∧ holds in ≥2
> families ∧ controls clean. FAIL: IS<20 ∨ flip<50% ∨ prior-dominated ∨ C2-agreement
> > C1/C3-agreement. PARTIAL: passes novel but fails public, or conventionality-bias
> FN > 30%.

---

## The claim set IS the experiment (protocol honesty flag)

A weak set — no real prior↔premise divergence, or contaminated "novel" claims —
yields a confident but meaningless verdict. The effort is here, not in the harness.

### Factorial (protocol §3)

- **Premise validity** (manipulated within-edge): **C1** true premise · **C3** flipped
  (coherent, genuinely contradictory) premise. Plus **C2** prior-only (no premise) to
  label prior-congruence and run the axis-prior tell.
- **Prior congruence** (selected stratum, *confirmed* by C2): prior-favors · prior-disfavors.
- **Domain** (selected stratum): public/factual · novel/interpretive-institutional.

### Strata targets (protocol §4: ≥120 edges, ≥15 per prior×domain cell)

| Cell | Source | Who authors | Target candidates (pre-C2) |
|---|---|---|---|
| prior-favors × public | synthetic + real | generated (memorized fact) | ~25 |
| prior-disfavors × public | synthetic | generated (counterintuitive-but-true) | ~25 |
| prior-favors × novel | real (mined) | from proprietary vaults | ~25 |
| prior-disfavors × novel | real (mined) | proprietary contrarian-but-vindicated | ~25 |
| **controls (~20%)** | synthetic | positive (trivial entailment) + negative (true non-edge) | ~25 |

Over-generate because the **40–60 ambiguous-prior band is discarded after C2**
(protocol §4). `prior-favors` ⇐ mean C2 conf > 60; `prior-disfavors` ⇐ < 40. Each
candidate carries an `intended_prior` (hypothesis); the **C2-confirmed** label is what
freezes. Pre-register the labeled set *before* C1/C3 collection.

### Contamination control (protocol §8)

- **public/factual** = truth is in the training corpus *by design* — the contrast arm.
  The model's "prior" there is really memorized fact.
- **novel/interpretive** = proprietary institutional framings/decisions NOT in any
  corpus. Sources are private vaults (`agentic-trust-protocol-private`, `daftari/docs`
  pre-publication, `inverse-problem-vault`, `career`) and post-cutoff (2026) material.
  This is the contamination-free arm and the cell the narrowed thesis lives on.

### Controls (protocol §4, §8)

- **Positive control** (trivial entailment): X obviously follows from Y. Re-derivation
  MUST be YES in C1, NO in C3. Failure ⇒ broken setup, abort.
- **Negative control** (true non-edge): X genuinely does NOT derive from Y. Should be NO
  in C1. Catches a yes-bias that would fake info-insensitivity.
- **Tautology screen:** edges where X merely restates Y are rejected in construction.

### C3 flip construction (protocol §4)

The flipped premise Y′ is a **minimal, coherent, genuinely-contradictory** edit of the
true premise Y — never nonsense (a garbage premise triggers NO for the wrong reason).
Each flip is validated by (i) a held-out strong model and (ii) a human spot-check, on
two criteria: coherent prose AND removes/contradicts the specific support X relied on.
Flips failing either are rejected.

---

## Edge schema (`claimset.json`)

```json
{
  "edge_id": "nv-pd-003",
  "domain": "public | novel",
  "intended_prior": "favors | disfavors",
  "prior_confirmed": null,              // set after C2: favors | disfavors | DISCARD
  "control": null,                       // null | positive | negative
  "source": "real | synthetic",
  "provenance": "file path or 'generated'",
  "from_claim": "X — the dependent assertion (one sentence)",
  "to_premise_true": "Y — the premise X depends on (true)",
  "to_premise_flipped": "Y′ — minimal coherent contradictory edit of Y",
  "derives_question": "Does the claim (X) derive from / depend on the premise as stated?",
  "flip_validation": { "model_ok": null, "human_ok": null },
  "notes": ""
}
```

`edge_id` convention: `{pub|nv}-{pf|pd}-{nnn}` for prior cells; `ctl-pos-nnn` /
`ctl-neg-nnn` for controls.

## Procedure (protocol §5)

Per edge, **blind** (re-deriver never told this is an experiment, never sees prior
strength/verdict). Elicit 0–100 confidence + binary survives/fails (threshold 50) under:

- **C2 prior-only:** claim X only, "from your own knowledge how strongly does this hold?"
- **C1 true-premise:** premise Y + claim X, "does X derive from Y as stated? Re-derive
  independently; do not assume it is true."
- **C3 flipped-premise:** identical to C1 with Y′.

Across **3 families × 3 repeats** (vary prompt framing per repeat = the prompt axis).
≈ 120 edges × 3 conditions × 3 families × 3 repeats ≈ 3,200 calls.

## Measures (protocol §6) → Decision (§7)

IS = mean(conf_C1 − conf_C3) over prior-favors edges · flip-rate (C1→C3 threshold
cross) · mixed-effects `confidence ~ premise_validity + prior_congruence + domain +
premise_validity:domain` (β-premise vs β-prior is the answer) · axis-prior tell
(inter-model agreement C2 vs C1/C3) · conventionality-bias FN rate (C1 × prior-disfavors
wrongly failed). Apply frozen §7 rules.

## Scope decision (2026-06-13, mid-run)

To avoid egressing private IP, the claim set was scoped to **non-proprietary content**:
the 13 edges sourced from private repos (inverse-problem-vault ×10, career ×1,
ATP-private/lesswrong_draft ×2) were dropped (`claimset_dropped_private.json`). The
kept novel stratum is sourced from **public repos** — Daftari (created 2026-05-17) and
agentic-trust-protocol (first commit 2026-03-04). Both repos postdate the Jan-2026
training cutoff, so the novel stratum is **contamination-free by construction**, tagged
`contamination: clean-postcutoff`. Final set: 94 edges (public/favors 22, public/disfavors
20, novel/favors 13, novel/disfavors 15, controls 24).

## Realized design after C2 freeze (IMPORTANT — reported, not corrected)

C2 confirmed prior labels (favors>60 / disfavors<40 / discard 40–60). The realized
prior×domain matrix collapsed onto a diagonal:

| | prior-favors | prior-disfavors | discard |
|---|---|---|---|
| public | **40** | 0 | 2 |
| novel | 2 | **17** | 7 |

**Prior-congruence is confounded with domain** (favors≈public, disfavors≈novel): models
affirm memorized public facts and are skeptical of unseen post-cutoff institutional
claims. Consequences: (a) the β-premise vs β-prior decomposition is weakened by
collinearity — reported as a limitation; (b) the two discriminating probes still hold on
the diagonal — **C3-flip on prior-favors (public)** and **C1-conventionality on
prior-disfavors (novel, n=17)**, the latter being the thesis's actual domain.
**Pre-registration intact: thresholds and edges unchanged after seeing C2.**

## Build status

- [x] Workspace + pre-registration (this doc)
- [x] Claim set authored (novel from public repos · public + controls) → 94 edges
- [x] Human review checkpoint (Mihir) — novel faithful, expand crown-jewel cell, scope non-proprietary
- [x] C2 run (846 records, 0% refusal) → prior labels frozen (`claimset_frozen.json`)
- [x] C1/C3 run (846 + 846 records, 0% refusal)
- [x] Flip validation — 82/82 done, 1 reject (pub-pf-004); human spot-check still owed (§4)
- [x] Analysis + §7 verdict → **PASS (H1)**, `docs/superpowers/drafts/2026-06-13-exp1-results.md`

## Result: PASS (H1 — re-derivation is information-driven)

IS=86.4 · flip=95.2% · β(premise)=86.4 ≫ β(prior)=5.1 (n.s.) · holds in 3/3 families ·
conventionality-FN=0% · controls clean. **Novel arm passes on its own** (IS=80.6,
flip=100%, C1=83.3/C3=3.9) — the clean, contamination-free discriminator. Main caveat:
strong manipulation (flip, not weaken) — the weaken-don't-flip v2 is Exp #2.

## Operational note — egress guardrail

The auto-mode classifier blocks the *agent* from egressing repo-design content to
OpenRouter (and from self-allowlisting it) — by design. The human runs the egress
phases (C2 already run this way) or adds a Bash allow-rule
`Bash(uv run --with httpx python harness.py:*)` to drive it in-session.
