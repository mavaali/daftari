# Cortex Loop Stage 4 — B Coverage/Equity Instrumentation (design)

**Date:** 2026-06-19
**Stage:** 4 of 6 (cortex consolidation loop, spec §12.4 / §6.2)
**Parent spec:** `docs/superpowers/specs/2026-06-13-cortex-consolidation-loop.md`
**Status:** design approved; pre-implementation.

## 1. Problem

The cortex loop's budget-drift **ratchets** (parent spec §5.3.2) — entrenchment (the
core re-derives itself stronger) and starvation (the periphery never gets served and
decays) — are invisible today. Stages 1–3 shipped the scheduler, Component A, and the
envelope (live-but-shadowed). Before any auto-write graduates (Stage 5), the ratchets
must be **visible from the other side**: §6.2 — *"B must measure what the budgets can
break, or the budgets break it blind."*

Stage 4 builds the coverage/equity instrumentation that surfaces those ratchets as
standing monitor metrics. It is **instrumentation only** — not effect estimation
(that is Stage 6, §6.1, gated on the second rater).

## 2. Framing invariant (load-bearing)

**B is a monitor, never a target** (never-optimize-the-measure). These metrics
instrument that invariant from the other side. They MUST NOT be wired into Component
A's inputs or the calibration objective. Enforced mechanically by a test asserting no
`src/consolidate/` module imports the new coverage module (§7).

## 3. Decisions (resolved in brainstorming 2026-06-19)

| Fork | Decision | Rationale |
|---|---|---|
| Data model | **Snapshot-first** | Compute point-in-time from the live edge store + existing journals on each lint. Fully rebuildable, no new persisted state, honors `.daftari` ephemerality. Cross-session drift is recoverable offline from the timestamped shadow journal; a history file is deferred until a metric is shown to need it. |
| Surface home | **`vault_lint` primary** | The always-on advisory monitor an operator already reads (and which already carries the Stage-3 gated view). Mirrors how `shadowActions`/`gatedSurfaced` landed in Stage 3. Computed via a pure function so `daftari eval` can reuse it later. |
| Core/periphery split | **blast == 0 boundary** | `periphery = downstream-conditioning count == 0`; `core = > 0`. Zero is the natural boundary the starvation ratchet buries (parent §3.3.3: the periphery slice is "blast-blind, a zero-blast edge"). No invented threshold. Uses the **same blast object the Stage-3 envelope already uses** (`computeBlast(...).downstream.length`), minus its `+1` action footprint. |
| Stuck-pending | **Included as a 4th metric** | Direction-resolution coverage is a coverage/equity signal (the periphery of *direction* resolution) and a named shadow-OFF graduation gate. Nearly free given the shared edge-store snapshot. Keeps the named ratchet standing, not buried in a draft. |

## 4. Architecture

One new **pure** module: `src/curation/coverage.ts`, exporting

```
coverageEquitySummary(
  docs: LoadedDoc[],
  edges: DerivesFromEdge[],
  shadowRecords: ShadowActionRecord[],   // raw journal rows (listShadowActions)
  stagedActions: <staged-action records>,
  now: Date,
): Result<CoverageEquitySummary, Error>
```

- **Pure / read-only.** No I/O of its own; callers inject `docs`, `edges`, and the
  two journals. (Lint's wrapper does the reads, as it already does for
  `shadowActions`.) This keeps the function exhaustively testable with a fixed `now`,
  matching `clocks.ts` / `priority.ts` style.
- **Wiring:** `runLint` (`src/curation/lint.ts`) already loads `docs` and computes
  `shadowActions = await shadowLintSummary(...)` at :278. Stage 4 adds, alongside it:
  load `edges` (`listEdges`), the shadow journal (`listShadowActions`), the staged-
  action log, then `coverageEquity = coverageEquitySummary(...)`. Added as
  `coverageEquity: CoverageEquitySummary` on `LintReport` (interface at lint.ts:124,
  beside `shadowActions`). NOTE the function's raw-records parameter is named
  `shadowRecords` (not `shadowActions`) to avoid shadowing the existing
  `LintReport.shadowActions: ShadowLintSummary` field — they are different objects
  (raw journal rows vs. the aggregated summary).
- **Tool output:** surfaced in the `vault_lint` MCP tool (`src/tools/curation.ts`),
  mirroring the existing `shadowActions` rendering.
- **No writes, no new `.daftari` file.** Snapshot-first.

### Blast computation (the dependency the split rests on)

Per-edge blast is **not** the priority main-slice blast (hard-coded `1` in Stage 1,
unimplemented) nor the tension blast. It is the **link-graph downstream reach** the
envelope already computes in `src/consolidate/admit.ts:193-195`:

```
blast(edge) = computeBlast({ seeds: [canon(from), canon(to)], reverseSource, reverseLink }).downstream.length
```

`buildReverseSourceMap(docs)` / `buildReverseLinkMap(docs)` (exported from
`src/curation/tension-blast.ts`) build the reverse maps once per lint run; the BFS runs
per edge. This is the **same definition** the Stage-3 envelope uses (the envelope adds
`+1` for the action's own footprint; the monitor omits it — we want the edge's
downstream-conditioning count, not the action footprint). Defensible and consistent
with shipped code; introduces no third blast notion.

**Out of scope:** this does NOT retroactively wire blast into priority's
`fragility × blast` ranking. That is Stage 5 calibration work. Stage 4 computes blast
independently for the monitor only.

## 5. The four metrics

### 5.1 Strength-distribution drift (entrenchment / starvation ratchets)

- **Split:** `periphery` = blast == 0, `core` = blast > 0.
- **Population:** non-revoked edges (a revoked edge has strength 0 and would pollute
  the periphery flatline signal). Symmetric/pending edges ARE included here — they
  carry a real aged strength and are part of the distribution.
- **Per group report:** `count, mean, median, p10, p90, variance` of aged strength.
- **Headline drift signal:** `core median − periphery median` (the gap that widens as
  the core entrenches while the periphery flatlines).
- **Secondary flatline signal:** count of edges whose aged strength has decayed below
  `EDGE_TRIGGER_STRENGTH` (0.5) — the inert tail that can no longer bear triggers.

(Reporting variance + quantiles rather than a single drift scalar is deliberate: the
slice fractions, `backstop : main : periphery : birth`, are tuned against this
distribution in Stage 5; a scalar would hide which tail is moving.)

### 5.2 Backstop-overdue (standing)

- `decayBackstopDue(edges, now).filter(d => d.reason === "backstop").length`.
- Reuses the shipped clock (`src/consolidate/clocks.ts`); it already skips `revoked`
  and `symmetric`. Computable from the edge store with **no consolidate run** — this
  is the "standing monitor metric" §6.2 asks for (today the count is only computed
  per-run inside `prioritize` as `backstopOverdueRemaining`).
- **Report:** count + the stalest few (path pair, days past
  `CONSOLIDATE_MAX_INTERVAL_DAYS` = 90).

### 5.3 Action-mix drift (cheap-link creep)

- **Sources:** the shadow/envelope journal (`listShadowActions` →
  `ShadowActionRecord.action` ∈ {`edge-observe`, `edge-contest`, …} with
  `decision` ∈ {`admitted`, `gated`}) + the staged-action log (`STAGED_ACTION_TYPES`
  = promote/deprecate/supersede/merge/confidence-up, in
  `src/curation/staged-actions.ts`).
- **Report:** counts per action type + the **cheap-link fraction**
  (`edge-observe / total`) — the "creeping toward cheap link over deprecate/merge"
  ratchet (§6.2).
- **Denominator (pinned):** `total` = envelope/edge-op rows (`recordEnvelopeDecision`:
  `edge-observe`/`edge-contest`) **plus** staged-action rows (`STAGED_ACTION_TYPES`).
  It **excludes** the shadow journal's doc-write calibration rows
  (`recordShadowAction`, which carry an `action` that is not an edge op and no
  `decision`). The metric is about the curation `do()` mix, not doc writes — those
  rows would dilute the ratchet. The filter: a record counts iff its `action` ∈
  {edge-observe, edge-contest} or it is a staged-action record.
- **Snapshot of counts.** Cross-session drift is recoverable offline from the journal
  timestamps; no history file needed in v1.

### 5.4 Direction-resolution coverage (the symmetric/unresolved tail)

- **Source:** `listEdges` — `DerivesFromEdge.directionVerdict`.
- **Model note:** there is NO "pending" state. `directionVerdict` is exactly
  `"directed" | "symmetric"` (verified `src/curation/edges.ts:99`); `symmetric` =
  direction unconfirmed (the edge can't bear triggers and never becomes due —
  `clocks.ts` skips it). `symmetric` IS the "stuck/unresolved" set the handoff's
  "stuck-pending" referred to.
- **Report:** counts of `directed` vs `symmetric`, plus the **unresolved fraction**
  (`symmetric / non-revoked`).
- The named shadow-OFF graduation gate (the ~71–75% ambiguous-tail observation from
  the Stage-2 decorrelation verdict), now a standing metric rather than a draft note.

## 6. Output shape (sketch)

```ts
interface StrengthGroupStats {
  count: number; mean: number; median: number;
  p10: number; p90: number; variance: number;
}
interface CoverageEquitySummary {
  generatedAt: string;
  strengthDrift: {
    core: StrengthGroupStats;
    periphery: StrengthGroupStats;
    coreMinusPeripheryMedian: number;
    belowTriggerCount: number;        // aged strength < EDGE_TRIGGER_STRENGTH
  };
  backstopOverdue: {
    count: number;
    stalest: Array<{ fromPath: string; toPath: string; daysOverdue: number }>;
  };
  actionMix: {
    counts: Record<string, number>;   // by action type (envelope + staged)
    cheapLinkFraction: number;        // edge-observe / total
    total: number;
  };
  directionResolution: {
    directed: number; symmetric: number;
    unresolvedFraction: number;       // symmetric / non-revoked
  };
}
```

All zeros on an empty / never-run vault (no findings is the empty state, not an error).

## 7. Testing (TDD; tests mirror src/)

`test/curation/coverage.test.ts`, pure-function tests on fixture edge/doc sets:

1. **Blast split** — fixture with a zero-blast edge and a high-blast edge; assert each
   lands in periphery / core respectively.
2. **Revoked exclusion** — a revoked (strength-0) edge does not enter the strength
   distribution.
3. **Empty vault** — every counter zero, no error.
4. **All-symmetric vault** — `unresolvedFraction == 1`, backstop-overdue == 0
   (symmetric edges never become due).
5. **Backstop boundary** — an edge at exactly 90 days is overdue; at 89 is not
   (matches `decayBackstopDue` `>=` semantics).
6. **Action-mix** — empty journals → zeros; mixed journal → correct cheap-link
   fraction; **a doc-write calibration row (`recordShadowAction`) mixed into the
   journal must NOT count toward the denominator** (locks the §5.3 pinned filter).
7. **Path-alias canonicalization** — feed an edge with an aliased path
   (`x/../x/a.md`); assert blast seeds canonicalize so the edge isn't double-counted
   or mis-bucketed (carries the `feedback_canonicalize_path_keys` lesson into the
   first pass).
8. **Monitor-never-target guard** — assert no `src/consolidate/` module imports
   `src/curation/coverage.ts` (static check over source). Mechanical enforcement of §2.

## 8. Scope boundaries

**In scope:** the four snapshot metrics on `vault_lint`; the pure `coverage.ts`
module; the `vault_lint` tool rendering; the test suite above.

**Out of scope (with rationale):**
- §6.1 effect estimation / comprehension-load ablation / 50-pair recall set — **Stage
  6**, gated on the second qualified rater (§13).
- Any `.daftari/coverage-history.jsonl` history file — snapshot-first (Decision 1);
  add only when a metric is shown to need true cross-session trend.
- Wiring real blast into priority's `fragility × blast` — **Stage 5** calibration.
- `daftari eval` surface — lint is primary; eval reuse is deferred (the pure function
  leaves the door open).
- Charter (`CLAUDE.md`) amendment — unchanged; it is amended at **Stage 5**
  (graduation), not here.

## 9. Build ritual (parent spec §12)

brief → this spec → plan → **TDD** → **two general-purpose adversarial reviewers**
(NOT squad agents — broken tool bindings, `reference_squad_agents_broken_tools`;
verify reviewer claims against source — in the Stage-3 run the uatu hook injected
fabricated audit findings into reviewer tool results) → fix → PR to main → release.
Run commit-bearing work with **ask-permissions** (the uatu hook blocks commits in
don't-ask mode, `reference_uatu_commit_hook`). CI Node-20 has a known
onnxruntime/MiniLM flake (`reference_ci_embedding_model_flake`) — re-run, don't assume
regression. npm publish is Mihir's MFA step (`reference_daftari_release_ritual`).

## 10. Anchors (verified against src/ 2026-06-19)

- `src/curation/lint.ts` — `LintReport` (:110, `shadowActions` at :124), `runLint`
  (:161, wires `shadowActions` at :278).
- `src/curation/edges.ts` — `listEdges` (:551), `DerivesFromEdge` (:106),
  `agedStrength` (:168), `EDGE_K_CAP`=5, `EDGE_HALF_LIFE_DAYS`=90,
  `EDGE_TRIGGER_STRENGTH`=0.5.
- `src/consolidate/clocks.ts` — `decayBackstopDue` (:33, skips revoked + symmetric).
- `src/consolidate/constants.ts` — `CONSOLIDATE_MAX_INTERVAL_DAYS`=90,
  `CONSOLIDATE_SLICE_FRACTIONS` (backstop .25 / main .45 / periphery .15 / birth .15).
- `src/consolidate/admit.ts:193-195` — the envelope blast = `1 + computeBlast(...)
  .downstream.length`; `buildReverseSourceMap`/`buildReverseLinkMap` from
  `src/curation/tension-blast.ts` (:85/:102); `computeBlast` (:140).
- `src/curation/shadow.ts` — `ShadowActionRecord` (:81), `listShadowActions` (:338).
- `src/curation/staged-actions.ts` — `STAGED_ACTION_TYPES`.
- `src/tools/curation.ts` — the `vault_lint` tool output.
