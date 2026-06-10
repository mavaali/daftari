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

### Out of scope / non-goals

- **No auto-rename and no fuzzy/auto-casing** (`Draft` → `draft` is a collision, not a silent fix). Resolution is the operator's deliberate act.
- **No partial-field backfill.** A doc with a collision is skipped whole; we do not write a doc that fails validation. (Decided during brainstorming: the operator's real workflow is rename-first, so the apply-on-unrenamed case is a safety net that should push toward the rename, not leave a half-applied doc.)
- **No new config, no MCP tool, no schema change.** CLI-only, like backfill itself.
- **Extension shadowing is already impossible** — documented at [`types.ts:51`](../../../src/frontmatter/types.ts) and *enforced* at [`config.ts:193`](../../../src/utils/config.ts) (`BUILTIN_FRONTMATTER_FIELDS.includes(field)` → config error), so a present `status` is unambiguously the built-in, never a declared custom field.

## 4. Design

### 4.1 Components (small, independently testable units)

| Unit | Change | Responsibility |
|------|--------|----------------|
| `src/backfill/collisions.ts` | **new** | `detectCollisions(raw): Collision[]` — pure, deterministic. Depends only on the enum tables. |
| `src/backfill/derive.ts` | modify | `resolve()` preserves `normalizeRawValue(raw[field])`; colliding fields labeled `"collision"`. |
| `src/backfill/types.ts` | modify | `Collision` type; `PlanEntry.collisions`; collision listing on `BackfillSummary`. |
| `src/backfill/plan.ts` | modify | populate `collisions` per entry and aggregate into the summary. |
| `src/backfill/apply.ts` | modify | `renderEntry` emits a collision-specific skip reason. |
| `src/backfill/index.ts` | modify | `renderSummary` prints the collisions section; apply output already prints skip reasons. |

### 4.2 Data shape

```ts
interface Collision {
  field: string;              // built-in enum field name, e.g. "status"
  value: string;              // author's value, stringified for display
  expected: readonly string[];// the built-in enum, e.g. STATUSES
}
```

One `Collision` per colliding field. `PlanEntry` gains `collisions: Collision[]` (empty when none). `BackfillSummary` gains a flat list (entries carry `path` + the `Collision`) so the summary renders without re-reading the plan.

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

**`--plan`** — unchanged derivation; attaches `collisions[]`; the summary reports `Field-name collisions (N)` listing `path · field: value`, followed by the rename guidance so the operator can fix before applying.

**`--apply`** — the existing guard skips a colliding doc whole (it fails validation on the preserved raw value); `renderEntry` produces a collision-specific reason rather than the generic "proposed frontmatter is invalid":

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
- **Regression** — existing backfill tests (conformant skip, missing/partial fill, idempotence, root-skip) all pass unchanged.

## 6. Open questions

None blocking. The `expected` enum list in the message is rendered from the canonical enum tables, so it cannot drift from validation.
