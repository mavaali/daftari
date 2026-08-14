# Tension Triage Legibility v1 — R1: Criticality Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional `criticality: low|medium|high` frontmatter field to Daftari documents and surface it per contested side on the unranked tension-triage card, so a human triaging tensions can see cost-of-being-wrong at a glance.

**Architecture:** `criticality` is a new optional/nullable builtin frontmatter field that mirrors the existing `tier` field exactly (optional enum, null-default, no migration). It threads through the same three layers `tier` already flows through: the frontmatter type/schema, the triage enrichment (`loadTensionTriage`), and the card renderer. It is legibility-only — advisory, unranked, no scoring, no write-path enforcement, no auto-resolution.

**Tech Stack:** TypeScript (Node ≥20), vitest, no new deps. Result<T,E> pattern, functions+types (no classes), per the repo's `CLAUDE.md`.

**Branch/worktree:** `feat/tension-legibility-v1` (worktree `.worktrees/tension-legibility-v1`, off `origin/main` which contains v0 / #334). Disclosure: v0 is already public; this generic legibility field is fine to land — but do NOT push/PR until Mihir confirms.

**Scope boundary (YAGNI):** THIS plan is R1 only — the field + the triage-card surface. Explicitly deferred to later increments: R2 (per-side provenance on card), R3 (advisory recommended-resolution-kind — has an unresolved design question about nudging premature closure), R4 (composite-cost rendering). Also deferred: surfacing criticality in `vault_read`/`vault_index`/lint (the triage card is the R1 legibility surface).

**Design decision (Mihir, confirmed 2026-08-04):** criticality lives in a frontmatter field (inspectable, lintable, one source of truth), not a tag or folder convention.

---

## File Structure

- `src/frontmatter/types.ts` — add `Criticality` type + `CRITICALITIES` const; add `criticality` to `BuiltinFrontmatter` and `BUILTIN_FRONTMATTER_FIELDS`. (Responsibility: the core schema.)
- `src/frontmatter/schema.ts` — validate `criticality` via the existing `optionalEnum` helper. (Responsibility: advisory validation + default.)
- `src/curation/tension-triage.ts` — add `criticality` to `TriageDocMeta` + `TriageSide`; populate it in `sideFor` and `loadTensionTriage`. (Responsibility: the triage enrichment engine — the single feature-extraction path.)
- `src/court/triage.ts` — render `criticality` in `renderSide`. (Responsibility: the pure card renderer.)
- Any tsc-flagged exhaustive site (serialize / okf / backfill) — mirror `tier`. (Discovered by the compiler, see Task 3.)
- `src/tools/curation.ts` — if the `vault_tension_triage` output schema enumerates side fields, add `criticality` (Task 6).

**Guiding heuristic for the engineer:** `criticality` is structurally identical to `tier` (optional enum, `X | null`, null when absent, no write enforcement). When unsure how to handle it at any site, `grep -n '\btier\b'` that file and mirror it. Do NOT copy tier's write-protection *semantics* — criticality enforces nothing; it is display-only.

---

## Task 1: Add the Criticality type and builtin field

**Files:**
- Modify: `src/frontmatter/types.ts`
- Test: `test/frontmatter/types.test.ts` (create if absent; else add to the nearest existing frontmatter types test)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { BUILTIN_FRONTMATTER_FIELDS, CRITICALITIES } from "../../src/frontmatter/types.js";

describe("criticality builtin field", () => {
  it("declares the three levels", () => {
    expect(CRITICALITIES).toEqual(["low", "medium", "high"]);
  });
  it("is a registered builtin field name", () => {
    expect(BUILTIN_FRONTMATTER_FIELDS).toContain("criticality");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd .worktrees/tension-legibility-v1 && npx vitest run test/frontmatter/types.test.ts`
Expected: FAIL — `CRITICALITIES` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/frontmatter/types.ts`, after the `TIERS`/`Tier` block (around line 29), add:

```typescript
// Cost-of-being-wrong for a document — the one triage signal the graph cannot
// infer (a pricing/legal/security doc is load-bearing; a scratch note is not).
// Optional and display-only: it enforces nothing on the write path, it makes a
// tension's stakes legible. Null = unstated (every pre-feature doc), never "low".
export const CRITICALITIES = ["low", "medium", "high"] as const;
export type Criticality = (typeof CRITICALITIES)[number];
```

In `interface BuiltinFrontmatter`, add alongside `tier` (after line 49):

```typescript
  criticality: Criticality | null;
```

In `BUILTIN_FRONTMATTER_FIELDS`, add after `"tier",`:

```typescript
  "criticality",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/frontmatter/types.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontmatter/types.ts test/frontmatter/types.test.ts
git commit -m "feat(frontmatter): add optional criticality field (types)"
```

---

## Task 2: Validate criticality in the frontmatter schema

**Files:**
- Modify: `src/frontmatter/schema.ts`
- Test: `test/frontmatter/schema.test.ts` (add cases to the existing suite)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from "vitest";
import { validateFrontmatter } from "../../src/frontmatter/schema.js";

describe("criticality validation", () => {
  it("accepts a valid level", () => {
    const { frontmatter, report } = validateFrontmatter({
      title: "t", domain: "accumulation", collection: "c", status: "draft",
      confidence: "low", created: "2026-01-01", updated: "2026-01-01",
      updated_by: "agent:x", provenance: "direct", criticality: "high",
    });
    expect(frontmatter.criticality).toBe("high");
    expect(report.valid).toBe(true);
  });
  it("defaults to null when absent", () => {
    const { frontmatter } = validateFrontmatter({
      title: "t", domain: "accumulation", collection: "c", status: "draft",
      confidence: "low", created: "2026-01-01", updated: "2026-01-01",
      updated_by: "agent:x", provenance: "direct",
    });
    expect(frontmatter.criticality).toBeNull();
  });
  it("flags a malformed value (mirrors tier)", () => {
    const { frontmatter, report } = validateFrontmatter({
      title: "t", domain: "accumulation", collection: "c", status: "draft",
      confidence: "low", created: "2026-01-01", updated: "2026-01-01",
      updated_by: "agent:x", provenance: "direct", criticality: "urgent",
    });
    expect(frontmatter.criticality).toBeNull();
    expect(report.issues.some((i) => i.field === "criticality")).toBe(true);
    expect(report.valid).toBe(false); // pin the blocking contract (mirrors tier)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/frontmatter/schema.test.ts`
Expected: FAIL — `frontmatter.criticality` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `src/frontmatter/schema.ts`, add `CRITICALITIES` + `Criticality` to the import from `./types.js`. Then in the `frontmatter` object literal, immediately after the `tier:` line (~263), add:

```typescript
    criticality: optionalEnum<Criticality>("criticality", CRITICALITIES),
```

(Note: `optionalEnum` returns null when absent and pushes an issue for a malformed value — the exact tier behavior. This means a malformed `criticality` sets `report.valid = false`, consistent with `tier`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/frontmatter/schema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/frontmatter/schema.ts test/frontmatter/schema.test.ts
git commit -m "feat(frontmatter): validate criticality field (schema)"
```

---

## Task 3: Serialize criticality to disk + fix the serialize-order test

**CRITICAL (from review):** serialization is NOT generic and NOT tsc-guarded. `serializeDocument` (`src/tools/write.ts:220`) hard-codes each builtin field into an `ordered` object literal (reads `fm.tier`, `fm.valid_from`, … individually). Adding `criticality` to the type produces **no tsc error at that site**, so without an explicit edit `criticality` is **silently dropped on every write** (data loss, green build). The only site the compiler catches is a test's typed `fm()` literal. So do NOT rely on the compiler — make these edits by hand.

**Files:**
- Modify: `src/tools/write.ts` (`serializeDocument`, ~line 220-251)
- Modify: `test/tools/serialize-order.test.ts` (`fm()` helper ~line 8-30; `BUILTIN_KEYS` array ~line 37-57)

- [ ] **Step 1: Update the serialize-order test first (RED)**

In `test/tools/serialize-order.test.ts`: add `criticality: null,` to the `fm()` object literal (so it type-checks against the now-required field), and add `"criticality"` to the `BUILTIN_KEYS` array **immediately after `"tier"`** (the on-disk field order). Also add a round-trip assertion:

```typescript
it("round-trips criticality through serialize", () => {
  const text = serializeDocument({ ...fm(), criticality: "high" }, "body");
  expect(text).toContain("criticality: high");
});
```

- [ ] **Step 2: Run — verify the round-trip test FAILS and the key-order tests fail**

Run: `cd .worktrees/tension-legibility-v1 && npx vitest run test/tools/serialize-order.test.ts`
Expected: FAIL — `criticality` not emitted; `.toEqual(BUILTIN_KEYS)` mismatches.

- [ ] **Step 3: Emit criticality in serializeDocument**

In `src/tools/write.ts`, in the `ordered` literal, immediately after the `tier` line, add (mirroring the `?? null` guard `tier` uses — a hand-built pre-feature `Frontmatter` carries `undefined`, which js-yaml refuses to dump):

```typescript
    criticality: fm.criticality ?? null,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/tools/serialize-order.test.ts`
Expected: PASS (round-trip + key-order).

- [ ] **Step 5: Full type-check + suite (catch any other exhaustive site)**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; full suite green (baseline 2711 + new tests). If tsc flags any other typed-`Frontmatter` literal (e.g. another test fixture), add `criticality: null` there — those ARE compiler-caught.

- [ ] **Step 6: Commit**

```bash
git add src/tools/write.ts test/tools/serialize-order.test.ts
git commit -m "feat(write): serialize criticality field + fix key-order test"
```

---

## Task 4: Thread criticality into the triage enrichment

**Files:**
- Modify: `src/curation/tension-triage.ts`
- Test: `test/curation/tension-triage.test.ts` (add to existing suite)

- [ ] **Step 1: Write the failing test**

Add a case asserting an enriched side carries `criticality` from `docMeta`:

```typescript
it("surfaces per-side criticality from doc metadata", () => {
  const tensions = [{
    id: "tension-001", date: "2026-01-01", title: "t", kind: "factual" as const,
    sourceA: "a.md", claimA: "A", sourceB: "b.md", claimB: "B",
    status: "unresolved", loggedBy: "agent:x", resolved: false,
  }];
  const docMeta = new Map([
    ["a.md", { tier: null, confidence: "high" as const, criticality: "high" as const }],
    ["b.md", { tier: null, confidence: "low" as const, criticality: null }],
  ]);
  const result = computeTensionTriage(tensions as never, {
    docMeta, readHeat: new Map(), blastByTension: new Map(),
  }, new Date("2026-02-01"));
  const t = result.clusters.flatMap((c) => c.tensions)[0];
  expect(t.a.criticality).toBe("high");
  expect(t.b.criticality).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/curation/tension-triage.test.ts`
Expected: FAIL — `criticality` missing on `TriageSide` / type error on `docMeta`.

- [ ] **Step 3: Write minimal implementation**

In `src/curation/tension-triage.ts`:
1. Import `Criticality` from `../frontmatter/types.js` (alongside `Confidence, Tier`).
2. Add to `TriageDocMeta`: `criticality: Criticality | null;`
3. Add to `TriageSide`: `criticality: Criticality | null;`
4. In `sideFor`, add: `criticality: m ? m.criticality : null,`
5. In `loadTensionTriage`'s `docMeta.set(...)`, add: `criticality: d.frontmatter.criticality,`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/curation/tension-triage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/curation/tension-triage.ts test/curation/tension-triage.test.ts
git commit -m "feat(triage): enrich sides with criticality"
```

---

## Task 5: Render criticality on the triage card

**Files:**
- Modify: `src/court/triage.ts`
- Test: `test/court/triage.test.ts` (add to existing suite)

- [ ] **Step 1: Write the failing test**

Assert `renderTriageCard` output includes a criticality token for a side, and `—` when null:

```typescript
it("renders per-side criticality, dash when unstated", () => {
  const result = {
    cluster_count: 1, tension_count: 1,
    clusters: [{ cluster_id: "c1", documents: ["a.md", "b.md"], tensions: [{
      id: "tension-001", title: "t", kind: "factual", age_days: 5,
      a: { path: "a.md", claim: "A", tier: null, confidence: "high", read_heat: null, criticality: "high" },
      b: { path: "b.md", claim: "B", tier: null, confidence: "low", read_heat: null, criticality: null },
      primary_blast: 0, advisory_blast: 0, hidden_downstream: "none",
    }] }],
  };
  const out = renderTriageCard(result as never);
  expect(out).toContain("crit high");
  expect(out).toContain("crit —");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/court/triage.test.ts`
Expected: FAIL — no `crit` token in output.

- [ ] **Step 3: Write minimal implementation**

In `src/court/triage.ts::renderSide`, add a criticality token to the head line, mirroring `tier`:

```typescript
function renderSide(label: string, side: TriageSide): string[] {
  const tier = side.tier === null ? "—" : String(side.tier);
  const conf = side.confidence === null ? "—" : side.confidence;
  const crit = side.criticality === null ? "—" : side.criticality;
  const head = `    ${label}  ${side.path}  ·  tier ${tier} · conf ${conf} · crit ${crit} · ${renderReadHeat(side)}`;
  const claim = `       "${truncate(side.claim, CLAIM_WIDTH)}"`;
  return [head, claim];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/court/triage.test.ts`
Expected: PASS.

- [ ] **Step 4b: Check for a parallel side-render path (review should-fix)**

Run: `grep -n '\btier\b' src/court/index.ts src/court/precedent.ts`
`renderSide` in `triage.ts` is the triage card's path; if `index.ts` or `precedent.ts` renders sides independently and shows tier/confidence, mirror `crit` there too. If neither renders sides (only wires/looks up), no change.

- [ ] **Step 5: Commit**

```bash
git add src/court/triage.ts test/court/triage.test.ts
git commit -m "feat(court): show per-side criticality on the triage card"
```

---

## Task 6: Add criticality to the vault_tension_triage output schema (mandatory)

**CRITICAL (from review):** `triageSideSchema` (`src/tools/curation.ts:698-709`) is a hand-written JSON Schema with **`additionalProperties: false`**. The handler returns `TriageSide` objects directly, so `criticality` IS present at runtime — which means a strict MCP client validating tool output against `outputSchema` will **reject** the response for an undeclared property. This is a required edit, not a "verify."

**Files:**
- Modify: `src/tools/curation.ts` (`triageSideSchema`, ~line 698-709)
- Test: the existing `vault_tension_triage` tool test (add an assertion)

- [ ] **Step 1: Write the failing test**

Add an assertion that the tool's output-schema `triageSideSchema.properties` declares `criticality` (and that a returned side carries it). Run it — FAIL (property undeclared).

Run: `cd .worktrees/tension-legibility-v1 && npx vitest run test/tools/curation.test.ts`

- [ ] **Step 2: Add criticality to the schema properties**

In `triageSideSchema.properties`, mirroring how `tier`/`confidence` are declared, add (use a **string enum**, NOT integer — note: the existing `tier` prop is mis-declared `type: ["integer","null"]`, a pre-existing bug; do NOT copy that onto criticality, and do NOT fix tier here — out of R1 scope):

```typescript
        criticality: { type: ["string", "null"], enum: ["low", "medium", "high", null] },
```

Leave `criticality` OUT of the `required` array (it's optional/nullable).

- [ ] **Step 3: Run test to verify it passes**

Run: `npx vitest run test/tools/curation.test.ts`
Expected: PASS.

- [ ] **Step 4: Full suite**

Run: `npx vitest run`
Expected: PASS across the board.

- [ ] **Step 5: Commit**

```bash
git add src/tools/curation.ts test/tools/curation.test.ts
git commit -m "feat(mcp): declare criticality on vault_tension_triage output schema"
```

---

## Task 7: Docs + live smoke

**Files:**
- Modify: `docs/architecture.md` or the frontmatter-field reference doc if it enumerates builtin fields (grep first — do not invent a location).

- [ ] **Step 1: Update field docs if a builtin-field list exists**

`grep -rn 'valid_until\|ttl_days' docs/` to find where builtin fields are documented; add a one-line `criticality` entry mirroring `tier`. If no such list exists, skip (do not create new docs — YAGNI).

- [ ] **Step 2: Live smoke on a real vault**

Build and run the card against a vault that has a tension where one side's doc carries `criticality: high`:

```bash
npx tsc --noEmit && node dist/cli.js court --triage --vault <path-to-a-vault-with-tensions>
```

Expected: the card shows `crit high` on the high-criticality side and `crit —` on unstated sides.

- [ ] **Step 3: Final full suite + commit**

```bash
npx vitest run
git add -A
git commit -m "docs(frontmatter): document criticality field"
```

---

## Definition of done

- `criticality: low|medium|high` is an optional builtin frontmatter field; absent ⇒ null; malformed ⇒ flagged (mirrors `tier`).
- No migration; existing docs read as `criticality: null`.
- `daftari court --triage` and `vault_tension_triage` show per-side criticality (`crit <level>` / `crit —`).
- No ranking, no scoring, no write enforcement, no auto-resolution introduced (thesis-safety: legibility only).
- `tsc` clean; full vitest suite green.
- Nothing pushed/PR'd — awaiting Mihir's disclosure/merge call.
