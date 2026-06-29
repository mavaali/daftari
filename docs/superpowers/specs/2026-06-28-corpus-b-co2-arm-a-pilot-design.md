# Corpus (B) CO2 — Arm A recency resolver + the #67–76 pilot (Design)

**Date:** 2026-06-28
**Status:** Design — pending spec review + user approval, then writing-plans
**Author:** brainstorming session (Claude + Mihir)
**Parent spec:** `docs/superpowers/specs/2026-06-27-corpus-b-consensus-bench-design.md`
**Depends on:** CO1 (shipped) — `consensus-parse`, `consensus-resolve`, `consensus-topics`, `consensus-reverts`, `consensus-instances`, `consensus-qa`, the real Trump revision fixture.

---

## Context

CO1 produced the labeled instances: 37 consensus-citing reverts (0 anomalies), 14
of them citing post-cutoff items #67–76. CO2 builds the **Arm A recency resolver**,
the **Arm C daftari resolver**, and the **pilot runner**, then runs the cheap
falsifier on the 14 post-cutoff instances.

### The wrinkle CO1 surfaced (and the framing it forces)

On a heavily-policed article like *Donald Trump*, **reverts enforce consensus** —
the final article state is governing. So a recency reader of the *current live
article* would mostly be **right**, which would collapse corpus B. The legitimate,
non-artifactual framing of recency-failure (decided 2026-06-28):

**Arm A is a memory ingesting the edit stream that trusts the latest ingested
assertion.** It does not re-read the live article; it consumes edits and the
most-recent one wins. At the bad-edit point it believes the stale value until it
ingests the revert. daftari, tracking the consensus *edge*, foregrounds the
governing source regardless of the noisy latest edit. **This is precisely the
ContextForge/accumulation competitor on real data** — a free recency/regex
consolidator vs daftari's no-mint edge-resolution ([[project_daftari_purpose_and_free]]).
The alternatives were rejected: "read the live article" makes recency mostly
succeed (corpus collapses); "talk-discussion stream" needs an LLM aligner
(violates the deterministic-labeling constraint + contamination).

### What CO2 establishes (and what it deliberately does not)

Arm C uses **oracle edges** (the consensus box), so Arm C returning governing on a
trap is **near-tautological at the snapshot** — the upper-bound sanity check the
parent spec already accepts. The non-tautological, load-bearing measurements are:
**Arm A's failure rate** (does stream-recency actually return stale?), **Arm A's
fairness** (does it pass once it ingests the revert?), and **Arm C's abstention**
(never mints on no-mint). The acquired-edge arm (the real contribution) is CB4/CO4,
deferred and gated on this pilot.

## Goal

Determine, on the post-cutoff stale-trap instances, whether **stream-recency
(Arm A) fails where daftari (Arm C) foregrounds the governing source** — the cheap
falsifier that green-lights or kills the full corpus-B run.

**Stale-trap set predicate (definitive):** CO1 instances with **`governingNum ∈ [67,76]`**
— keyed on the *governing terminal*, exactly as CO1's `consensus-qa.ts` keys the
post-cutoff set, NOT on `citedNum`. The two coincide on this data (**N=14**), but a
stale cited item resolving forward to a terminal outside #67–76 (or vice versa)
would make them diverge; the plan uses `governingNum ∈ [67,76]` and reports the
actual N if it differs from 14.

## Non-goals

- Not the full run (all 37 instances), not pre-cutoff perturbation, not Arm B
  (LLM-synth), not the CB4 acquired-edge arm — all follow-ons gated on the pilot.
- No `hybrid.ts` / production change. Pure bench code under `integrations/`.
- Not a semantic-equivalence judge. Scoring is deterministic text classification
  against two known texts; ambiguous instances are flagged unscorable, not judged.

## The per-instance mechanism

**Unit = a stale-trap instance** (revert revision `T` cites `#N`; bad edit = parent
`T-1`). From the revert diff (`action=compare`, `compare["*"]`), deterministically:
- `P` = the diff hunk (passage localization)
- `governingText` = P on the restored (added) side of revision `T` = **ground truth**
- `staleText` = P on the removed side (the bad edit `T-1`)

**Arms, each classified against {governing | stale | abstain | other}:**
- **Arm A (stream-recency):** the latest ingested edit wins → returns `staleText`
  at `T-1` → **stale = fail**; returns `governingText` at `T` (revert ingested) →
  **governing = pass**. The two-snapshot evaluation is the fair-foil control: same
  instance, fails while the bad edit is latest, passes once corrected.
- **Arm C (daftari):** `resolveCurrent(#N)` → governing item; foreground its
  governed passage by reading the inline `<!-- … consensus N … -->`-marked passage
  in revision `T` (non-circular: marker localization, not reuse of the revert
  decision) → returns `governingText` → **governing = pass**. Never returns a third
  minted value. (Near-tautological at `T` — accepted upper bound.)

**no-mint instances** (box dead-ends / absent topics, from CO1's no-mint bucket):
ask "current consensus on topic X?" with no governing item. Arm A returns the
latest stream value (**mint**); Arm C `resolveCurrent`→unresolved → **abstain**
("not present"). **These are box-derived and NOT post-cutoff-scoped** — CO1's
no-mint bucket (CO1 reported **N=5** globally, e.g. `{4,15}`); the abstain /
mint-rate metric runs over these 5 regardless of the #67–76 slice. The bucket is
confirmed populated (5), so the abstain sub-claim has data.

## Honest precision (do not force the metric)

The clean scorable case is a **single-hunk revert on a marker-tagged passage**.
Flagged **unscorable → hand-review** (reported as a count, never coerced):
- multi-hunk reverts (touch several passages),
- passages with no inline `consensus N` marker (Arm C can't localize deterministically),
- add-only / remove-only diffs (governing = absence; classification ill-defined).
With N=14 some attrition is expected and **stated, not hidden**. If too few
instances are scorable, that itself is a reported finding (the corpus is thinner
than the probe implied).

## Architecture (fixture-backed; no network in tests)

Reuse CO1 modules. New modules, each one responsibility:
- `consensus-content.ts` — fetch revision content + `compare` diffs behind an
  interface; fixture reader for tests. A one-shot script pulls the 14 instances'
  real diffs/content → committed fixture `__fixtures__/trump-instance-diffs.json`
  (keyed by revert `revid`; mirrors CO1's pull script).
- `consensus-passage.ts` — parse a revert diff (`compare["*"]` HTML:
  `diff-deletedline` / `diff-addedline` / context) → `{ P, staleText, governingText, scorable, reason }`.
- `consensus-arm-a.ts` — `armA(instance, snapshot)` → answer (staleText at `T-1`,
  governingText at `T`).
- `consensus-arm-c.ts` — `armC(items, instance, revisionContentAtT)` → governingText
  via resolveCurrent + marker localization, or `abstain`.
- `consensus-pilot.ts` — `runPilot(instances, ...)` → classify each arm per instance,
  emit metrics report + spot-check dump.

```
CO1 instances (#67-76) ─► consensus-content (diffs/content, fixture-backed)
                               │
                               ▼
                     consensus-passage  ─► { P, staleText, governingText, scorable }
                               │
            ┌──────────────────┼───────────────────┐
            ▼                   ▼                    ▼
   Arm A @T-1 (stale)   Arm A @T (governing)   Arm C (resolveCurrent + marker)
            └──────────────────┼───────────────────┘
                               ▼
                     consensus-pilot ─► per-instance classification + metrics report
```

## Metrics

- **Arm A failure-rate on traps @T-1** — the pilot KILL gate. Must be high.
- **Arm A pass-rate @T** — foil fairness. Must be high (recency right once corrected).
- **Arm C governing-rate on traps** — ≈1 (oracle upper bound).
- **no-mint mint-rate** — Arm A > 0, Arm C ≈ 0.
- **Scorable count** / unscorable breakdown by reason.

## WIN / KILL (the pilot gate)

- **KILL** — Arm A passes the traps @T-1 (the latest ingested edit is already
  governing) → stream-recency doesn't fail → corpus B collapses. Stop; record the
  cheap kill.
- **PROCEED** — Arm A fails most traps @T-1 but passes @T (fair foil), Arm C
  foregrounds governing, no-mint abstention holds → green-light the full run + Arm
  B + the CB4 acquired-edge arm (the real contribution).
- **THIN** — too few scorable instances (marker/diff attrition) → corpus is thinner
  than the probe implied; report N and reconsider scaling to more articles before
  Arm B.

## Testing (hermetic, mirrors `src/`)

- `consensus-passage` unit — on a committed `compare["*"]` HTML fixture: extracts
  `staleText` / `governingText`; flags a multi-hunk fixture unscorable.
- `consensus-arm-a` unit — returns stale @T-1, governing @T (the foil-fairness
  assertion).
- `consensus-arm-c` unit — governing on a marker-tagged instance; abstain on a
  dead-end ({4,15}) instance.
- `consensus-pilot` unit — end-to-end classification + metrics on the fixture set.
- Real pull is an isolated script; **no network in the suite**.

## Definition of done

- Arm A, Arm C, passage parser, and pilot runner implemented + tested; full
  `integrations/consensus-bench` suite green, tsc clean.
- Real per-instance diff/content fixtures pulled + committed for the 14 #67–76
  instances.
- **Pilot verdict** on #67–76 stated against the kill condition with numbers (Arm A
  fail @T-1, pass @T, Arm C governing/abstain, scorable count) — not a hedge.
- Short results note in `docs/superpowers/results/`, feeding
  [[project_corpus_b_consensus_bench]] and [[project_daftari_paper]].
