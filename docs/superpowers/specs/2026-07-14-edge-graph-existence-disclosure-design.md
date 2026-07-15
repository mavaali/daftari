# Edge-graph existence disclosure — design options

2026-07-14. Status: **draft — options for Mihir to decide, nothing implemented.**
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

### B. Counts-visible + counts-total split (recommended for blast)

Doc **lists** contain only readable paths (omission — no name ever leaks).
**Counts** carry two numbers: `visible` (readable subset) and `total` (true
magnitude). Blast returns e.g. `primary_blast: {visible: 3, total: 40}`.

- Pro: no path leaks, and curation stays honest — the caller learns "this
  ruling settles 40 docs, 3 of which you can see," which is exactly the
  decision-relevant fact. Docket priority stays role-independent.
- Con: `total − visible` reveals the *count* of hidden downstream docs. This
  is the same accepted class as the sequential tension-id residual (#215):
  magnitude, not identity. New response shape = breaking change for blast
  consumers (docket, court report).

### C. Documented acceptance (status quo, made deliberate)

Leave the surface global; write the acceptance into the tool description and
the RBAC docs ("this surface reports vault-global structure; paths may name
docs you cannot read").

- Pro: zero code, zero shape churn; defensible for operator-facing surfaces
  that are already any-read gated.
- Con: contradicts the #212 principle for any surface reachable by a
  narrow agent role; "documented" leaks are still leaks.

## Recommendation (per surface)

| Surface | Proposal | Rationale |
|---|---|---|
| `vault_tension_blast` downstream list | **B** | Lists omit unreadable paths; counts split visible/total. Curation needs true magnitude; names are never needed by a role that can't read them. |
| `vault_edges` listing | **A** | It's a navigation surface, not a curation aggregate — nothing decision-relevant is lost by omission, so the simpler rule wins. |
| `vault_lint` findings naming docs | **A** | Same as edges: a finding you can't act on (can't read the doc) has no value to the caller. |
| `computeTensionHealth` aggregates (#216 rider) | **C** | Counts only, no paths — same accepted class as sequential ids. Lint is the operator's vault-global health view; filtering would make "vault health" role-relative. Document it. |

[HYPOTHESIS] B is right for blast because docket/court consumers use
`blast.total` for prioritization. Kill condition: if no consumer of blast
radii actually keys decisions on the total (check `priorityCompare` in
`src/court/docket.ts` and the lint/status surfaces), plain omission (A) is
simpler and wins everywhere.

## Non-goals

- No change to the tension-claim gates (#212/#215/#216) — those are settled.
- No per-surface role configuration ("who may see totals") — RBAC stays
  config-driven roles over collections, nothing finer.

## Open for Mihir

1. Accept the per-surface split above, or force one rule (A or B) everywhere?
2. Is the `total − visible` residual acceptable for blast, given the
   sequential-id precedent?
3. `court docket` / `daftari court` run operator-side with no access context
   today — should the docket ever take one, or is the court explicitly an
   operator surface? (If the latter, B's shape change touches only the MCP
   blast tool.)
