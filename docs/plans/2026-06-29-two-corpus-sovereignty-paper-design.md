# Two-corpus sovereignty paper — design

**Date:** 2026-06-29
**Status:** Design validated (brainstorm). Gated on one experiment (CB6) before drafting prose.
**Supersedes the scope of:** `docs/superpowers/drafts/2026-06-27-contracts-sovereignty-paper-framing.md` (that was paper-A-alone; corpus B is now done, so the paper is the two-corpus synthesis).
**Thesis source:** `project_daftari_thesis` (locked positioning).

---

## Premise (challenged, held)

Write the **systems/position paper now** — but as the **two-corpus synthesis**, not the
narrow contracts-only (A). The 06-27 framing scoped "(B) — the recency-fails accuracy
regime — as a future bet"; corpus B (Wikipedia "Current consensus") *is* that regime
and is now done (recency fails 33/33, daftari never stale, mints 0 across three lenses).
Writing the narrow (A) would leave the stronger half on the table. The synthesis needs
**zero new experiments** for the recency/no-mint claims — it is a writing lift — **except**
the one gating experiment below (CB6), added because the keystone is otherwise only
shown by construction.

## Thesis spine (the keystone)

*Memory you own, model you rent.* A memory system's job is not to compute the current
answer — it is to preserve structure (current / grounded / contested) so none of the
three collapses. Load-bearing invariant: **a tension may never masquerade as a
supersession.** Preserve-not-resolve *is* sovereignty.

## Central claim (one claim, two regimes)

> Across both regimes — where recency works (formal contracts) and where it fails
> (human consensus records) — the axis that separates daftari from a
> consolidating/minting memory is the same: **non-fabrication + provenance**, not
> accuracy. The contribution is the *measured invariance* of that axis across two
> contamination-controlled corpora.

- **Contracts = recency-works control.** A trivial baseline gets accuracy right, yet on
  partial/tainted clauses minting fabricates (forced 4/7) and naive provenance
  mis-attributes governing (0/2); daftari 0/7, 6/6. ⇒ accuracy isn't the axis even
  where it's solved.
- **Wikipedia consensus = recency-fails treatment.** Recency stale 33/33; daftari never
  stale; three-lens table (derivation 1/33, contradiction 2→4/33 span-level, minting
  foil fabricates 26/49, both legit lenses mint 0). ⇒ where recency fails, daftari
  never goes stale *and* never mints while consolidation fabricates.

**Working title:** *"Preserve, Don't Resolve: Non-Fabrication and Provenance as the
Axis for Agent Memory, Across Regimes Where Recency Works and Where It Fails."*

## Structure (section skeleton)

1. **Introduction** — agent memory is judged on accuracy/recall, but the *agent* is the
   consumer and needs structure preserved; thesis + keystone up front.
2. **The architecture (systems contribution)** — markdown+frontmatter vault, SQLite
   index, git-as-versioning, never-delete, supersession *pointers* (not minted values),
   tensions, RBAC, advisory cortex loop. Structural no-mint: query tools call no LLM;
   the loop emits *edges*, never prose; `superseded_by` is a pointer, not a value.
3. **Two regimes, one axis** — frame the control/treatment on the recency axis.
4. **Regime 1 — Contracts (recency-works control)** — EDGAR chains, deterministic
   resolution; negative result (recency sufficient, >100:1); sovereignty on
   partial/tainted clauses (forced Arm B + provenance eval).
5. **Regime 2 — Wikipedia consensus (recency-fails treatment)** — consensus box,
   editor-provided alignment, post-cutoff contamination control; recency fails 33/33;
   the three-lens table.
6. **Synthesis — the invariance** — same two guarantees separate the architectures in
   both regimes; never-mint is structural.
7. **The keystone, measured (CB6)** — tension-masquerade on editor-labeled "no
   consensus" items: forced consolidation collapses a tension into a supersession;
   daftari preserves it.
8. **Honest Assessment + kill conditions.**
9. **Related work** (accumulation pole / weights pole / consolidation-sleep) — needs a
   deep-research grounding pass.
10. **Limitations & future** — §6.1 variance ablation + a genuine-tension corpus at scale.

## CB6 — the gating experiment (the keystone, measured not by-construction)

**Why:** the keystone is the paper's spine and is otherwise shown only *by construction*
(the loop cannot mint) — the one central claim left unmeasured. A reviewer attacks
exactly that asymmetry.

**Material (confirmed):** the consensus box's **"no consensus" items** are genuine
tensions — the status quo holds *by default*, not by superseding the alternative on the
merits — and they are **editor-labeled** (e.g. #48: *"Supersedes #45 … there is no
consensus on specific wording, but the status quo is X"*). n≈5 in the Trump box (#4,
#45, #48-wording, #56, #65). No LLM labeler → no contamination.

**Design:** build tension pairs `(statusQuo, rejectedAlternative)` with **ground truth =
NEITHER supersedes**. The rejected alternative is sourced from the box-linked RfC (light
read; hand-construct at n≈5, then gate each pair through the **blind second-rater**
cross-family-agreement check that validated the corpus B fixtures, so the pairs aren't
biased). Run:
- **forced minting foil** (reused from CB4) — a forced consolidator has no "tension"
  output, so any direction it picks *is* the masquerade. Measure masquerade rate.
- **daftari path** (CB5 contradiction detector → `YES_CONFLICT` = correctly flags
  tension; tension-log mints 0).

**Reading:** forced minting masquerades genuine tensions as supersessions; daftari
preserves all, mints 0. Converts the spine from by-construction → measured + structural.

**RAN 2026-06-29 (n=6, 3 articles — Trump/Biden/COVID-19; `docs/superpowers/results/2026-06-29-corpus-b-cb6.md`):**
forced masquerade **17/18 across the panel** (GLM-4.6 6/6, GPT-4o 6/6, Haiku 5/6 — Haiku
refused once, so near-architectural not sterile); abstain-offered model-dependent (GLM 5/6
most aggressive, Haiku 3/6, GPT-4o 2/6 most conservative — the honest softness, and the
empirical answer to "use GLM?": GLM widens the contrast, capability ≠ conservatism);
daftari mints **0/6** and manufactures **0/6** false conflicts (detector flags 3/6 — the
genuinely oppositional items; framing disputes correctly not flagged = preserve-not-resolve);
second-rater validated 6/6. Survey finding: the box is a RARE institution (only Trump/Biden/
COVID of 12 candidates) → this mechanism caps ~n=6–8; bigger needs RfC-close harvesting.
Spine is now measured + structural.

**Honest caveats (state in-paper):** small n (scale = pull Biden/Reagan/COVID boxes);
an abstain-offered LLM may flag some (Arm B softness) — the *forced* condition is the
on-thesis foil.

## Methods — the foil model panel (applies to CB4/CB5/CB6 + contracts)

- **Foil = a model panel, not a single model.** Run the minting/consolidation foil
  across **Haiku-4.5 + GLM-4.6 + GPT-4o**; report the fabrication *range*. **RAN
  2026-06-29 (CB4 panel, `2026-06-28-corpus-b-cb4.md`): the abstain-offered fabrication
  is MODEL-DEPENDENT, F = 6–26/49** (Haiku 26, GLM 24, GPT-4o 6 — GPT-4o abstains
  25/33). The earlier "Haiku = conservative lower bound" assumption is **refuted**: Haiku
  is near the *high* end; capability and minting-aggressiveness are orthogonal. So the
  abstain-offered number is the *honest softness*, NOT the headline → **lead the
  sovereignty contrast with the FORCED condition** (CB6: 17/18 near model-independent),
  the architectural claim that doesn't depend on model or abstain-option.
- **The forced-answer condition is the robustness anchor.** Forced (no abstain — the
  realistic consolidation shape), even a capable model must pick a direction → it
  masquerades regardless of capability. A more capable model may abstain *more* in the
  abstain-offered condition (better-calibrated → fabricates less), so the panel is run
  under the forced condition for the headline claim.
- **daftari's own pass stays Anthropic (Haiku).** daftari's LLM client is Anthropic-only;
  reproducing its actual classifier on another vendor would not be "daftari." Fixed.
- **Judge: capable + cross-family-independent from the foil.** Gemini-2.5-flash default;
  never judge a GLM-foil run with a GLM judge. Keep the blind cross-family gate.

## Honest Assessment (adversarial, stated up front)

- **Keystone:** addressed by CB6, but at small n + with the structural guarantee as the
  backbone. Named, not hidden.
- **Sovereignty softness:** a careful abstain-prompted LLM also abstains; the *measured*
  gap is the forced condition (4/7, 26/49). Framed as design-guarantee + measured-gap,
  not "LLMs always fabricate."
- **Foil numbers are lower bounds** on conservative models → the panel addresses this.
- **Negative-result placement** (contracts "recency wins") risks reading as "wrong
  corpus" — the two-regime framing carries it.
- **The loop is described, not powered** — no variance result; scoped to §6.1 / paper B.

**Single kill condition (whole paper):** daftari has no niche if a consolidation baseline
*both* (i) abstains as reliably on unrecoverable/competing cases *and* (ii) reproduces
provenance / never mints — across *both* regimes. Measured: it does neither.

## Failure-mode check (Step 5)

- **If it succeeds wildly** (CB6 masquerade ~100%, panel uniformly fabricates): the
  result is almost *too* clean — pre-empt "the forced foil is a strawman" by also
  reporting the abstain-offered condition (already have it for contracts/Arm B) so the
  forced number is contextualized, not the only number.
- **If CB6 fails** (forced foil abstains / says NEITHER on tensions, or daftari's
  detector flags few): the keystone's empirical edge is small → fall back to the
  structural guarantee + report honestly; the paper still stands on non-fabrication +
  provenance, but the keystone section becomes "structural + a null we report."
- **6-month consequence:** the two-corpus design is stable (control/treatment), so the
  paper doesn't rot if a third corpus later appears — it slots in as replication. The
  risk is the related-work pass aging; ground it close to submission.

## NOT in scope (deferred, with one-line rationale)

- **A third corpus / "more corpora."** Two corpora is a *designed* control/treatment on
  the recency axis, not a sample size — *"two that differ on the axis a skeptic cares
  about beats ten."* A third same-shape corpus is padding. The marginal corpus that
  matters (genuine-tension at scale; derivation-rich) belongs to paper B, not this one.
- **The §6.1 comprehension-load / variance ablation.** The empirical paper B's prize;
  needs the loop's experiment harness (held-out labeled question set + variance
  protocol) **and** a derivation-rich corpus (both current corpora are derivation-sparse
  — Wikipedia CB4 recall 1/33). Multi-week build, deliberately deferred.
- **Stage 5 envelope calibration.** Off this paper's critical path; the loop is
  described as architecture, not measured for variance here.
- **Genuine-tension corpus at scale.** CB6 measures the keystone at n≈5 from the Trump
  box; a powered tension corpus is paper B's requirement.
- **Contract-accuracy chasing** (citation-parse generalization, EDGAR broad sweep) —
  recency wins on contracts; accuracy there buys nothing.

## What already exists (reuse, don't rebuild)

- **Corpus B machinery** (`integrations/consensus-bench/`): box parser, `resolveCurrent`,
  consensus-citing-revert pipeline, Arm A/B/C, CB4 derivation classifier + minting foil,
  CB5 contradiction detector + span variant, the OpenRouter `LlmClient` seam. CB6 reuses
  the CB4 foil + CB5 detector verbatim.
- **Contract-bench machinery** (`integrations/contract-bench/`): EDGAR pull, deterministic
  resolution, forced Arm B, provenance eval — all run, results in
  `docs/superpowers/results/2026-06-27-*` and `2026-06-25-synthetic-contract-supersession.md`.
- **Second-rater discipline** (`reference_openrouter_second_rater`): blind cross-family
  agreement gate for hand-built fixtures — used to validate CB6 pairs.
- **All experimental results** already written in `docs/superpowers/results/`.

## Sequencing

1. **CB6** (this gates the keystone section) — construct + second-rater-gate the tension
   pairs, run the foil panel + detector, write the result note.
2. Optionally re-run CB4/CB5 minting foil across the model panel (cheap) to upgrade the
   "lower bound" caveat to a model-robustness range.
3. Draft the paper from the skeleton; all evidence is in hand.
4. Deep-research pass for related work before submission.
