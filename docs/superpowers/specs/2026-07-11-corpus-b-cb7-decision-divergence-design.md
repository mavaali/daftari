# Corpus (B) CB7 — Decision divergence: does a held tension change the *action*? (Design)

**Date:** 2026-07-11
**Status:** Design — pending spec review + user approval, then writing-plans
**Author:** design session (Claude + Mihir)
**Siblings:** `2026-06-27-corpus-b-consensus-bench-design.md` (corpus, arms, WIN/KILL
discipline), `2026-06-29-corpus-b-cb5-contradiction-detector-design.md` (CB series),
CB6 results (`docs/superpowers/results/2026-06-29-corpus-b-cb6.md`)

---

## Context

The manifesto's kill condition is about *decisions*, not answers:

> If holding the tension never changes a decision a human or agent would have
> made anyway — then non-collapse is a philosophical luxury, not a load-bearing
> property.

Corpus (B) has climbed every rung below that one:

- `[DATA]` **CO2** — recency returns the stale value on 33/33 scorable traps;
  daftari is stale 0/33 and abstains on all 5 dead-ends.
- `[DATA]` **Arm B** — LLM consolidation is recency-trapped (stale 20/33).
- `[DATA]` **CB6** — a memory forced to hold one value masquerades a genuine
  tension as a supersession 17/18 across a three-model panel; daftari mints 0/6
  and manufactures 0/6 false conflicts.

All of these are **answer-level**: what value does the memory hand back? None
of them yet shows an agent *doing something different* because the memory held
the tension. CB7 is that last rung: same corpus, same validated instances, but
the elicitation is an **action with stakes**, and the measured quantity is
whether the action *diverges* between a collapsed memory and a held-tension
memory. If it never does, the kill condition fires and non-collapse is a
luxury — the honest headline the manifesto promises to print.

## Goal

Measure, on the CB6-validated tensions and CO2 stale-trap instances, whether
**memory representation alone** — collapsed single-value vs daftari-shaped
(tension held / supersession edge followed) — changes the **decision** an agent
takes, holding the model, the prompt, and the task constant. Produce the
decision-level verdict the manifesto's kill condition demands.

## Non-goals

- Not a new corpus and not new ground truth. CB7 reuses CB6's 6
  second-rater-gated tensions, CO1/CO2's 33 scorable stale traps, and the
  settled current-decision items. No new acquisition, no new labeling.
- Not an agent-framework benchmark. One decision per instance, structured
  output, no tool loops — the *memory condition* is the only manipulated
  variable.
- Not a human study. "A decision a human would have made" stays future work;
  CB7 measures the agent half of the kill condition. Stated as a limitation.
- No daftari code changes. This is a measurement over the existing surface.

## The two memory conditions (the manipulated variable)

Each instance is presented twice to the same model, identical except for the
memory block:

- **M-collapsed** — what a consolidation memory holds: **one current value,
  no epistemic metadata.** For a tension instance: the value the CB6 forced
  foil minted for that item (majority across the panel; recorded per-instance).
  For a stale-trap instance: the most-recent stream value (the stale one — what
  Arm A holds at `@before`). The memory asserts it plainly, the way ChatGPT
  memory or a consolidated note would.
- **M-held** — what daftari hands back: for a tension instance, **both
  positions plus the explicit tension record** (kind, both claims, "neither has
  superseded the other" — the `vault_tension_log` shape). For a stale-trap
  instance, the **governing value via the supersession edge** with the stale
  version marked superseded (the `currentSource` shape). Verbatim vault
  surfaces — nothing invented for the bench.

Both conditions are stated as *the agent's own memory* ("your knowledge base
contains:"), not as retrieved documents to critique — the design models memory
consumption, not source review.

## The action tasks (decision, not answer)

### T1 — tension set (n = 6, the keystone rung)

The agent is an editorial assistant asked to **act** on the passage the tension
governs: *"Draft the update you would apply to this passage, or decide not
to."* Structured decision field, exactly one of:

- `apply_A` — commit position A's wording
- `apply_B` — commit position B's wording
- `hold_escalate` — make no unilateral change; flag for human/RfC resolution

**Ground truth = `hold_escalate`.** This is not daftari-flattering by fiat: on
this corpus it is the *empirically* correct action — the CO1 revert instances
are precisely what happens to unilateral edits against a no-consensus item
(they get reverted, citing the consensus). The corpus itself punishes
`apply_*` on these topics.

### T2 — settled controls (n = 12, the hedge tax)

Same task, same three options, but the topic is a **settled active** consensus
item (the CO1 current-decision bucket; matched articles, no active
re-litigation). **Ground truth = apply the governing value.** This bucket
exists because `hold_escalate` is free to say — an agent that escalates
*everything* would ace T1 while being useless. Decision quality means acting
decisively where settled AND holding where contested. Without this control the
experiment is rigged; with it, over-hedging is measured and charged.

### T3 — stale-trap propagation (n = 33, secondary)

*"A dependent document cites this passage; commit the value it should carry,
or flag that you cannot."* Decision = which value gets committed (`stale` /
`governing` / `flag`). `[HYPOTHESIS]` M-collapsed commits the stale value at
roughly Arm B's rate and M-held commits governing (or flags) — this rung is
near-determined by CO2/Arm B, and is included to convert that answer-level
result into decision form cheaply, not as a new finding. Reported separately
from T1/T2; the keystone claim does not rest on it.

## Panel, judging, determinism

- **Panel:** the CB6 foil panel unchanged — `anthropic/claude-haiku-4.5`,
  `z-ai/glm-4.6`, `openai/gpt-4o` via OpenRouter, temp 0. Model diversity is
  load-bearing: CB6 showed capability and minting-aggressiveness are
  orthogonal.
- **Scoring is deterministic.** The decision field is a closed enum; the
  primary metrics need **no LLM judge**. The free-text draft is kept for the
  results note but not scored.
- **Second-rater gate (task realism, one-time):** the blind cross-family rater
  (`google/gemini-2.5-flash`, per the CB6 discipline) checks each rendered
  T1/T2 prompt for leakage — that the memory block, not the task framing,
  carries the contested/settled signal. Any flagged prompt is fixed before the
  run. This gate is about the instrument, not the outcome.

  **Amendment (2026-07-11, gate v2 — after the v1 gate failed 13/13).** The
  first live gate run flagged every instance, and the failure decomposed into
  exactly the two causes the risk section anticipated:
  1. *Real differential leakage* — settled wordings carried raw consensus
     apparatus from the box wikitext (`Supersedes [[#C35|#35]].` prefixes,
     `{{tq|…}}` templates) that the hand-distilled tension wordings lacked: an
     arm-level watermark, invalidating. Fixed in the builder
     (`cleanBoxStatement` + apparatus/husk rejection, hermetically tested) and
     the constant `HOLD_ESCALATE` line was reworded from "dispute-resolution
     process" to "standard editorial review queue".
  2. *A constant confound in the gate question itself* — asking "is this topic
     contested?" over famous topics flags everything regardless of framing.
     That signal is harmless to the design: the wordings are shown identically
     in both memory conditions, so topic contested-ness cannot generate
     spurious divergence. What invalidates is a *differential* watermark
     between the arms.
  Gate v2 therefore measures the invalidating thing directly: (A) a
  deterministic apparatus scan over every T1/T2 wording (no API), and (B) the
  second rater judging the two wordings alone — form, not topic — for
  editorial-process apparatus, reported per arm. Pass = zero in both parts.
  Trap wordings are exempt: raw article passages carry wiki markup on both
  sides of every instance symmetrically, and T3 is never compared against
  T1/T2.
- **Order controls:** position A/B order randomized by instance parity (the
  CB4 convention); condition runs interleaved; one run, ~$3–5 total
  (3 models × 2 conditions × 51 instances ≈ 306 calls).

## Metrics

- **Primary — decision divergence (T1):** fraction of tension instances where
  M-held and M-collapsed produce *different* decisions, per model and pooled.
  This is the kill condition's direct measurement.
- **Primary — calibration (T1+T2):** per condition, correct-action rate across
  the mixed set. The thesis predicts M-held ≈ correct on both buckets;
  M-collapsed cannot `hold_escalate` on T1 for the right reason (its memory
  contains no signal that the topic is contested).
- **Hedge tax (T2):** escalation rate on settled controls, per condition.
  M-held over-hedging here is charged against the thesis, not excused.
- **Secondary (T3):** stale-commit rate per condition.
- Report per-model splits, instance-level dump for spot-check (the CO1/CB6
  discipline), and bucket sizes. n = 6 on the keystone is small and stated
  plainly, as in CB6.

## WIN / KILL conditions

- **WIN** — T1 divergence is material (M-collapsed acts unilaterally where
  M-held escalates, majority of instances, pooled across the panel) **and**
  M-held's hedge tax on T2 is ≤ M-collapsed's + 1 instance. Then *holding the
  tension changes the decision*, measured — the manifesto's kill condition
  survives its own test, and the last answer-level→decision-level gap in the
  two-corpus paper closes.
- **KILL** — T1 divergence ≈ 0. Two flavors, both fatal to the strong claim:
  (a) models escalate on tension topics *regardless* of memory (the task
  framing alone triggers caution — memory representation is decision-inert);
  (b) models act unilaterally even when handed the held tension (the tension
  record is decision-inert in the other direction). Either way: non-collapse
  does not change decisions on this corpus; print it.
- **PARTIAL** — divergence is real but M-held over-hedges on T2 (the tension
  habit taxes decisiveness). The honest headline becomes the tradeoff curve,
  not the win.

## Decomposition

- **D1 — instance set + condition renderer.** Assemble the 51 instances from
  existing artifacts (`consensus-cb6-tension.ts` pairs, `consensus-cb4-pairs`
  stale traps, CO1 settled items); render M-collapsed / M-held memory blocks
  from recorded values (no new LLM calls); second-rater leakage gate; instance
  dump for spot-check.
- **D2 — runner + scoring.** OpenRouter panel runner (the `edgar-arms-runner` /
  CB4 pattern), structured decision output, deterministic scorer, per-model and
  pooled report.
- **D3 — results note** in `docs/superpowers/results/`, one-line verdict
  against the kill condition, feeding the two-corpus paper
  (`docs/plans/2026-06-29-two-corpus-sovereignty-paper-design.md`) as the
  decision-level section.

## Testing (hermetic, mirrors the CB series)

- Renderer unit — M-collapsed block contains exactly one value and no
  contested/superseded language; M-held block contains both positions and the
  tension record verbatim. A leakage assertion: the T1 task text is identical
  across conditions.
- Scorer unit — enum parsing, divergence and calibration arithmetic on a
  synthetic fixture, hedge-tax computation.
- Foil-fairness unit — on a settled control fixture, M-collapsed's memory
  contains the *governing* value (settled topics are ones consolidation gets
  right; the foil must not be handicapped where it is correct).
- All LLM calls behind the existing fixture-injectable client; no network in
  the test suite; the live run is a script, not a test.

## Risks / open questions

- **n = 6 on the keystone bucket.** Inherited from CB6; the box is a rare
  institution. The verdict is stated at that n, with the instance dump public.
  A null result at n=6 is weak evidence; a strong divergence at n=6 with a
  consistent panel is real signal. Do not silently pool T3 into the headline.
- **Task-framing leakage is the main validity risk** — if the T1 prompt smells
  contested independent of memory, condition (a) of KILL fires spuriously. The
  second-rater gate plus the identical-task-text assertion are the mitigations;
  the T2 controls catch a task-wide caution bias.
- **Temp-0 nondeterminism** (seen in CB6's abstain-offered numbers): one run,
  read T1 per-instance results as one sample; the divergence direction, not a
  single percentage point, is the finding.
- **Contamination** is symmetric across conditions (same base content, same
  models) — the differential design is the defense; post-cutoff instances are
  preferred where the split allows, reported as in CO2.
- `[HYPOTHESIS]` GPT-4o, the most abstain-prone model in CB6, may escalate on
  T1 under M-collapsed too — shrinking divergence for the best model. If so,
  that is a finding, not a nuisance: the guarantee-vs-contingency framing from
  CB6 (architectural restraint vs model-dependent restraint) extends to
  decisions, and the report says exactly that.

## Definition of done

- 51-instance set assembled and dumped; leakage gate passed; renderer/scorer
  tests green; panel run complete (one run).
- Results note with the one-line verdict against the kill condition — WIN,
  KILL (which flavor), or PARTIAL with the tradeoff — plus per-model tables,
  divergence, calibration, hedge tax, and T3 as a separate section.
- The two-corpus paper design updated to reference CB7 as the decision-level
  section, or — on KILL — the manifesto's Honest Assessment updated instead.
  Either outcome is publishable; only silence is not.
