# Corpus (B) CO2 pilot — Arm A (recency) vs Arm C (daftari) on #67–76

**Date:** 2026-06-28
**Spec:** `docs/superpowers/specs/2026-06-28-corpus-b-co2-arm-a-pilot-design.md`
**Verdict: PROCEED.** Stream-recency fails on **100% (12/12)** of scorable post-cutoff stale traps at the ingestion point; daftari never returns a stale value and abstains cleanly where it cannot ground.

## Setup

14 post-cutoff stale-trap instances (`governingNum ∈ [67,76]`, from CO1), each a
consensus-citing revert. Per instance the revert diff (`action=compare`) yields the
stale (deleted) and governing (added) passage text deterministically. Arm A
(stream-recency, trusts the latest ingested edit) is evaluated at two snapshots —
`before` (bad edit latest) and `after` (revert ingested). Arm C (daftari)
`resolveCurrent`s the cited item and confirms the passage via the inline
`<!-- consensus N -->` marker. All offline against committed fixtures.

## Results

| Metric | Result |
|---|---|
| Instances | 14 |
| Scorable (single-hunk) | **12** (2 unscorable: multi-hunk) |
| **Arm A FAIL @before** (returns stale) | **12 / 12** |
| **Arm A PASS @after** (fair foil) | **12 / 12** |
| Arm C governing (marker-confirmed) | 7 / 12 |
| Arm C never stale (governing or abstain) | **12 / 12** |
| Arm C abstain on no-mint dead-ends | **5 / 5** |

## Reading

- **The kill gate is decisively cleared.** Recency-as-stream-memory returns the
  **stale** value on every scorable trap at the ingestion point (12/12) — the
  regime is real on this corpus. This is the ContextForge/accumulation failure mode
  on real data ([[project_daftari_purpose_and_free]]).
- **The foil is fair, not rigged.** The same 12 instances classify **governing**
  once the revert is ingested (`@after` 12/12) — recency is right after correction,
  wrong while the bad edit is latest. The window between is daftari's edge.
- **daftari never mints.** Arm C is governing on 7/12 (marker-confirmed) and
  **abstains** on the other 5 (marker not in the diff window — it declines to assert
  rather than guess) and on 5/5 box dead-ends. It is **never stale** (0/12). The
  oracle-edge result is near-tautological by design (accepted); the load-bearing
  signals are Arm A's failure and Arm C's never-mint behavior, both clean.

## Honest precision

- **Arm C localization coverage = 7/12.** On 5 scorable instances the `consensus N`
  marker fell outside the limited diff context window, so Arm C abstained rather
  than localize. This is a *coverage* limit of the lightweight diff-window marker
  check, not an Arm C error (it never returned stale). Widening the diff context or
  a full-revision-content marker lookup would recover most of these — a cheap CO2
  refinement, deferred.
- **Attrition: 2/14 multi-hunk** reverts (touched several passages) flagged
  unscorable, not coerced.
- Arm A/B *minting* on no-mint (vs Arm C's abstention) is deferred to the Arm B
  stage; CO2 measured only Arm C's deterministic abstention (5/5).

## Next (gated PROCEED → now green)

Full 37-instance run; Arm B (LLM-synth + blind judge) — the "beat LLM-consolidation"
bar; pre-cutoff perturbation; and the CB4 acquired-edge arm (the publishable
contribution). Optional cheap refinement first: widen the diff context so Arm C's
marker localization covers more than 7/12.
