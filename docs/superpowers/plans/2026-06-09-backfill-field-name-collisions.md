# Backfill Field-Name Collision Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `daftari backfill` non-destructive when an existing doc uses a built-in field name (`status`/`confidence`/`domain`/`provenance`) with foreign vocabulary, detect those collisions, and report them (plus per-scope coverage) so the operator can rename and re-run.

**Architecture:** A one-line correctness fix in `derive.ts` (preserve the *raw* author value instead of the validator-coerced fallback) lets the existing apply guard skip+report colliding docs for free. On top of that: a pure `detectCollisions` over the four enum built-ins, a pure `projectCoverage` over plan entries (using the apply guard's exact validity predicate), and reporting at the plan summary, apply confirmation, and apply output.

**Tech Stack:** TypeScript, Node, vitest, biome. No new dependencies.

**Spec:** [docs/superpowers/specs/2026-06-09-backfill-field-name-collisions-design.md](../specs/2026-06-09-backfill-field-name-collisions-design.md)

**Conventions:**
- No classes — functions and types. Tool/handlers return `Result<T, Error>`, never throw.
- Tests mirror `src/` structure under `test/`, vitest (`describe`/`it`/`expect`).
- Single-file test run: `npx vitest run <path>`. Full suite: `npm test`. Build: `npm run build`. Lint: `npm run lint`.
- Commit after each task. Branch: `mihir/backfill-collision-detection` (already created).

---

### Task 1: `detectCollisions` + `Collision` type

**Files:**
- Modify: `src/backfill/types.ts` (add `Collision`)
- Create: `src/backfill/collisions.ts`
- Test: `test/backfill/collisions.test.ts`

- [ ] **Step 1: Add the `Collision` type**

In `src/backfill/types.ts`, after the imports, add:

```ts
// One frontmatter field-name collision (#116): a present field whose name is a
// built-in ENUM field but whose value is outside that field's enum — foreign
// vocabulary that backfill must not launder into a Daftari default.
export interface Collision {
  field: string; // built-in enum field name, e.g. "status"
  value: string; // the author's value, stringified for display
  expected: readonly string[]; // the built-in enum, e.g. STATUSES
}
```

- [ ] **Step 2: Write the failing test**

Create `test/backfill/collisions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { detectCollisions } from "../../src/backfill/collisions.js";

describe("detectCollisions", () => {
  it("flags each enum built-in whose value is out of enum", () => {
    const collisions = detectCollisions({
      status: "ACTIVE",
      confidence: "EXPLICIT",
      domain: "Architecture",
    });
    expect(collisions.map((c) => c.field).sort()).toEqual(["confidence", "domain", "status"]);
    const status = collisions.find((c) => c.field === "status");
    expect(status?.value).toBe("ACTIVE");
    expect(status?.expected).toContain("canonical");
  });

  it("ignores valid enum values and absent/empty fields", () => {
    expect(detectCollisions({ status: "draft", confidence: "high", domain: "accumulation" })).toEqual([]);
    expect(detectCollisions({})).toEqual([]);
    expect(detectCollisions({ status: "", domain: null })).toEqual([]);
  });

  it("flags a non-string value on an enum field as a collision", () => {
    const collisions = detectCollisions({ status: 3 });
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.value).toBe("3");
  });

  it("does not treat non-enum built-ins as collisions", () => {
    // a malformed title/date is ordinary invalid frontmatter, handled by the
    // apply guard — not a collision.
    expect(detectCollisions({ title: 123, created: "not-a-date", tags: "foo" })).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/backfill/collisions.test.ts`
Expected: FAIL — cannot find module `../../src/backfill/collisions.js`.

- [ ] **Step 4: Implement `detectCollisions`**

Create `src/backfill/collisions.ts`:

```ts
// Frontmatter field-name collision detection for `daftari backfill` (#116).
//
// A collision is a present field whose NAME is one of Daftari's built-in ENUM
// fields but whose VALUE is outside that field's enum — i.e. an existing wiki's
// own vocabulary (status: ACTIVE, domain: Architecture) clashing with Daftari's
// reserved meaning. Detecting it lets backfill preserve the value and tell the
// operator to rename, instead of silently laundering it into a default. Pure.

import { CONFIDENCES, DOMAINS, PROVENANCES, STATUSES } from "../frontmatter/types.js";
import type { Collision } from "./types.js";

// The built-in fields whose values are constrained to an enum. Non-enum
// built-ins (title, dates, arrays) are out of scope: a malformed value there is
// ordinary invalid frontmatter the apply guard already catches.
const ENUM_FIELDS: Record<string, readonly string[]> = {
  domain: DOMAINS,
  status: STATUSES,
  confidence: CONFIDENCES,
  provenance: PROVENANCES,
};

// Present means non-null, non-undefined, non-empty-string — mirrors derive's
// isPresent so detection and preservation agree on what counts as "present".
function isPresent(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string" && v.length === 0) return false;
  return true;
}

export function detectCollisions(raw: Record<string, unknown>): Collision[] {
  const collisions: Collision[] = [];
  for (const [field, expected] of Object.entries(ENUM_FIELDS)) {
    const v = raw[field];
    if (!isPresent(v)) continue;
    if (typeof v === "string" && expected.includes(v)) continue;
    collisions.push({ field, value: String(v), expected });
  }
  return collisions;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/backfill/collisions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/backfill/types.ts src/backfill/collisions.ts test/backfill/collisions.test.ts
git commit -m "feat(backfill): detectCollisions for built-in field-name collisions (#116)"
```

---

### Task 2: Correctness fix in `derive.ts` — preserve raw, label collisions

**Files:**
- Modify: `src/backfill/derive.ts` (`DeriveInputs`, `deriveProposed`/`resolve`, add `normalizeRawValue`, remove `coerced`)
- Modify: `src/backfill/plan.ts:116-125` (drop the `coerced` argument)
- Test: `test/backfill/derive.test.ts` (drop `coerced` from existing calls; add collision/preservation cases)

- [ ] **Step 1: Write the failing tests**

In `test/backfill/derive.test.ts`, inside `describe("deriveProposed", ...)`, add these cases (note: they call `deriveProposed` WITHOUT a `coerced` field — that field is being removed):

```ts
it("preserves an out-of-enum built-in value as raw and labels it a collision", () => {
  const raw = { status: "ACTIVE", confidence: "EXPLICIT", domain: "Architecture" };
  const { proposed, derivation } = deriveProposed({
    relPath: "decisions/dec-004.md",
    body: "# DEC-004",
    raw,
    git: { created: "2026-04-11", updated: "2026-04-11", author: "Mihir Wagle" },
    mtimeDate: "2026-06-09",
    identityMap: {},
    invoker: "human:tester",
  });
  // raw values survive — NOT laundered into draft/low/accumulation
  expect(proposed.status).toBe("ACTIVE");
  expect(proposed.confidence).toBe("EXPLICIT");
  expect(proposed.domain).toBe("Architecture");
  // colliding fields are labeled "collision", not "preserved"
  expect(derivation.status).toBe("collision");
  expect(derivation.confidence).toBe("collision");
  expect(derivation.domain).toBe("collision");
});

it("normalizes a present YAML Date to a YYYY-MM-DD string", () => {
  const { proposed } = deriveProposed({
    relPath: "specs/x.md",
    body: "# X",
    raw: { created: new Date("2024-12-01T00:00:00Z") },
    git: { created: null, updated: null, author: null },
    mtimeDate: "2026-06-09",
    identityMap: {},
    invoker: "human:tester",
  });
  expect(proposed.created).toBe("2024-12-01");
});

it("preserves a present malformed non-enum built-in as raw, not a coerced default (§4.4)", () => {
  // The universal-fix consequence: a present `tags` that is a string (not an
  // array) is preserved verbatim so the apply guard reports it, rather than
  // being silently coerced to []. (Apply-side skip is covered in Task 6.)
  const { proposed } = deriveProposed({
    relPath: "specs/x.md",
    body: "# X",
    raw: { tags: "foo" },
    git: { created: null, updated: null, author: null },
    mtimeDate: "2026-06-09",
    identityMap: {},
    invoker: "human:tester",
  });
  expect(proposed.tags).toBe("foo" as unknown as string[]);
});
```

Also UPDATE every existing `deriveProposed({ ... })` call in this file to remove the `coerced: ...` property (the interface no longer accepts it). There are calls around lines 106, 140, 156, 173+ — remove `coerced: emptyCoerced,` / `coerced: ...,` from each, and delete the now-unused `const emptyCoerced = {} as Frontmatter;` and the `Frontmatter` import if it becomes unused.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/backfill/derive.test.ts`
Expected: FAIL — the new cases fail (`status` is `"draft"`, derivation is `"preserved"`) and/or TS complains `coerced` is missing once the interface changes. (Type errors surface at run via vitest's esbuild.)

- [ ] **Step 3: Implement the fix**

In `src/backfill/derive.ts`:

1. Add the import at the top:
```ts
import { detectCollisions } from "./collisions.js";
```

2. Update the file header comment (lines ~5-7) — replace "Existing frontmatter is never overwritten: a present field is preserved verbatim, only missing fields are filled." with:
```ts
// Existing frontmatter is never overwritten: a present field is preserved as the
// author wrote it (Dates normalized to YYYY-MM-DD strings), only missing fields
// are filled. A present built-in field whose value is foreign vocabulary (#116)
// is preserved too and labeled a "collision" — the apply guard then skips it.
```

3. In `DeriveInputs`, DELETE the `coerced` field and its comment (lines ~100-102).

4. Add the normalizer above `deriveProposed`:
```ts
// A present field is kept verbatim, with one normalization: js-yaml parses an
// unquoted ISO date into a Date, which must become a YYYY-MM-DD string for
// serialization. Everything else (including an out-of-enum value) is returned
// as-is, so it survives to the apply guard instead of being coerced away (#116).
function normalizeRawValue(v: unknown): unknown {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return v;
}
```

5. In `deriveProposed`, change the destructure to drop `coerced`:
```ts
const { relPath, body, raw, git, mtimeDate, identityMap, invoker } = input;
const derivation: DerivationMap = {};
const collisionFields = new Set(detectCollisions(raw).map((c) => c.field));
```

6. Replace the body of `resolve` so a present field returns the normalized raw value and labels collisions:
```ts
function resolve<K extends keyof Frontmatter>(
  field: K,
  derivedValue: Frontmatter[K],
  derivedLabel: string,
): Frontmatter[K] {
  if (isPresent(raw, field as string)) {
    derivation[field as string] = collisionFields.has(field as string) ? "collision" : "preserved";
    return normalizeRawValue(raw[field as string]) as Frontmatter[K];
  }
  derivation[field as string] = derivedLabel;
  return derivedValue;
}
```

7. In `src/backfill/plan.ts`, remove the `coerced: parsed.value.frontmatter,` line from the `deriveProposed({ ... })` call (around line 120).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/backfill/derive.test.ts`
Expected: PASS (existing + 2 new cases).

- [ ] **Step 5: Run the full suite + build + lint**

Run: `npm test && npm run build && npm run lint`
Expected: all green. If a pre-existing test asserted the old lossy-coercion behavior for a present malformed field, update it to expect the value preserved (this is the intended §4.4 change) — note any such change in the commit body.

- [ ] **Step 6: Commit**

```bash
git add src/backfill/derive.ts src/backfill/plan.ts test/backfill/derive.test.ts
git commit -m "fix(backfill): preserve raw author value, don't launder out-of-enum into defaults (#116)"
```

---

### Task 3: Carry collisions on `PlanEntry`

**Files:**
- Modify: `src/backfill/types.ts` (`PlanEntry.collisions`)
- Modify: `src/backfill/plan.ts` (populate `collisions`; default it in `readPlan`)
- Test: `test/backfill/plan.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/backfill/plan.test.ts`, add a case that a doc using a built-in name with foreign vocab carries a collision on its plan entry. (The shared `buildFrontmatterLessVault` helper produces frontmatter-less docs, so add a colliding doc inline.) Add inside `describe("generatePlan", ...)`:

```ts
it("attaches collisions to a doc that reuses a built-in field name", async () => {
  // write a doc under an existing scope with a colliding built-in field
  writeFileSync(
    join(vault, "specs/data-movement/decision.md"),
    "---\nstatus: ACTIVE\n---\n# Decision\n",
  );
  const result = await generatePlan(vault, { identityMap, invoker: "human:migrator" });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const entry = result.value.entries.find((e) => e.path === "specs/data-movement/decision.md");
  expect(entry?.collisions).toEqual([
    { field: "status", value: "ACTIVE", expected: expect.arrayContaining(["canonical"]) },
  ]);
});
```

Add `writeFileSync` to the `node:fs` import at the top of the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/backfill/plan.test.ts`
Expected: FAIL — `entry.collisions` is `undefined`.

- [ ] **Step 3: Implement**

1. In `src/backfill/types.ts`, add to `PlanEntry`:
```ts
  // Field-name collisions on this doc (#116): present built-in fields whose
  // value is foreign vocabulary. Empty when none.
  collisions: Collision[];
```

2. In `src/backfill/plan.ts`, import `detectCollisions`:
```ts
import { classifyDoc, deriveProposed } from "./derive.js";
import { detectCollisions } from "./collisions.js";
```
and populate the field where the entry is pushed (around line 127):
```ts
entries.push({
  path: relPath,
  current: parsed.value.raw,
  proposed,
  derivation,
  scope,
  collisions: detectCollisions(parsed.value.raw),
});
```

3. In `readPlan`, default the field for forward-compat with any plan written before this change (after the `entries.push(parsed as PlanEntry)` validation block, before pushing — set a default):
```ts
const entry = parsed as PlanEntry;
if (!Array.isArray(entry.collisions)) entry.collisions = [];
entries.push(entry);
```
(Replace the existing `entries.push(parsed as PlanEntry);`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/backfill/plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backfill/types.ts src/backfill/plan.ts test/backfill/plan.test.ts
git commit -m "feat(backfill): carry per-doc collisions on PlanEntry (#116)"
```

---

### Task 4: `projectCoverage` + `ScopeCoverage` type

**Files:**
- Modify: `src/backfill/types.ts` (`ScopeCoverage`)
- Create: `src/backfill/coverage.ts`
- Test: `test/backfill/coverage.test.ts`

- [ ] **Step 1: Add the `ScopeCoverage` type**

In `src/backfill/types.ts`:

```ts
// Projected (plan-time) or actual coverage for one scope. willCatalog uses the
// EXACT predicate the apply guard uses, so projection cannot diverge from what
// --apply writes. A blocked entry counts in exactly one bucket; a collision
// takes precedence over other invalidity. The three sum to `planned`.
export interface ScopeCoverage {
  planned: number;
  willCatalog: number;
  blockedByCollision: number;
  blockedByOther: number;
}
```

- [ ] **Step 2: Write the failing test**

Create `test/backfill/coverage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { projectCoverage } from "../../src/backfill/coverage.js";
import type { Frontmatter } from "../../src/frontmatter/types.js";
import type { PlanEntry } from "../../src/backfill/types.js";

// A fully-valid proposed frontmatter, reused with per-test overrides.
const validProposed: Frontmatter = {
  title: "T",
  domain: "accumulation",
  collection: "specs",
  status: "canonical",
  confidence: "medium",
  created: "2026-01-01",
  updated: "2026-01-01",
  updated_by: "human:x",
  provenance: "direct",
  sources: [],
  superseded_by: null,
  ttl_days: null,
  tags: [],
  questions_answered: [],
  questions_raised: [],
};

function entry(over: Partial<Frontmatter>, collisions: PlanEntry["collisions"] = []): PlanEntry {
  return {
    path: "specs/x.md",
    current: {},
    proposed: { ...validProposed, ...over },
    derivation: {},
    scope: "specs",
    collisions,
  };
}

describe("projectCoverage", () => {
  it("buckets clean / collision / other and sums to planned", () => {
    const clean = entry({});
    const collision = entry({ status: "ACTIVE" as unknown as Frontmatter["status"] }, [
      { field: "status", value: "ACTIVE", expected: ["draft", "canonical"] },
    ]);
    const other = entry({ created: "not-a-date" });
    const cov = projectCoverage([clean, collision, other]);
    expect(cov).toEqual({ planned: 3, willCatalog: 1, blockedByCollision: 1, blockedByOther: 1 });
  });

  it("counts a doc with both a collision and another fault once, under collision", () => {
    const both = entry({ status: "ACTIVE" as unknown as Frontmatter["status"], created: "not-a-date" }, [
      { field: "status", value: "ACTIVE", expected: ["draft", "canonical"] },
    ]);
    const cov = projectCoverage([both]);
    expect(cov).toEqual({ planned: 1, willCatalog: 0, blockedByCollision: 1, blockedByOther: 0 });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/backfill/coverage.test.ts`
Expected: FAIL — cannot find module `coverage.js`.

- [ ] **Step 4: Implement `projectCoverage`**

Create `src/backfill/coverage.ts`:

```ts
// Coverage projection for `daftari backfill` (#116). For a set of plan entries,
// count how many would catalog cleanly on --apply versus be blocked, splitting
// blocked into collision vs. other. Uses the EXACT predicate the apply guard
// uses (validateFrontmatter(proposed).report.valid, extension-less, matching
// apply.ts renderEntry) so projection cannot diverge from what apply writes.

import { validateFrontmatter } from "../frontmatter/schema.js";
import type { PlanEntry, ScopeCoverage } from "./types.js";

export function projectCoverage(entries: PlanEntry[]): ScopeCoverage {
  const coverage: ScopeCoverage = {
    planned: entries.length,
    willCatalog: 0,
    blockedByCollision: 0,
    blockedByOther: 0,
  };
  for (const entry of entries) {
    const { report } = validateFrontmatter(entry.proposed as unknown as Record<string, unknown>);
    if (report.valid) coverage.willCatalog += 1;
    else if (entry.collisions.length > 0) coverage.blockedByCollision += 1;
    else coverage.blockedByOther += 1;
  }
  return coverage;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run test/backfill/coverage.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/backfill/types.ts src/backfill/coverage.ts test/backfill/coverage.test.ts
git commit -m "feat(backfill): projectCoverage over plan entries (#116)"
```

---

### Task 5: Aggregate collisions + coverage onto `BackfillSummary`

**Files:**
- Modify: `src/backfill/types.ts` (`CollisionReport`, `BackfillSummary.collisions`, `BackfillSummary.coverage`)
- Modify: `src/backfill/plan.ts` (`generatePlan` aggregation)
- Test: `test/backfill/plan.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/backfill/plan.test.ts`, add (reusing the colliding doc pattern from Task 3):

```ts
it("aggregates per-scope coverage and a flat collision list onto the summary", async () => {
  writeFileSync(
    join(vault, "specs/data-movement/decision.md"),
    "---\nstatus: ACTIVE\n---\n# Decision\n",
  );
  const result = await generatePlan(vault, { identityMap, invoker: "human:migrator" });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const cov = result.value.summary.coverage.specs;
  expect(cov.planned).toBe(result.value.summary.byScope.specs);
  expect(cov.blockedByCollision).toBe(1);
  expect(cov.willCatalog + cov.blockedByCollision + cov.blockedByOther).toBe(cov.planned);
  expect(result.value.summary.collisions).toContainEqual(
    expect.objectContaining({ path: "specs/data-movement/decision.md", field: "status", value: "ACTIVE" }),
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/backfill/plan.test.ts`
Expected: FAIL — `summary.coverage` / `summary.collisions` undefined.

- [ ] **Step 3: Implement**

1. In `src/backfill/types.ts`, add the report type and extend `BackfillSummary`:
```ts
// A collision plus the doc it lives on — the flat list the plan summary renders.
export type CollisionReport = Collision & { path: string };
```
Add to `BackfillSummary`:
```ts
  // Per-scope projected coverage (#116).
  coverage: Record<string, ScopeCoverage>;
  // Flat list of every collision across all planned docs (#116).
  collisions: CollisionReport[];
```

2. In `src/backfill/plan.ts`, import `projectCoverage`:
```ts
import { projectCoverage } from "./coverage.js";
```
Initialize the new summary fields in the literal (around line 69):
```ts
const summary: BackfillSummary = {
  missing: 0,
  partial: 0,
  conformant: 0,
  rootSkipped: 0,
  byScope: {},
  planned: 0,
  coverage: {},
  collisions: [],
};
```
After the walk loop (before `const path = planPath(...)`, around line 131), aggregate:
```ts
// Per-scope coverage + a flat collision list for the summary (#116).
const byScopeEntries = new Map<string, PlanEntry[]>();
for (const e of entries) {
  const list = byScopeEntries.get(e.scope) ?? [];
  list.push(e);
  byScopeEntries.set(e.scope, list);
  for (const c of e.collisions) summary.collisions.push({ path: e.path, ...c });
}
for (const [scope, scoped] of byScopeEntries) {
  summary.coverage[scope] = projectCoverage(scoped);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/backfill/plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backfill/types.ts src/backfill/plan.ts test/backfill/plan.test.ts
git commit -m "feat(backfill): aggregate coverage + collision list onto summary (#116)"
```

---

### Task 6: Collision-specific skip reason on `--apply`

**Files:**
- Modify: `src/backfill/apply.ts` (`renderEntry`)
- Test: `test/backfill/apply.test.ts`

- [ ] **Step 1: Write the failing tests**

In `test/backfill/apply.test.ts`, add (the shared vault helper exposes `specs` scope; add a colliding doc, re-plan, apply):

```ts
import { writeFileSync } from "node:fs"; // add to existing node:fs import if not present

it("skips a colliding doc with a rename-guidance reason, preserving its value", async () => {
  writeFileSync(join(vault, "specs/data-movement/decision.md"), "---\nstatus: ACTIVE\n---\n# Decision\n");
  const plan = await generatePlan(vault, { identityMap, invoker: "human:migrator" });
  if (!plan.ok) throw plan.error;
  const result = await applyPlan(vault, "specs", "human:migrator");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const skip = result.value.skipped.find((s) => s.path === "specs/data-movement/decision.md");
  expect(skip).toBeDefined();
  expect(skip?.reason).toContain("collision");
  expect(skip?.reason).toContain("status");
  // value untouched on disk
  const text = readFileSync(join(vault, "specs/data-movement/decision.md"), "utf-8");
  expect(text).toContain("status: ACTIVE");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/backfill/apply.test.ts`
Expected: FAIL — the skip reason is the generic "proposed frontmatter is invalid: status: expected one of …", not a collision message.

- [ ] **Step 3: Implement**

In `src/backfill/apply.ts`, import `detectCollisions`:
```ts
import { detectCollisions } from "./collisions.js";
```
In `renderEntry`, replace the invalid-guard block (currently builds a generic reason) with a collision-aware one:
```ts
const { report } = validateFrontmatter(entry.proposed as unknown as Record<string, unknown>);
if (!report.valid) {
  const collisions = detectCollisions(parsed.value.raw);
  if (collisions.length > 0) {
    const c = collisions[0] as (typeof collisions)[number];
    const more = collisions.length > 1 ? ` (and ${collisions.length - 1} more)` : "";
    return {
      ok: false,
      error: new Error(
        `collision: '${c.field}: ${c.value}' conflicts with Daftari's built-in ${c.field} ` +
          `(one of: ${c.expected.join(", ")})${more} — rename the field ` +
          `(e.g. ${c.field} → wiki_${c.field}) to keep your value; Daftari's ${c.field} ` +
          `then applies on re-run`,
      ),
    };
  }
  const summary = report.issues.map((i) => `${i.field}: ${i.message}`).join("; ");
  return { ok: false, error: new Error(`proposed frontmatter is invalid: ${summary}`) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/backfill/apply.test.ts`
Expected: PASS (existing + new). The existing "a malformed non-collision doc is skipped with the generic reason" behavior is preserved by the `else` branch — if no such test exists, add one asserting a doc with only a bad `created` date yields a reason containing "proposed frontmatter is invalid".

- [ ] **Step 5: Commit**

```bash
git add src/backfill/apply.ts test/backfill/apply.test.ts
git commit -m "feat(backfill): collision-specific skip reason with rename guidance (#116)"
```

---

### Task 7: Render collisions + coverage in the CLI

**Files:**
- Modify: `src/backfill/index.ts` (export + extend `renderSummary`; add a testable `renderApplyResult`; coverage in the apply confirmation)
- Test: `test/backfill/render.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/backfill/render.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderApplyResult, renderSummary } from "../../src/backfill/index.js";
import type { ApplyResult } from "../../src/backfill/apply.js";
import type { BackfillSummary } from "../../src/backfill/types.js";

describe("renderSummary", () => {
  it("prints per-scope coverage and a collisions section", () => {
    const summary: BackfillSummary = {
      missing: 0,
      partial: 1,
      conformant: 0,
      rootSkipped: 0,
      byScope: { decisions: 1 },
      planned: 1,
      coverage: { decisions: { planned: 1, willCatalog: 0, blockedByCollision: 1, blockedByOther: 0 } },
      collisions: [{ path: "decisions/d.md", field: "status", value: "ACTIVE", expected: ["draft", "canonical"] }],
    };
    const out = renderSummary(summary, "/v/.daftari/backfill-plan.jsonl");
    expect(out).toContain("will catalog");
    expect(out).toContain("blocked by collisions");
    expect(out).toContain("Field-name collisions (1)");
    expect(out).toContain("decisions/d.md");
    expect(out).toContain("status: ACTIVE");
  });
});

describe("renderApplyResult", () => {
  it("prints an actual-coverage line (cataloged = applied + unchanged)", () => {
    const r: ApplyResult = {
      scope: "decisions",
      applied: ["decisions/a.md"],
      unchanged: [],
      skipped: [{ path: "decisions/b.md", reason: "collision: ..." }],
      commit: "abc1234",
    };
    const out = renderApplyResult(r);
    expect(out).toContain("cataloged 1 of 2");
    expect(out).toContain("1 skipped");
    expect(out).toContain("decisions/b.md");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/backfill/render.test.ts`
Expected: FAIL — `renderApplyResult` is not exported / does not exist; `renderSummary` not exported.

- [ ] **Step 3: Implement**

In `src/backfill/index.ts`:

1. Add imports for the apply result type and coverage projection:
```ts
import { type ApplyResult, applyPlan } from "./apply.js";
import { projectCoverage } from "./coverage.js";
import { planPath, readPlan } from "./plan.js"; // planPath/readPlan likely already imported via apply; import what's missing
```
(Adjust to whatever is already imported; `applyPlan` is already imported — add `ApplyResult` to that import.)

2. EXPORT `renderSummary` (add `export` to its declaration) and extend it. After the existing per-scope `byScope` loop, replace the loop body to print coverage, and add a collisions section. Replace:
```ts
for (const scope of Object.keys(summary.byScope).sort()) {
  lines.push(`    ${scope}: ${summary.byScope[scope]}`);
}
```
with:
```ts
for (const scope of Object.keys(summary.byScope).sort()) {
  const cov = summary.coverage[scope];
  lines.push(
    cov
      ? `    ${scope}: ${cov.planned} planned · ${cov.willCatalog} will catalog · ` +
          `${cov.blockedByCollision} blocked by collisions · ${cov.blockedByOther} other`
      : `    ${scope}: ${summary.byScope[scope]}`,
  );
}
```
And before the closing `return`, add the collisions section:
```ts
if (summary.collisions.length > 0) {
  lines.push("");
  lines.push(`  Field-name collisions (${summary.collisions.length}) — your value clashes with a built-in:`);
  for (const c of summary.collisions) {
    lines.push(`    ${c.path} · ${c.field}: ${c.value}  (built-in ${c.field} ∈ {${c.expected.join(", ")}})`);
  }
  lines.push("");
  lines.push("  Rename each colliding field (e.g. status → wiki_status) to keep your value;");
  lines.push("  Daftari's built-in then applies on re-run. Colliding docs are skipped until renamed.");
}
```

3. EXTRACT the apply-output rendering into an exported pure function. Add:
```ts
export function renderApplyResult(r: ApplyResult): string {
  const cataloged = r.applied.length + r.unchanged.length;
  const total = cataloged + r.skipped.length;
  const out: string[] = [];
  out.push(`Backfill applied to '${r.scope}':`);
  out.push(`  cataloged ${cataloged} of ${total}${r.skipped.length > 0 ? ` · ${r.skipped.length} skipped` : ""}`);
  out.push(`  written:   ${r.applied.length}`);
  out.push(`  unchanged: ${r.unchanged.length}`);
  if (r.skipped.length > 0) {
    out.push(`  skipped:   ${r.skipped.length}`);
    for (const s of r.skipped) out.push(`    ${s.path}: ${s.reason}`);
  }
  if (r.commit) out.push(`  commit:    ${r.commit}`);
  else if (r.applied.length === 0) out.push("  (no changes — already applied)");
  return `${out.join("\n")}\n`;
}
```
Then in `runBackfill`'s `--apply` path, replace the inline `out`-building block (the `const out: string[] = []; … process.stdout.write(...)`) with:
```ts
process.stdout.write(renderApplyResult(r));
return 0;
```
(Keep the earlier no-op early-return for the empty-scope case as-is.)

4. Add projected coverage to the confirmation prompt. Just before the `confirm(...)` call, read the plan and project coverage for the scope:
```ts
let coverageNote = "";
const planForCoverage = await readPlan(planPath(vaultRoot));
if (planForCoverage.ok) {
  const cov = projectCoverage(planForCoverage.value.filter((e) => e.scope === scope));
  coverageNote =
    ` — ${cov.willCatalog} of ${cov.planned} will catalog` +
    (cov.blockedByCollision > 0 ? `, ${cov.blockedByCollision} blocked by collisions` : "");
}
const proceed = await confirm(
  `Apply backfilled frontmatter to docs under '${scope}'${coverageNote} and commit as ${agent}? [y/N] `,
);
```
(`ApplyResult` needs to be exported from `apply.ts` — it already is. `renderApplyResult` references its shape.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/backfill/render.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the CLI snapshot/e2e test if present**

Run: `npx vitest run test/backfill/cli.test.ts`
Expected: PASS — if `cli.test.ts` asserts exact plan/apply stdout, update its expectations to include the new coverage line and (where applicable) the collisions section.

- [ ] **Step 6: Full green + commit**

Run: `npm test && npm run build && npm run lint`
Expected: all green.

```bash
git add src/backfill/index.ts test/backfill/render.test.ts test/backfill/cli.test.ts
git commit -m "feat(backfill): render collisions + per-scope coverage in the CLI (#116)"
```

---

### Task 8: Manual verification + issue trace

**Files:** none (verification only)

- [ ] **Step 1: Reproduce the original incident, fixed**

Build, then run a throwaway repro on a temp wiki with a colliding decision doc:

```bash
npm run build
TMP=$(mktemp -d) && mkdir -p "$TMP/decisions" && git -C "$TMP" init -q
printf -- "---\nstatus: ACTIVE\nconfidence: EXPLICIT\ndomain: Architecture\n---\n# DEC-004\n" > "$TMP/decisions/dec-004.md"
node dist/cli.js --init "$TMP" --yes 2>/dev/null || true   # if needed to scaffold .daftari; else skip
node dist/cli.js backfill --plan --vault "$TMP"
```
Expected: the plan summary lists `decisions: … blocked by collisions`, a `Field-name collisions (3)` section naming `status: ACTIVE`, `confidence: EXPLICIT`, `domain: Architecture`, and rename guidance.

- [ ] **Step 2: Confirm apply preserves the values**

```bash
node dist/cli.js backfill --apply --scope decisions --vault "$TMP" --yes
```
Expected: `cataloged 0 of 1 · 1 skipped`, a `collision:` reason, and `grep status "$TMP/decisions/dec-004.md"` still shows `status: ACTIVE` (untouched). Clean up: `rm -rf "$TMP"`.

- [ ] **Step 3: Final full suite**

Run: `npm test && npm run build && npm run lint`
Expected: all green. No commit needed (verification only).
