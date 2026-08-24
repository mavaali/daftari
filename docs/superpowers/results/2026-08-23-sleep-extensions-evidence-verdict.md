# Results — issue #97 sleep-extensions evidence verdict

**Date:** 2026-08-23  
**Tracker:** [#97 — Daftari Sleep Extensions](https://github.com/mavaali/daftari/issues/97)  
**Decision:** close the umbrella; do not build its proposed difficulty-adaptive
repeated tension scan.

## The framing error this closes

[DATA] Issue #97 described one linear program:

```
Component B quality metric
  -> Component A repeated tension-scan passes, with difficulty-adaptive N
  -> Component C dependency-triggered re-curation built on A
```

[DATA] The repository evolved along two different lines that the tracker later
collapsed together:

1. The original Component-A intervention was tested by orchestrating repeated
   `daftari sleep --dream tension-scan` passes and measuring with `daftari eval`.
2. A separate A+C design became `daftari consolidate`: a dependency scheduler
   over `derives_from` edges plus birth/revision re-derivation panels inside an
   envelope. It is not repeated tension scanning.

[DATA] The 2026-07-19 issue comment saying Components A and C were “not started”
was therefore stale when written. The scheduler had shipped in
[PR #135](https://github.com/mavaali/daftari/pull/135), the birth/revision pass in
[PR #136](https://github.com/mavaali/daftari/pull/136), the two-gate envelope in
[PR #137](https://github.com/mavaali/daftari/pull/137), and coverage/equity
instrumentation in [PR #140](https://github.com/mavaali/daftari/pull/140).

This verdict keeps those lines separate. The July tension-scan experiment can
kill the original adaptive-pass hypothesis. It cannot validate, tune, or kill
the `daftari consolidate` panel-and-scheduler design because it did not run that
intervention.

## What is actually complete

| Issue #97 component | Disposition | Evidence |
|---|---|---|
| B — cortex quality metric | **Shipped** | `daftari eval`, PR #99; correctness and housekeeping follow-ups #266 and #267 |
| A — difficulty-adaptive repeated tension scan | **Killed by evidence** | Production-vault N=0/1/2/3 calibration below; no measurable quality gain and zero new tensions by pass 3 |
| A — `daftari consolidate` birth/revision panels | **Shipped as a different design** | PR #136, with later safety and spend hardening in PRs #198 and #201 |
| C — dependency-triggered re-curation | **Shipped as the consolidate scheduler** | PR #135; the event clock walks changed docs to downstream `derives_from` dependents, alongside decay and backstop clocks |
| Stage-5 calibration / broad auto-write graduation in the A+C spec | **Not established by this experiment** | The tension-scan run produced no evidence about consolidate envelope constants or panel quality; the spec's separate shadow-data gate still applies |

## Calibration result [DATA]

The production run used 166 documents / 6,463 chunks, 30 fixed questions
(10 per tier), two answer runs per question, and the same question set at every
round. Baseline N=0 was followed by three 200-judgment tension-scan passes.
Every one of the 60 planned answer runs was graded in every round. The overall
score uses Component B's tier weights — retrieval 1×, cross-reference 2×,
contradiction 3× — rather than an unweighted mean of the three tier rows.

| Tier | N=0 | N=1 | N=2 | N=3 |
|---|---:|---:|---:|---:|
| retrieval | 1.000 | 1.000 | 1.000 | 1.000 |
| cross-reference | 0.975 | 1.000 | 1.000 | 1.000 |
| contradiction | 0.775 | 0.675 | 0.775 | 0.750 |
| **overall** | **0.879 ± 0.153** | **0.838 ± 0.138** | **0.887 ± 0.167** | **0.875 ± 0.158** |

| Pass | Docs scanned | Pairs judged | New tensions |
|---|---:|---:|---:|
| 1 | 36 | 200 | 131 |
| 2 | 39 | 200 | 69 |
| 3 | 38 | 200 | 0 |

The raw score/result files remain under the production vault's gitignored
`.daftari/eval/`; the protocol, artifact identifiers, completeness statement,
and cost boundary are preserved in the
[2026-07-25 issue comment](https://github.com/mavaali/daftari/issues/97#issuecomment-5080353782).
They are not silently promoted here into a stronger reproducibility claim.

## Verdict

[HYPOTHESIS-REFUTED] “Harder documents should receive more repeated sleep
passes, with a quality knee at N=2 or N=3.” The pre-registered kill condition
fired: N=2 and N=3 were within noise of N=1, N=3 was indistinguishable from the
N=0 baseline, and the scan itself exhausted its new-tension yield by pass 3.

[DATA] The zero-yield rule is a cheaper convergence signal for this scan than
watching Component B: stop after a pass produces zero new tensions. It describes
termination of the existing pass; it is not evidence for difficulty-adaptive
depth.

[HYPOTHESIS] The N=1 contradiction drop may reflect pass-1 over-logging, because
131 new tensions were minted from 200 judgments while the fixed expected answers
came from the pre-scan landscape. **Kill condition:** a blinded precision audit
finds the logged tensions mostly valid, or a post-convergence regenerated
question set retains the same contradiction loss. Until one fires, “prompt
precision is the binding constraint” is a lead, not a finding.

[DATA] Retrieval and cross-reference were already at 0.975–1.000, leaving the
harness almost no headroom in those tiers. The experiment therefore supports a
null result for the tested intervention on this vault; it does not support a
universal claim that offline curation cannot help.

## Evidence threshold for reopening the adaptive-pass bet

Do not reopen #97 or build difficulty-adaptive pass depth from a new anecdotal
run. Open a new, narrowly named experiment only when all of these gates are
pre-registered:

1. **Headroom:** at least two targeted tiers have baseline score ≤0.85 on a
   held-out question set. A ceiling-bound suite cannot test improvement.
2. **Power and pairing:** at least 60 balanced questions, `k >= 2`, identical
   question/run pairs across N=0/1/2/3, and all planned cells graded. Report a
   paired bootstrap interval, not only per-arm standard deviations.
3. **Adaptive-depth win:** N=2 or N=3 beats N=1 by at least 0.05 overall and the
   paired 95% interval excludes zero; no tier may regress by more than 0.05.
   Beating N=0 but not N=1 does not justify extra-pass machinery.
4. **Useful marginal work:** the winning extra pass must still produce nonzero
   net-new findings, and a blinded stratified audit of at least 100 new tensions
   must reach ≥0.80 precision with a Wilson 95% lower bound ≥0.70.
5. **Independent confirmation:** the same direction and gates must hold on a
   second held-out question set or a second vault before the result becomes a
   product feature rather than a vault-specific experiment.

These thresholds are deliberately about the original repeated tension-scan bet.
Graduating `daftari consolidate` out of its calibration posture remains governed
by that design's shadow corpus, envelope, direction-resolution, coverage/equity,
and charter-amendment gates. Evidence from one loop must not be laundered into
approval for the other.

## Closure

[DATA] No scoped deliverable remains in #97: B shipped; the proposed adaptive
multi-pass A failed its own calibration; and dependency-triggered C shipped via
the separately specified consolidation scheduler. Any future precision,
harder-eval, or consolidate-graduation work needs its own intervention, owner,
and kill condition. Keeping the umbrella open would hide those distinctions
rather than track executable work.
