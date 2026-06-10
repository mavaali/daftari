# Backfill Field-Name Collision Detection — Design

**Status:** Draft 2026-06-09, awaiting spec-review-loop and user approval.
**Issue:** [mavaali/daftari#116](https://github.com/mavaali/daftari/issues/116) — Backfill should detect and skip semantic field-name collisions with built-in fields.
**Relationship to other work:** Distinct from [#113](https://github.com/mavaali/daftari/issues/113) (which *dropped* undeclared fields — a bug fixed in 1.17.1). #113 made writes non-destructive for fields Daftari doesn't know about; this spec closes the *remaining* destructive path: a present field whose **name** is a built-in but whose **value** is foreign vocabulary, which `daftari backfill` silently launders into a built-in default. Touches only `src/backfill/*` plus one shared helper; no MCP tool, no config, no schema change.

---

## 1. Purpose

`daftari backfill --apply` silently overwrites built-in frontmatter fields when an existing doc uses that field name with a value outside Daftari's enum. A pre-Daftari wiki adopting Daftari is the exact population most likely to collide — its own `status` / `confidence` / `domain` vocabulary maps onto Daftari's reserved field names. Backfill is the primary adoption path, so this silent meaning-loss lands on first contact.

Make backfill **non-destructive and self-explaining** for these collisions: never launder a foreign value into a built-in default, surface the collision at plan time, and guide the operator to the resolution (rename the colliding field so Daftari's built-in applies cleanly).

## 2. Root cause (verified against code)

The loss is one line. In [`src/backfill/derive.ts`](../../../src/backfill/derive.ts), `resolve()` (declared at line 126) preserves a present field by returning `coerced[field]` (line 133), where `coerced = validateFrontmatter(raw).frontmatter`. For an enum field, `requireEnum` ([`src/frontmatter/schema.ts:118`](../../../src/frontmatter/schema.ts)) returns the **fallback** for any out-of-enum value:

- `status: ACTIVE` → not in `STATUSES` → coerced to `"draft"`
- `confidence: EXPLICIT` → coerced to `"low"`
- `domain: Architecture` → coerced to `"accumulation"`

So `entry.proposed.status` is already the *valid fallback* before it reaches the apply-time guard in [`renderEntry` (`apply.ts:56`)](../../../src/backfill/apply.ts), which validates `proposed` and skips invalid docs. The guard works for a malformed **date** (`requireDate` carries the bad string through → guard catches it → doc skipped) but is blind to an out-of-enum **enum**, because the enum coercion has already substituted a valid value. The derivation map even labels the changed field `"preserved"` — the label lies, contradicting the function header ("preserved verbatim") and the 1.17.0 changelog ("preserved field-by-field").

## 3. Scope

### In scope

- **Correctness fix:** preserve the *raw* author value for present fields, normalizing only the one case coercion exists for (a YAML `Date` → `YYYY-MM-DD` string). Universal across all built-in fields, not just enums.
- **Collision detection:** a pure `detectCollisions(raw)` over the four enum built-ins (`domain`, `status`, `confidence`, `provenance`).
- **Plan reporting:** `collisions[]` on each `PlanEntry`; a collision count + listing in the plan summary; a derivation label of `"collision"` for colliding fields.
- **Apply reporting:** the existing whole-doc skip, with a collision-specific reason that models the rename resolution.
- **Coverage reporting:** per-scope counts of how many docs will catalog cleanly vs. be blocked (split: blocked-by-collision vs. blocked-by-other-invalidity), surfaced at the three decision points — the plan summary (projected), the interactive apply confirmation (projected, for the chosen scope), and the apply output (actual). Reporting only; no threshold and no abort.

### Out of scope / non-goals

- **No auto-rename and no fuzzy/auto-casing** (`Draft` → `draft` is a collision, not a silent fix). Resolution is the operator's deliberate act.
- **No partial-field backfill.** A doc with a collision is skipped whole; we do not write a doc that fails validation. (Decided during brainstorming: the operator's real workflow is rename-first, so the apply-on-unrenamed case is a safety net that should push toward the rename, not leave a half-applied doc.)
- **No new config, no MCP tool, no schema change.** CLI-only, like backfill itself.
- **No skip-rate threshold or abort.** We considered a coverage floor (hard default or opt-in `--min-coverage`) that aborts apply when too many docs are skipped; rejected in favor of **reporting only**. Rationale: a skipped doc is untouched and reported, so this is an *awareness* risk, not an *integrity* risk; the skip count is fully known at plan time (the natural review point in a plan→ratify→apply flow); and a percentage threshold either blocks legitimate partial progress (e.g. 200 of 500 docs cataloging cleanly) or gives false comfort. Coverage is made loud at every decision point instead of blocking.
- **Extension shadowing is already impossible** — documented at [`types.ts:51`](../../../src/frontmatter/types.ts) and *enforced* at [`config.ts:193`](../../../src/utils/config.ts) (`BUILTIN_FRONTMATTER_FIELDS.includes(field)` → config error), so a present `status` is unambiguously the built-in, never a declared custom field.

## 4. Design

### 4.1 Components (small, independently testable units)

| Unit | Change | Responsibility |
|------|--------|----------------|
| `src/backfill/collisions.ts` | **new** | `detectCollisions(raw): Collision[]` — pure, deterministic. Depends only on the enum tables. |
| `src/backfill/derive.ts` | modify | `resolve()` preserves `normalizeRawValue(raw[field])`; colliding fields labeled `"collision"`. |
| `src/backfill/coverage.ts` | **new** | `projectCoverage(entries): ScopeCoverage` — for a set of plan entries, count how many would catalog cleanly (`validateFrontmatter(entry.proposed).report.valid` — the *same* predicate the apply guard uses) vs. blocked-by-collision vs. blocked-by-other. Pure; shared by plan summary and the apply confirmation so the projection logic lives in one place. |
| `src/backfill/types.ts` | modify | `Collision` type; `PlanEntry.collisions`; `ScopeCoverage` type; per-scope coverage on `BackfillSummary`. |
| `src/backfill/plan.ts` | modify | populate `collisions` per entry; aggregate collisions + per-scope coverage into the summary. |
| `src/backfill/apply.ts` | modify | `renderEntry` emits a collision-specific skip reason; `ApplyResult` already carries `applied`/`unchanged`/`skipped`, enough to render actual coverage as `cataloged N of M · K skipped` (cataloged = `applied + unchanged`). The collision-vs-other split is **not** re-aggregated here (skip `reason` is free-text and `skipped` also holds IO failures) — that split is shown projected at plan + confirmation, and per-doc at apply via the reasons. |
| `src/backfill/index.ts` | modify | `renderSummary` prints the collisions section and per-scope coverage; the interactive apply confirmation states projected coverage for the chosen scope; the apply output adds an actual-coverage line. |

### 4.2 Data shape

```ts
interface Collision {
  field: string;              // built-in enum field name, e.g. "status"
  value: string;              // author's value, stringified for display
  expected: readonly string[];// the built-in enum, e.g. STATUSES
}
```

One `Collision` per colliding field. `PlanEntry` gains `collisions: Collision[]` (empty when none). `BackfillSummary` gains a flat list (entries carry `path` + the `Collision`) so the summary renders without re-reading the plan.

```ts
interface ScopeCoverage {
  planned: number;            // in-scope plan entries
  willCatalog: number;        // validateFrontmatter(proposed).report.valid → applies cleanly
  blockedByCollision: number; // skipped: has ≥1 collision
  blockedByOther: number;     // skipped: invalid for a non-collision reason (e.g. malformed date)
}
```

`willCatalog + blockedByCollision + blockedByOther === planned`. A blocked entry is counted in exactly one blocked bucket — `blockedByCollision` takes precedence when an entry has both a collision and another fault, so the two never double-count. Coverage % is `willCatalog / planned`. `BackfillSummary` carries `ScopeCoverage` keyed by scope.

Two bridges keep projected and actual coverage honest:
- **`willCatalog` uses the apply guard's exact predicate** — `validateFrontmatter(entry.proposed).report.valid` (the condition at [`apply.ts:59`](../../../src/backfill/apply.ts) that decides write-vs-skip) — so projected coverage cannot diverge from what `--apply` actually writes.
- **Per scope, `ScopeCoverage.planned === BackfillSummary.byScope[scope]`** (root-skipped docs produce no plan entry and are outside coverage entirely). At apply time, *actual* "cataloged" = `applied + unchanged`; the apply output renders `cataloged N of M · K skipped` and leaves collision-vs-other to the per-doc skip reasons (the projected split already appeared at plan and confirmation).

### 4.3 `detectCollisions(raw)`

For each of the four enum built-ins, if the field is *present* (`isPresent` semantics: non-null, non-empty-string) and its raw value is not an exact member of that field's enum, emit a `Collision`. Non-enum built-ins are out of scope: a malformed `title`/date/array is ordinary invalid frontmatter, already handled by the apply guard, not a "collision."

### 4.4 The correctness fix

`resolve()` for a present field returns `normalizeRawValue(raw[field])` instead of `coerced[field]`:

```ts
// Date → YYYY-MM-DD string (the one coercion we keep); everything else verbatim.
function normalizeRawValue(v: unknown): unknown {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return v;
}
```

Consequence (intended): this makes preservation non-destructive for **every** field, not just enums. A present malformed field (e.g. `tags: "foo"` as a string) now flows to the apply guard and causes a skip+report, instead of being silently coerced to `[]`. This is the #113 spirit applied to backfill; some docs that previously backfilled with lossy coercion will now be reported instead. Collision *diagnostics* remain scoped to the enum built-ins; the correctness fix is universal.

### 4.5 Behavior

**`--plan`** — unchanged derivation; attaches `collisions[]`; the summary reports `Field-name collisions (N)` listing `path · field: value`, followed by the rename guidance so the operator can fix before applying. The summary also prints **per-scope coverage** so incompleteness is visible at ratification time, e.g.:

```
  decisions: 50 planned · 2 will catalog · 48 blocked by collisions · 0 other  (4% coverage)
```

**Apply confirmation** — the interactive prompt states projected coverage for the chosen scope before the operator commits, e.g. `Apply to 'decisions' — 2 of 50 docs will catalog (48 blocked by collisions). Proceed? [y/N]`. (With `--yes` the prompt is skipped; the actual coverage still prints in the apply output below.)

**`--apply`** — the existing guard skips a colliding doc whole (it fails validation on the preserved raw value); the output adds an actual-coverage line (`cataloged 2 of 50 · 48 skipped`, where cataloged = `applied + unchanged`), with the per-doc skip reasons below it carrying the collision specifics; `renderEntry` produces a collision-specific reason rather than the generic "proposed frontmatter is invalid":

```
collision: 'status: ACTIVE' conflicts with Daftari's built-in status
  (one of: draft, canonical, deprecated, superseded, archived)
  → rename to keep your value, e.g.  decision_status: ACTIVE
     then Daftari's `status` applies cleanly on re-run
```

**Resolution path** (operator's real workflow): rename `status` → `decision_status`. On re-plan/apply, `decision_status: ACTIVE` is an undeclared field preserved verbatim by `serializeDocument`, and the now-missing built-in `status` gets its derived default → doc conformant.

### 4.6 Idempotence

A `--plan` of an unrenamed doc keeps reporting the collision; `--apply` keeps skipping it. No churn (the existing idempotence — identical bytes → no write — is unaffected; skipped docs are never written).

## 5. Testing

Tests mirror `src/` structure (per CLAUDE.md), one file per unit.

- **`test/backfill/collisions.test.ts`** — each enum built-in with a foreign value → collision; valid enum value → none; non-string enum value → collision; missing/empty → none; non-enum built-in malformed → not reported as a collision.
- **`derive` tests** — out-of-enum present field preserved as raw (not the fallback); present YAML `Date` `created` still normalized to `YYYY-MM-DD`; derivation label `"collision"` for the colliding field; the issue's three-field repro (`status`/`confidence`/`domain`) all preserved.
- **`apply` tests** — a colliding doc is skipped whole with the collision-specific reason; non-colliding docs in the same scope are unaffected; after a simulated rename the doc backfills conformant; a doc whose *only* problem is a malformed date (not a collision) is skipped with the generic reason (regression of the existing guard).
- **Universal-fix tests** — a present malformed *non-enum* built-in (e.g. `tags: "foo"` as a string, or a non-string `title`) is now preserved as raw and skipped+reported by the guard, rather than silently coerced to `[]`/`""`. This covers the §4.4 newly-reported population — the behavior change with the widest blast radius.
- **`plan` / summary tests** — collisions counted and listed; the rename guidance renders.
- **`coverage` tests** — `projectCoverage` over a mixed set: a clean doc, a collision doc, and a malformed-date doc yield `willCatalog`/`blockedByCollision`/`blockedByOther` of 1/1/1; a doc with *both* a collision and another fault counts once, under `blockedByCollision`; the three buckets sum to `planned`. Plus: the plan summary renders the per-scope coverage line (`will catalog` / `blocked by collisions` / `other`); the apply confirmation states projected coverage for the scope; and the apply output renders `cataloged N of M · K skipped` (cataloged = `applied + unchanged`).
- **Regression** — existing backfill tests (conformant skip, missing/partial fill, idempotence, root-skip) all pass unchanged.

## 6. Open questions

None blocking. The `expected` enum list in the message is rendered from the canonical enum tables, so it cannot drift from validation.
