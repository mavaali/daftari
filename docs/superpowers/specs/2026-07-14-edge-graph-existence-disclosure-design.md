# Edge-graph existence disclosure — design options

2026-07-14. Status: **blast surface decided by Mihir (coarsened totals, option
B′ below); edges/lint/court posture still open. Nothing implemented.**
Issue: #217 (deferred non-goal from #212/#215), plus the vault_lint aggregate
rider from #216. Predecessor spec: 2026-07-12-tension-rbac-alignment-design.md.

## Why

#212/#215 settled tension CLAIMS: both-sides gated, omission over redaction,
no existence leak. #216 extended the same predicate to the three sibling read
surfaces (landed with this spec's branch). What remains is doc-path
**existence** crossing ACL boundaries through the edge-graph surfaces:

- `vault_tension_blast`: the downstream doc list can name docs in unreadable
  collections (paths only, no content). Seeds are already filtered to visible
  tensions (#215), but the blast walk over reverse-source/link maps is
  unfiltered.
- `vault_edges` (`src/tools/edges.ts:265`): gates on `hasAnyRead` only; the
  edge listing can name docs in unreadable collections.
- `vault_lint`: findings can name docs in unreadable collections, and
  `computeTensionHealth` (`src/curation/lint.ts:325`) aggregates tension
  counts over ALL entries with no RBAC filter (counts only, no paths).

This is existence disclosure — strictly weaker than the content disclosure
#212 closed — but the house principle (omission over redaction, no existence
leak) should either apply or be **explicitly accepted per-surface**. The
complication that blocked a quick fix: blast radii filtered to readable
downstream docs understate real blast, and curation decisions keyed on an
understated blast are wrong decisions.

## The options

### A. Plain omission everywhere

Filter every doc list and every count to the caller's readable set, same as
the tension surfaces.

- Pro: one rule, no new response shapes, consistent with #212.
- Con: blast honesty breaks. A ruling whose real blast is 40 docs shows 3 to
  a narrow role; the docket ordering (`priorityCompare` keys on blast.total)
  silently reorders per-role. Curation aggregates (lint tension health) stop
  matching between operators with different roles — "is the vault healthy"
  gets role-dependent answers.

### B. Counts-visible + counts-total split — REJECTED (small-cell disclosure)

Doc **lists** contain only readable paths (omission — no name ever leaks).
**Counts** carry two numbers: `visible` (readable subset) and `total` (true
magnitude). Blast returns e.g. `primary_blast: {visible: 3, total: 40}`.

- Pro: no path leaks, and curation stays honest — the caller learns "this
  ruling settles 40 docs, 3 of which you can see." Docket priority stays
  role-independent.
- Con — and the reason this was rejected: an earlier draft claimed
  `total − visible` is "the same accepted class as the sequential tension-id
  residual (#215)." That comparison is wrong on two axes (surfaced by Mihir's
  regional-revenue probe, 2026-07-14):
  1. **Localization.** Ids leak a *global* count ("the vault has ~140
     tensions"). The blast residual is sliced along the access boundary and
     attached to a specific readable neighborhood: "there are exactly N
     hidden docs downstream of this doc you can read." That is existence
     disclosure of *linked* documents — the #212 class, not the id class.
  2. **Small cells.** Revenue-style aggregates are safe because thousands of
     contributors hide any individual. Blast deltas are small integers;
     `total − visible = 1` means "precisely one hidden document is linked
     downstream of X," with certainty. The small-cell failure is the common
     case here, not the edge case (cf. statistical cell suppression).

### B′. Coarsened split — **DECIDED (Mihir, 2026-07-14)**

Lists omit unreadable paths, as in B. The hidden remainder is reported
**qualitatively, never as an exact count**: `hiddenDownstream: "none" |
"some" | "many"` (boundary between some/many to be fixed at implementation;
strawman: many ≥ 5).

- Pro: keeps the decision-relevant fact — "the real blast is much bigger than
  what you can see" — while making the small cell unrecoverable. An agent
  does not need the integer 40 to know it is not making a low-stakes edit.
- Con: bucket boundaries are a judgment call; a narrow role cannot sort on
  exact totals (irrelevant today — the docket, which sorts on blast.total,
  runs operator-side with no access context).

### C. Documented acceptance (status quo, made deliberate)

Leave the surface global; write the acceptance into the tool description and
the RBAC docs ("this surface reports vault-global structure; paths may name
docs you cannot read").

- Pro: zero code, zero shape churn; defensible for operator-facing surfaces
  that are already any-read gated.
- Con: contradicts the #212 principle for any surface reachable by a
  narrow agent role; "documented" leaks are still leaks.

## Per-surface disposition

| Surface | Disposition | Rationale |
|---|---|---|
| `vault_tension_blast` downstream list | **B′ — decided** | Lists omit unreadable paths; hidden remainder reported as none/some/many, never an exact count (small-cell disclosure). |
| `vault_edges` listing | **A — proposed** | It's a navigation surface, not a curation aggregate — nothing decision-relevant is lost by omission, so the simpler rule wins. |
| `vault_lint` findings naming docs | **A — proposed** | Same as edges: a finding you can't act on (can't read the doc) has no value to the caller. |
| `computeTensionHealth` aggregates (#216 rider) | **C — proposed** | Vault-global counts, not sliced along an access boundary and not attached to a readable neighborhood — genuinely the id-residual class, unlike B's per-doc delta. Lint is the operator's vault-global health view; filtering would make "vault health" role-relative. Document it. |

[HYPOTHESIS] B′ retains enough signal for curation decisions. Kill
condition: if an agent-facing consumer emerges that genuinely needs to *rank*
by hidden-blast magnitude (not just detect it), the bucketing loses ordering
information and this decision gets revisited with that consumer's threat
model on the table.

## Non-goals

- No change to the tension-claim gates (#212/#215/#216) — those are settled.
- No per-surface role configuration ("who may see totals") — RBAC stays
  config-driven roles over collections, nothing finer.

## Decided

- **Blast = B′ (coarsened split).** Mihir, 2026-07-14, via the
  regional-revenue probe: an aggregate over a hidden set is reasonable only
  when the cell is large and the slice is not along the access boundary;
  blast satisfies neither, so exact hidden counts are out.

## Still open for Mihir

1. Confirm A for `vault_edges` and lint findings, and C (documented
   acceptance) for the tension-health aggregates — or force a stricter rule.
2. Court posture: `daftari court` / docket run operator-side with no access
   context today. Declare the court an operator-only surface as a written
   invariant ("court surfaces never take an access context; exposing them via
   MCP requires this spec's review first"), or plumb an access context now?
   B′'s shape change touches only the MCP blast tool either way.
