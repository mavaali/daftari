# Edge staleness `unverifiable` class Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `unverifiable` edge-staleness class so a dependent of a deleted (or caller-unreadable) upstream stops reporting as maximally-fresh `current` on `vault_read`, `vault_search`, and `vault_staleness`.

**Architecture:** `classifyEdge` gains an injected, caller-relative verifiability predicate (`isVerifiable(unit)`), evaluated **before** the `writes === 0` short-circuit: a unit not in the caller's visible doc set classifies `unverifiable`, never `current`. The predicate is built at the three tool surfaces from the open index handle + access context (`sourceVerifiable` = exists-in-index AND collection-readable). Disclosure stays split by the existing `splitUpstreamVisibility`: a readable-but-deleted unit surfaces as a named `unverifiable` row; an unreadable unit (hidden or deleted, indistinguishable — no existence oracle) folds into the coarse hidden bucket. No persisted state — deletion is computed, never remembered (gap report §7 I0).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, biome. Source: `src/curation/edge-staleness.ts`, `src/curation/tension-access.ts`, `src/tools/{read,search,edge-staleness}.ts`, `src/search/hybrid.ts`. Tests: `test/**` mirroring source.

**Spec:** daftari GH #416 (I1 in `docs/2026-08-17-derived-content-lifecycle-gap-report.md`). Bead `mavaali-beads-43a.1`.

---

## Design decisions (locked)

- **DD1 — predicate is caller-relative "in visible doc set", not pure existence.** `isVerifiable(unit) = has-index-handle AND getDocument(unit) != null AND (no-access OR sourceReadable(unit))`. A hidden-but-alive unit is `unverifiable` to a narrow role and `current`/normal to an operator — the accepted cost in the issue ("an operator with full read sees `current` where a narrow role sees `unverifiable`").
- **DD2 — no db handle ⇒ never `unverifiable`.** When the index is unavailable (`db === null`), the predicate returns `true` (verifiable). Telemetry is advisory; we do not cry wolf on an uninstrumented/unopenable vault. This also keeps every existing test that runs without an index untouched.
- **DD3 — predicate is optional on the curation functions.** `classifyEdge`/`compiledUpstreamStaleness`/`upstreamStaleness` take `isVerifiable?`. When omitted, the `unverifiable` branch is skipped entirely — existing pure-unit callers are byte-identical. This satisfies acceptance "existing `pending-*` behavior unchanged."
- **DD4 — reason string never says "deleted".** Always `"source not in your readable vault"` — the same string for hidden, worktree-deleted, and history-erased (`tier0.ts:81-85` house rule; no existence oracle).
- **DD5 — disclosure is unchanged plumbing, with one documented behavior change.** `splitUpstreamVisibility` already routes readable→visible, unreadable→coarse bucket. `unverifiable` is not `current`, so unreadable unverifiable rows are counted in the hidden bucket (previously a deleted unit classified `current` and was silently dropped by the `r.staleness !== "current"` guard at `:314` — the exact inversion being fixed). No structural change to the split. **Behavior change (intended, DD1):** a narrow role whose only upstream is a *hidden-but-alive-and-unchanged* unit previously got `hidden_pending: none` (that unit classified `current` and was dropped); it now classifies `unverifiable` and flips the read/staleness `hidden_pending` to `"some"`. This is honest (the narrow role genuinely cannot verify that upstream) and preserves no-oracle (hidden-alive, hidden-deleted, and hidden-changed all collapse to the same coarse bucket). Verified: no existing test asserts the old hidden-current-silent behavior — the RBAC test at `edge-staleness.test.ts:176` uses a *changed* upstream (stays `"some"`), and the unreadable-anchor test at `:228` returns `empty()` before any row computation.
- **DD6 — `unverifiable` precedes every other branch in `classifyEdge`.** If the caller cannot verify the unit exists/readable, no baseline or tier verdict is meaningful.

---

## File Structure

- `src/curation/edge-staleness.ts` — vocabulary (`EdgeStalenessClass`, `UpstreamStalenessSummary`), the `isVerifiable` short-circuit in `classifyEdge`, predicate threading through `compiledUpstreamStaleness`/`upstreamStaleness`, `summarizeUpstream`.
- `src/curation/tension-access.ts` — new `sourceVerifiable(db, access, unit)` predicate builder (co-located with `sourceReadable`, its RBAC sibling).
- `src/tools/read.ts` — build predicate, thread into `compiledUpstreamStaleness`, banner clause, `unverifiable` count on `UpstreamReadStaleness`.
- `src/tools/search.ts` — `unverifiableUpstream` coarse bucket on served hits + JSON schema.
- `src/search/hybrid.ts` — `unverifiableUpstream?` field on `HybridHit`.
- `src/tools/edge-staleness.ts` — `summary.unverifiable`, schema enum + property, open index unconditionally, thread predicate into `upstreamStaleness`.
- Tests mirror each source file.

---

## Task 1: Vocabulary — add the `unverifiable` class and its summary counter

**Files:**
- Modify: `src/curation/edge-staleness.ts:67-91` (union + summary interface), `:319-333` (`summarizeUpstream`)
- Test: `test/curation/edge-staleness-unit.test.ts` (create if absent; else append)

- [ ] **Step 1: Write the failing test**

Create/append `test/curation/edge-staleness-unit.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { summarizeUpstream, type UpstreamStaleness } from "../../src/curation/edge-staleness.js";

function row(staleness: UpstreamStaleness["staleness"]): UpstreamStaleness {
  return { unit: "u", edge_class: "compiled", staleness, baseline: null, changed_fields: [], reason: "" };
}

describe("summarizeUpstream — unverifiable", () => {
  it("counts unverifiable rows in their own bucket", () => {
    const s = summarizeUpstream([row("unverifiable"), row("unverifiable"), row("current")]);
    expect(s.unverifiable).toBe(2);
    expect(s.current).toBe(1);
    expect(s.pending_broken).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/curation/edge-staleness-unit.test.ts -t "unverifiable"`
Expected: FAIL — `"unverifiable"` not assignable to `staleness`, and `s.unverifiable` undefined.

- [ ] **Step 3: Implement**

In `src/curation/edge-staleness.ts` extend the union (`:67-71`):

```typescript
export type EdgeStalenessClass =
  | "current"
  | "pending-unchecked"
  | "pending-compatible"
  | "pending-broken"
  | "unverifiable";
```

Extend `UpstreamStalenessSummary` (`:86-91`) — add `unverifiable: number;`. Update the doc-comment on `UpstreamStaleness.staleness` neighbors is not needed.

Extend `summarizeUpstream` (`:319-333`):

```typescript
export function summarizeUpstream(rows: UpstreamStaleness[]): UpstreamStalenessSummary {
  const summary: UpstreamStalenessSummary = {
    current: 0,
    pending_unchecked: 0,
    pending_compatible: 0,
    pending_broken: 0,
    unverifiable: 0,
  };
  for (const r of rows) {
    if (r.staleness === "current") summary.current += 1;
    else if (r.staleness === "pending-unchecked") summary.pending_unchecked += 1;
    else if (r.staleness === "pending-compatible") summary.pending_compatible += 1;
    else if (r.staleness === "pending-broken") summary.pending_broken += 1;
    else summary.unverifiable += 1;
  }
  return summary;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/curation/edge-staleness-unit.test.ts -t "unverifiable"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/curation/edge-staleness.ts test/curation/edge-staleness-unit.test.ts
git commit -m "feat(#416): add unverifiable EdgeStalenessClass + summary counter"
```

---

## Task 2: `classifyEdge` — `unverifiable` short-circuit + predicate threading

**Files:**
- Modify: `src/curation/edge-staleness.ts:115-197` (`classifyEdge`), `:227-244` (`compiledUpstreamStaleness`), `:249-298` (`upstreamStaleness`)
- Test: `test/curation/edge-staleness-unit.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
import { compiledUpstreamStaleness } from "../../src/curation/edge-staleness.js";
import type { ConsumesEdge } from "../../src/curation/consumes.js";

function consumesEdge(unit: string, compile_ts: string): ConsumesEdge {
  return {
    artifact: "art.md",
    unit,
    edge_type: "whole-doc-read",
    fields: ["*"],
    run_id: "run-1",
    compile_ts,
  };
}

describe("classifyEdge — unverifiable predicate", () => {
  const consumes = [consumesEdge("gone.md", "2026-07-01T00:00:00Z")];

  it("marks an unverifiable unit unverifiable even with zero writes (pre-empts current)", () => {
    const rows = compiledUpstreamStaleness("art.md", consumes, [], () => false);
    expect(rows[0]?.staleness).toBe("unverifiable");
    expect(rows[0]?.reason).toBe("source not in your readable vault");
    expect(rows[0]?.reason).not.toContain("deleted");
  });

  it("without a predicate, an unchanged unit is still current (unchanged behavior)", () => {
    const rows = compiledUpstreamStaleness("art.md", consumes, []);
    expect(rows[0]?.staleness).toBe("current");
  });

  it("a verifiable unit classifies normally", () => {
    const rows = compiledUpstreamStaleness("art.md", consumes, [], () => true);
    expect(rows[0]?.staleness).toBe("current");
  });
});
```

(`ConsumesEdge` verified against `src/curation/consumes.ts:40-47`: required fields are `artifact, unit, edge_type, fields, run_id, compile_ts`; `edge_type` is the single-member union `"whole-doc-read"`. The literal above is complete — no cast needed.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/curation/edge-staleness-unit.test.ts -t "unverifiable predicate"`
Expected: FAIL — `compiledUpstreamStaleness` takes 3 args; 4th rejected; rows classify `current`.

- [ ] **Step 3: Implement**

`classifyEdge` input type (`:115-123`) — add `isVerifiable?: (unit: string) => boolean;`. Insert the guard **immediately after the `const base = {...}` declaration (ends at `:128`)** and before the `tier2Resolved`/`input.baseline === null` logic. It must come after `base` because it spreads `...base`; it must come before every other branch (DD6):

```typescript
  if (input.isVerifiable && !input.isVerifiable(input.unit)) {
    return {
      ...base,
      staleness: "unverifiable",
      changed_fields: [],
      reason: "source not in your readable vault",
    };
  }
```

`compiledUpstreamStaleness` (`:227-244`) — add trailing param and forward it:

```typescript
export function compiledUpstreamStaleness(
  artifact: string,
  consumes: ConsumesEdge[],
  provenance: ProvenanceEntry[],
  isVerifiable?: (unit: string) => boolean,
): UpstreamStaleness[] {
  return forwardConsumes(consumes, artifact)
    .filter((e) => e.unit !== artifact)
    .map((e) =>
      classifyEdge({
        artifact,
        unit: e.unit,
        edgeClass: "compiled",
        baseline: e.compile_ts,
        provenance,
        compiledEdge: e,
        isVerifiable,
      }),
    );
}
```

`upstreamStaleness` (`:249-298`) — add `isVerifiable?: (unit: string) => boolean;` to the input object, forward it into the `compiledUpstreamStaleness(...)` call and into both `classifyEdge` calls (declared + earned loops).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/curation/edge-staleness-unit.test.ts`
Expected: PASS (all Task 1 + Task 2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/curation/edge-staleness.ts test/curation/edge-staleness-unit.test.ts
git commit -m "feat(#416): classifyEdge short-circuits unreadable units to unverifiable"
```

---

## Task 3: `sourceVerifiable` predicate builder

**Files:**
- Modify: `src/curation/tension-access.ts` (add export; import `getDocument`)
- Test: `test/curation/tension-access.test.ts` (create/append)

- [ ] **Step 1: Write the failing test**

The predicate needs a real index. Reuse the temp-vault + write pattern.

```typescript
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sourceVerifiable } from "../../src/curation/tension-access.js";
import { openIndexForAccessOrNull } from "../../src/tools/search.js";
import { deleteDocument } from "../../src/storage/index-db.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:compiler";
const fm = (o = {}) => ({
  title: "T", domain: "accumulation", collection: "pricing", status: "draft",
  confidence: "medium", created: "2026-07-01", provenance: "direct",
  sources: [], superseded_by: null, ttl_days: null, tags: [], ...o,
});

describe("sourceVerifiable", () => {
  let vault: string;
  beforeEach(() => { vault = makeTempVault(); });
  afterEach(() => cleanupVault(vault));

  it("null db ⇒ verifiable (cannot tell, do not cry wolf)", () => {
    expect(sourceVerifiable(null, undefined, "pricing/x.md")).toBe(true);
  });

  it("present + readable ⇒ verifiable; evicted ⇒ not", async () => {
    const w = await vaultWrite(vault, { path: "pricing/x.md", body: "# X\n", frontmatter: fm(), agent: AGENT });
    if (!w.ok) throw w.error;
    const db = openIndexForAccessOrNull(vault);
    try {
      expect(sourceVerifiable(db, undefined, "pricing/x.md")).toBe(true);
      deleteDocument(db!, "pricing/x.md");
      expect(sourceVerifiable(db, undefined, "pricing/x.md")).toBe(false);
    } finally { db?.close(); }
  }, 60_000);

  it("present but unreadable collection ⇒ not verifiable", async () => {
    const w = await vaultWrite(vault, { path: "competitive-intel/s.md", body: "# S\n", frontmatter: fm({ collection: "competitive-intel" }), agent: AGENT });
    if (!w.ok) throw w.error;
    const db = openIndexForAccessOrNull(vault);
    try {
      const pricingOnly = { user: "human:n", roleName: "pricing-only", role: { read: ["pricing"], write: [], promote: false, ratify: false } };
      expect(sourceVerifiable(db, pricingOnly, "competitive-intel/s.md")).toBe(false);
    } finally { db?.close(); }
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/curation/tension-access.test.ts -t sourceVerifiable`
Expected: FAIL — `sourceVerifiable` not exported.

- [ ] **Step 3: Implement**

In `src/curation/tension-access.ts`, add `getDocument` to the `index-db.js` import, then export:

```typescript
// True iff the caller can VERIFY this unit: it exists in the index AND (when
// RBAC is configured) the caller may read its collection. A null db means the
// index is unavailable — we cannot tell, so we report verifiable (advisory
// telemetry never cries wolf). The predicate is deliberately caller-relative:
// a hidden-but-alive unit is unverifiable to a narrow role and verifiable to
// an operator — the accepted #217 cost, and the reason a hidden unit is
// indistinguishable from a deleted one (no existence oracle).
export function sourceVerifiable(
  db: IndexDb | null,
  access: AccessContext | undefined,
  unit: string,
): boolean {
  if (!db) return true;
  if (access && !sourceReadable(db, access, unit)) return false;
  const canonical = canonicalRel(unit);
  if (canonical.length === 0 || canonical.startsWith("..")) return false;
  return getDocument(db, canonical) != null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/curation/tension-access.test.ts -t sourceVerifiable`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/curation/tension-access.ts test/curation/tension-access.test.ts
git commit -m "feat(#416): sourceVerifiable predicate (exists-in-index AND readable)"
```

---

## Task 4: `vault_read` surface — banner clause + `unverifiable` count

**Files:**
- Modify: `src/tools/read.ts:111-118` (`UpstreamReadStaleness`), `:351-388` (predicate + banner)
- Test: `test/tools/edge-staleness.test.ts` (append; deletion + RBAC-parity)

- [ ] **Step 1: Write the failing test**

Append to `test/tools/edge-staleness.test.ts`:

```typescript
import { deleteDocument } from "../../src/storage/index-db.js";
import { openIndexForAccessOrNull } from "../../src/tools/search.js";

it("a dependent of a deleted upstream reports unverifiable, not current", async () => {
  await seedNeighborhood(vault);
  // Evict the compiled upstream from the index (simulates out-of-band deletion).
  const db = openIndexForAccessOrNull(vault);
  try { deleteDocument(db!, "pricing/metric.md"); } finally { db?.close(); }

  const read = await vaultRead(vault, "pricing/artifact.md");
  if (!read.ok) throw read.error;
  const edges = read.value.upstream_staleness?.edges ?? [];
  expect(edges.some((e) => e.staleness === "unverifiable")).toBe(true);
  expect(edges.every((e) => e.staleness !== "current")).toBe(true);
  expect(read.value.upstream_staleness?.unverifiable).toBe(1);
  expect(read.value.upstream_staleness?.banner).toContain("can no longer be verified");
  expect(read.value.upstream_staleness?.banner).not.toContain("deleted");
}, 60_000);

it("RBAC-hidden upstream is indistinguishable from a deleted one (coarse bucket, no leak)", async () => {
  await seedNeighborhood(vault);
  const secret = await vaultWrite(vault, {
    path: "competitive-intel/secret2.md", body: "# S\n",
    frontmatter: frontmatter({ title: "S", collection: "competitive-intel" }), agent: AGENT,
  });
  if (!secret.ok) throw secret.error;
  await vaultRead(vault, "competitive-intel/secret2.md", undefined, "run-9");
  const consumer = await vaultWrite(vault, {
    path: "pricing/consumer9.md", body: "# C\n",
    frontmatter: frontmatter({ title: "C", provenance: "synthesized" }), agent: AGENT, run_id: "run-9",
  });
  if (!consumer.ok) throw consumer.error;

  const pricingOnly = { user: "human:n", roleName: "pricing-only", role: { read: ["pricing"], write: [], promote: false, ratify: false } };
  const gated = await vaultRead(vault, "pricing/consumer9.md", pricingOnly);
  if (!gated.ok) throw gated.error;
  // Hidden upstream never becomes a named row and never an exact count.
  expect(gated.value.upstream_staleness?.edges).toEqual([]);
  expect(gated.value.upstream_staleness?.hidden_pending).toBe("some");
  expect(gated.value.upstream_staleness?.unverifiable ?? 0).toBe(0);
}, 60_000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools/edge-staleness.test.ts -t "deleted upstream"`
Expected: FAIL — edge classifies `current`; `unverifiable` field missing; banner lacks the clause.

- [ ] **Step 3: Implement**

`UpstreamReadStaleness` (`:111-118`) — add:

```typescript
  // Count of VISIBLE upstream edges whose unit the caller can no longer
  // verify (deleted, or — for a readable collection — evicted). Unreadable
  // units never enter this count; they fold into hidden_pending (#217).
  unverifiable: number;
```

**Ordering note (load-bearing):** `read.ts` computes `rows` at **:326-328** — but `db` is not opened until **:351**, and the `rows` at :326 also feed the role-unfiltered `broken_upstream` telemetry at :344. Do **not** touch the :326 computation (marking a deleted unit `unverifiable` does not change its `pending-broken` telemetry count, but leaving telemetry untouched keeps the diff honest). Instead, **recompute a display row set with the predicate inside the enrichment `try` block** (where `db` is in scope at :351 and `staleCtx` is in scope from :325). Import `sourceVerifiable` from `../curation/tension-access.js` (join the existing :22 import that already pulls `sourceReadable`), then replace the split/banner block (:360-388):

The full replacement for the enrichment block (:360-388) — recomputes rows with the predicate, splits, and builds a clause-based banner that keeps the existing substrings `"changed incompatibly"` and `"outside your read scope"`:

```typescript
    if (rows && rows.length > 0) {
      const isVerifiable = (unit: string) => sourceVerifiable(db, access, unit);
      const verifiedRows = staleCtx
        ? compiledUpstreamStaleness(
            resolved.value.relPath,
            staleCtx.consumes,
            staleCtx.provenance,
            isVerifiable,
          )
        : rows;
      const {
        visible,
        hiddenPending,
      }: { visible: UpstreamStaleness[]; hiddenPending: HiddenDownstream } = access
        ? splitUpstreamVisibility(verifiedRows, (unit) => sourceReadable(db, access, unit))
        : { visible: verifiedRows, hiddenPending: "none" };
      if (visible.length > 0 || hiddenPending !== "none") {
        const pendingBroken = visible.filter((r) => r.staleness === "pending-broken").length;
        const unverifiable = visible.filter((r) => r.staleness === "unverifiable").length;
        const clauses: string[] = [];
        if (pendingBroken > 0) {
          clauses.push(
            `${pendingBroken} compiled upstream input${pendingBroken === 1 ? " has" : "s have"} ` +
              `changed incompatibly since this document was compiled — this content may predate them`,
          );
        }
        if (unverifiable > 0) {
          clauses.push(
            `${unverifiable} upstream input${unverifiable === 1 ? "" : "s"} can no longer be ` +
              `verified (source not in your readable vault)`,
          );
        }
        if (hiddenPending !== "none") {
          clauses.push(`${hiddenPending} upstream inputs outside your read scope have pending changes`);
        }
        upstream = {
          edges: visible,
          hidden_pending: hiddenPending,
          pending_broken: pendingBroken,
          unverifiable,
          banner: clauses.length > 0 ? `${clauses.join("; ")}.` : null,
        };
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tools/edge-staleness.test.ts`
Expected: PASS — new deletion + RBAC-parity tests plus every pre-existing test (line 144 `"changed incompatibly"` and line 225 `"outside your read scope"` substrings preserved).

- [ ] **Step 5: Commit**

```bash
git add src/tools/read.ts test/tools/edge-staleness.test.ts
git commit -m "feat(#416): vault_read surfaces unverifiable upstream in banner + count"
```

---

## Task 5: `vault_search` surface — `unverifiableUpstream` coarse bucket

**Files:**
- Modify: `src/search/hybrid.ts:89-92` (`HybridHit` — add beside `demoted`, before the closing brace), `src/tools/search.ts:196-237` (`annotateAndLogServedHits`), `:1119-1130` (hit schema)
- Test: `test/tools/search.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Locate `test/tools/search.test.ts`'s existing staleness-annotation test for the pattern (query that returns a dependent hit). Append a test that: seeds a compiled dependent, evicts the upstream via `deleteDocument`, searches for the dependent, and asserts the hit carries `unverifiableUpstream` set (`"some"`), while `pendingBrokenUpstream` is unset. (Mirror the existing annotation test's vault setup + search invocation; do not invent a new harness.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools/search.test.ts -t unverifiable`
Expected: FAIL — field absent.

- [ ] **Step 3: Implement**

`src/search/hybrid.ts` `HybridHit` — add alongside `hiddenPendingUpstream`:

```typescript
  // Coarse bucket of VISIBLE upstream inputs the caller can no longer verify
  // (deleted, or evicted from a readable collection). Never an exact count.
  unverifiableUpstream?: "some" | "many";
```

`annotateAndLogServedHits` (`:209-227`) — build the predicate and thread it, then bucket the visible unverifiable rows. **Telemetry-isolation (same as Task 4):** the `broken_upstream` read-log count must stay role- AND existence-unfiltered (an operator incident metric that cannot vary by who read the doc), so compute it from a SEPARATE bare `compiledUpstreamStaleness` call (no predicate); use the predicate-enriched `rows` only for the caller-facing display buckets:

```typescript
    const bareRows = compiledUpstreamStaleness(hit.path, staleCtx.consumes, staleCtx.provenance);
    broken = bareRows.filter((r) => r.staleness === "pending-broken").length;
    const isVerifiable = (unit: string) => sourceVerifiable(db, access, unit);
    const rows = compiledUpstreamStaleness(hit.path, staleCtx.consumes, staleCtx.provenance, isVerifiable);
  // ... after computing visible/hiddenPending:
    const visibleUnverifiable = visible.filter((r) => r.staleness === "unverifiable").length;
    const unverifiableBucket = bucketHiddenDownstream(visibleUnverifiable);
    if (unverifiableBucket !== "none") hit.unverifiableUpstream = unverifiableBucket;
```

Import `sourceVerifiable` from `../curation/tension-access.js` (existing import in this file already pulls `sourceReadable`). Add `unverifiableUpstream` to the hit JSON schema (`:1119-1130`), mirroring the `pendingBrokenUpstream` enum `["some","many"]` with a description referencing #217/#416.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tools/search.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/search/hybrid.ts src/tools/search.ts test/tools/search.test.ts
git commit -m "feat(#416): vault_search hits carry unverifiableUpstream bucket"
```

---

## Task 6: `vault_staleness` surface — summary counter + operator-visible deletions

**Files:**
- Modify: `src/tools/edge-staleness.ts:98-152` (`artifactReport`: open db unconditionally, thread predicate), the `staleness` enum on `upstreamStalenessSchema` (`:239`, currently `["current","pending-unchecked","pending-compatible","pending-broken"]`), and the artifact `summary` schema `properties` + `required` (`:285-291`)
- Test: `test/tools/edge-staleness.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append:

```typescript
it("vault_staleness reports a deleted upstream as unverifiable in edges + summary", async () => {
  await seedNeighborhood(vault);
  const db = openIndexForAccessOrNull(vault);
  try { deleteDocument(db!, "pricing/metric.md"); } finally { db?.close(); }

  const res = await vaultStaleness(vault, { artifact: "pricing/artifact.md" });
  if (!res.ok) throw res.error;
  if (res.value.mode !== "artifact") throw new Error("expected artifact mode");
  expect(res.value.edges[0]?.staleness).toBe("unverifiable");
  expect(res.value.edges[0]?.reason).toBe("source not in your readable vault");
  expect(res.value.summary.unverifiable).toBe(1);
  expect(res.value.summary.current).toBe(0);
}, 60_000);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/tools/edge-staleness.test.ts -t "vault_staleness reports a deleted"`
Expected: FAIL — edge classifies `current` (db was null on the no-access path); `summary.unverifiable` absent.

- [ ] **Step 3: Implement**

In `artifactReport` (`:95`), open the index **unconditionally** so operator (no-access) deletions are detected:

```typescript
  const db = openIndexForAccessOrNull(vaultRoot);
```

(The `access && !sourceReadable` anchor guard and the `access ? split : {visible: rows}` disclosure branch stay exactly as-is — opening the handle changes only existence-checking, not RBAC disclosure.)

Build the predicate and thread it into `upstreamStaleness`:

```typescript
    const rows = upstreamStaleness({
      artifact: artifact.value,
      consumes: consumes.value,
      provenance: provenance.value,
      declaredUnits,
      earned,
      verdicts: verdicts.value,
      isVerifiable: (unit) => sourceVerifiable(db, access, unit),
    });
```

Import `sourceVerifiable` from `../curation/tension-access.js` (existing import already pulls `sourceReadable`).

Schema updates: add `"unverifiable"` to the `staleness` enum on `upstreamStalenessSchema` (`:239`); add `unverifiable: { type: "integer" }` to the artifact `summary` `properties` and its `required` list (`:285-291`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tools/edge-staleness.test.ts`
Expected: PASS (including the pre-existing `"an unreadable anchor reports exactly like a nonexistent one"` — the anchor guard is untouched, and opening the handle does not change the empty-report equivalence because an unreadable anchor still returns `empty()` before any row computation).

- [ ] **Step 5: Commit**

```bash
git add src/tools/edge-staleness.ts test/tools/edge-staleness.test.ts
git commit -m "feat(#416): vault_staleness summary counts unverifiable; detect operator-side deletions"
```

---

## Task 7: Docs + full verification

**Files:**
- Modify: `CHANGELOG.md` (top entry), any `docs/` reference describing edge-staleness classes (grep `pending-broken` under `docs/`)

- [ ] **Step 1: Update CHANGELOG + docs**

Add a CHANGELOG entry under the current unreleased section:

```
- Edge staleness: new `unverifiable` class (#416). A dependent whose compiled/declared/earned upstream the caller can no longer verify (deleted, or evicted from a readable collection) reports `unverifiable` on `vault_read`, `vault_search`, and `vault_staleness` instead of the previous false `current`. RBAC-hidden upstreams are indistinguishable from deleted ones (no existence oracle); reason string is always "source not in your readable vault". No persisted state — deletion is computed, never remembered.
```

Grep `docs/` for any enum list of the four staleness classes and add `unverifiable` with a one-line gloss. Do not touch the gap report (it is the spec).

- [ ] **Step 2: Full static + targeted test verification**

Run each and confirm clean:

```bash
npx tsc --noEmit
npx biome check src/ test/
npx vitest run test/curation/edge-staleness-unit.test.ts test/curation/tension-access.test.ts test/tools/edge-staleness.test.ts test/tools/search.test.ts
```

Expected: `tsc` no output; biome clean (run `npx biome check --write` only if it reports auto-fixable formatting, then re-run check); all listed vitest files green.

- [ ] **Step 3: Broader regression sweep for the touched modules**

```bash
npx vitest run test/tools/ test/curation/ test/search/
```

Expected: green. Investigate any failure as a real regression before proceeding (per daftari worktree note, ignore only the known separate-workspace `failed files` under `integrations/**`, `packages/**`, and load-sensitive spawn e2e — none of which this change touches).

- [ ] **Step 4: Commit docs**

```bash
git add CHANGELOG.md docs/
git commit -m "docs(#416): changelog + staleness-class docs for unverifiable"
```

---

## Acceptance trace (spec #416 → tasks)

- A dependent of a deleted unit reports `unverifiable` on read/search/staleness → Task 4 test, Task 5 test, Task 6 test.
- RBAC-hidden units report identically to deleted ones (no existence oracle) → Task 4 RBAC-parity test (coarse bucket, no named row, no exact count); DD1/DD4.
- Existing `pending-*` behavior unchanged → DD3 (predicate optional; `unverifiable` branch skipped when absent); Task 2 "without a predicate" test; full pre-existing `edge-staleness.test.ts` suite still green.
- Tests alongside `test/tools/edge-staleness.test.ts` → Tasks 4 & 6 append there; core logic in `test/curation/edge-staleness-unit.test.ts`.

## Out of scope (adjacent gap-report items, NOT this bead)

- I2/#423 receipt+runId (next bead), I5/#419 erase advisory (next bead), I0 no-tombstone decision record (already documented in the gap report), I6 uninstrumented-vs-fresh, I7 wake queue, I8 `distill:*` born-unverifiable labelling. Do not expand into these.
