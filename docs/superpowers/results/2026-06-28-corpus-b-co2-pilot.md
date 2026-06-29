# Corpus (B) CO2 — Arm A (recency) vs Arm C (daftari): pilot + full 37-run

**Date:** 2026-06-28
**Spec:** `docs/superpowers/specs/2026-06-28-corpus-b-co2-arm-a-pilot-design.md`
**Verdict: PROCEED.** Stream-recency fails on **100%** of scorable stale traps at the ingestion point (12/12 post-cutoff, **33/33 full**); daftari is **never stale** (0/33) and abstains rather than guess where it cannot ground.

> **Update (2026-06-28, full run):** extended from the 14-instance pilot to all
> **37** citing-revert instances, and fixed Arm C's marker localization. The
> earlier note's "widening the diff context would recover most [Arm C misses]"
> was **wrong**: the markers were missed because (a) the format evolved across
> revisions (`#C70|consensus 70` newer vs `#Current consensus]], item 70` older)
> and (b) they often sit outside the diff window. The fix reads format-tolerant
> markers from the full revision content (`extractMarkerNums`), recovering
> post-cutoff Arm C coverage 7/12 → **9/12**. The remaining misses are a genuine
> corpus property — some consensus items (e.g. #37) carry **no inline marker at
> all**, so Arm C correctly abstains. Full numbers below.

## Setup

All 37 resolved consensus-citing-revert instances from CO1 (the pilot ran the 14
post-cutoff subset, `governingNum ∈ [67,76]`; the full run covers all 37). Arm A/C
are deterministic, so pre-cutoff contamination does not affect them. Per instance
the revert diff (`action=compare`) yields the
stale (deleted) and governing (added) passage text deterministically. Arm A
(stream-recency, trusts the latest ingested edit) is evaluated at two snapshots —
`before` (bad edit latest) and `after` (revert ingested). Arm C (daftari)
`resolveCurrent`s the cited item and confirms the passage via the inline
`<!-- consensus N -->` marker. All offline against committed fixtures.

## Results

| Metric | Full (37) | Post-cutoff #67–76 (14) |
|---|---|---|
| Scorable (single-hunk) | **33** (4 multi-hunk) | **12** (2 multi-hunk) |
| **Arm A FAIL @before** (returns stale) | **33 / 33** | **12 / 12** |
| **Arm A PASS @after** (fair foil) | **33 / 33** | **12 / 12** |
| Arm C governing (marker-localized) | 16 / 33 | 9 / 12 |
| **Arm C stale** | **0 / 33** | **0 / 12** |
| Arm C unscorable (no inline marker) | 17 / 33 | 3 / 12 |
| Arm C abstain on no-mint dead-ends | **5 / 5** | **5 / 5** |

## Reading

- **The kill gate is decisively cleared.** Recency-as-stream-memory returns the
  **stale** value on every scorable trap at the ingestion point (12/12) — the
  regime is real on this corpus. This is the ContextForge/accumulation failure mode
  on real data ([[project_daftari_purpose_and_free]]).
- **The foil is fair, not rigged.** Every scorable instance classifies **governing**
  once the revert is ingested (`@after` 33/33) — recency is right after correction,
  wrong while the bad edit is latest. The window between is daftari's edge.
- **daftari is never stale (0/33).** Arm C is governing where the governing item is
  inline-marked (16/33 full; 9/12 post-cutoff), **abstains** on box dead-ends (5/5),
  and is **unscorable** (declines to assert) where the item has no inline marker — it
  never guesses, never returns stale. The oracle-edge result is near-tautological by
  design (accepted); the load-bearing signals are Arm A's 100% failure and Arm C's
  never-stale behavior, both clean at full N.

## Honest precision

- **Arm C localization coverage = 16/33 (full), 9/12 (post-cutoff).** Where the
  governing consensus item carries an inline marker, Arm C localizes and returns
  governing; where it does not, Arm C abstains (unscorable) rather than guess. The
  17 unscorable-arm-C cases are a **genuine corpus property**: some consensus items
  (e.g. #37, recurring) carry **no inline `<!-- ... -->` marker at all** (verified
  against revision content), so deterministic localization is impossible without a
  different mechanism. This is a coverage limit, never a correctness one — Arm C is
  stale 0/33.
- **The earlier "diff-window" diagnosis was wrong** and is corrected above: misses
  were format (`item N` vs `consensus N`) + location (outside the diff), now read
  from full content via `extractMarkerNums`. That recovered 2 post-cutoff instances
  (7/12 → 9/12). The residual is the genuine no-marker set, not a fetch artifact.
- **Attrition: 4/37 multi-hunk** reverts (touched several passages) flagged
  unscorable, not coerced.
- Arm A/B *minting* on no-mint (vs Arm C's abstention) is deferred to the Arm B
  stage; CO2 measured only Arm C's deterministic abstention (5/5).

## Next (gated PROCEED → now green)

- **Fuller Arm C localization** for the no-inline-marker items (e.g. statement↔passage
  matching, or the CB4 acquired-edge approach) — the path past the 16/33 coverage.
- **Arm B (LLM-synth + blind judge)** — the "beat LLM-consolidation" bar (LLM cost).
- **Pre-cutoff perturbation** and the **CB4 acquired-edge arm** (the publishable
  contribution).
