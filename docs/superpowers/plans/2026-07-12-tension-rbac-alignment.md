# Tension-Tool RBAC Alignment Implementation Plan (#212)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One visibility rule — caller reads BOTH sides' collections — governs tension entries across the read tools (`vault_tension_clusters`/`vault_tension_blast`, filtered before aggregation) and the write tools (`vault_tension_log`/`vault_tension_resolve` denials), matching the #211 contested-annotation gate.

**Architecture:** Extract the collection-resolution rule into `collectionForPath` (`src/storage/index-db.ts`, null-db tolerant); new `src/curation/tension-access.ts` holds the both-sides predicate; curation modules gain an optional injected `entryFilter` so they never import RBAC; the four tool handlers in `src/tools/curation.ts` open the index read-only (`openIndexForActiveProvider` ONLY — never `ensureIndexReady`) and inject the filter/gates.

**Tech Stack:** TypeScript, vitest, better-sqlite3 (read-only use), biome.

**Spec (the contract — read first):** `docs/superpowers/specs/2026-07-12-tension-rbac-alignment-design.md`. Non-negotiables: denials name caller-supplied PATHS never resolved collections; resolve-invisible returns the exact `tension not found: <id>` string; visibility check ordered BEFORE the loop-authored ratify check; blast's explicit-doc collection gate runs BEFORE the existence check (a denial must be a pure function of caller input); no-RBAC mode (`access` undefined) bit-for-bit unchanged; index open failure ⇒ `db: null` ⇒ first-segment gating, never a failed call.

**Working directory:** `/Users/mihirwagle/projects/daftari/.claude/worktrees/tension-rbac` (branch `mihir/tension-rbac-alignment`). Never `git checkout`; `git add` named files only.

**Project rules:** no classes; handlers return `Result`, never throw; tests mirror `src/`.

**Merge note:** PR #214 (contested-hardening) touches `buildByPath` in `contested.ts`. If it merges before this branch, rebase on main; conflicts, if any, are line-adjacent and trivial (this plan touches `canonicalRel`'s `export` keyword and removes `counterpartCollection`; #214 touches the `add(b, ...)` call).

---

### Task 1: `collectionForPath` in index-db, consumed by contested.ts

**Files:**
- Modify: `src/storage/index-db.ts` (add export, near `getDocument` ~line 695)
- Modify: `src/search/contested.ts` (delete `counterpartCollection` ~lines 125-133; export `canonicalRel` ~line 54; use the new import)
- Test: `test/storage/index-db.test.ts` (append describe)

- [ ] **Step 1: Write the failing tests**

Append to `test/storage/index-db.test.ts` inside the top-level describe (match the file's existing setup — it opens a temp `IndexDb` and inserts documents; reuse its helpers for inserting a doc with a known `collection`):

```ts
  describe("collectionForPath", () => {
    it("returns the indexed row's collection when present", () => {
      // Insert (via the file's existing insert helper) a doc at
      // "pricing/indexed.md" whose frontmatter collection is "declared-elsewhere".
      // Then:
      expect(collectionForPath(db, "pricing/indexed.md")).toBe("declared-elsewhere");
    });

    it("falls back to the first path segment for unindexed paths", () => {
      expect(collectionForPath(db, "pricing/never-indexed.md")).toBe("pricing");
    });

    it("errs closed on escaping or empty paths", () => {
      expect(collectionForPath(db, "../escape.md")).toBe("..");
      expect(collectionForPath(db, "")).toBe("");
    });

    it("uses the pure segment rule when db is null", () => {
      expect(collectionForPath(null, "pricing/whatever.md")).toBe("pricing");
    });
  });
```

Adapt the insert to the file's real helper (read the existing tests in that file first — they show how documents are inserted with an explicit collection). Import `collectionForPath` in the file's existing import from `../../src/storage/index-db.js`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/storage/index-db.test.ts`
Expected: FAIL — `collectionForPath` is not exported.

- [ ] **Step 3: Implement**

In `src/storage/index-db.ts`, directly after `getDocument`:

```ts
// The collection that RBAC-gates access to `path`: the indexed row when
// present; the path's first segment otherwise (the S1/#192 rule — key on
// where the bytes live, never on a caller-declared string). `db` null means
// the index is unavailable: gating degrades to the pure segment rule.
// Either fallback errs closed — a `..`-leading or empty segment matches no
// role's read list.
export function collectionForPath(db: IndexDb | null, path: string): string {
  if (db !== null) {
    const doc = getDocument(db, path);
    if (doc) return doc.collection;
  }
  return path.split("/")[0] ?? "";
}
```

In `src/search/contested.ts`:
- Add `collectionForPath` to the existing `../storage/index-db.js` import (keep `getDocument` only if still used elsewhere; it won't be — remove it).
- Change `function canonicalRel` to `export function canonicalRel` (comment unchanged).
- Delete the `counterpartCollection` function and its comment block entirely.
- In `contestedFor`, replace `counterpartCollection(db, r.counterpart)` with `collectionForPath(db, r.counterpart)`.

- [ ] **Step 4: Verify green + regression**

Run: `npx vitest run test/storage/index-db.test.ts test/search/contested.test.ts test/tools/search.test.ts`
Expected: all pass (the contested/search files pin that the extraction is behavior-neutral).

- [ ] **Step 5: Commit**

```bash
git add src/storage/index-db.ts src/search/contested.ts test/storage/index-db.test.ts
git commit -m "refactor(storage): extract collectionForPath — the shared RBAC collection rule

Null-db tolerant (segment rule) so callers without an index handle gate
fail-closed instead of failing the call. contested.ts consumes it
unchanged; canonicalRel exported for the tension-access module.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `tension-access.ts` — the both-sides predicate

**Files:**
- Create: `src/curation/tension-access.ts`
- Test: `test/curation/tension-access.test.ts`

- [ ] **Step 1: Write the failing tests** (alias case FIRST, per the #127/#128 precedent)

Create `test/curation/tension-access.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { canSeeTension, visibleTensions } from "../../src/curation/tension-access.js";
import type { TensionEntry } from "../../src/curation/tension.js";

// Pure segment-rule tests: db null throughout. The indexed-row branch of
// collectionForPath is pinned in test/storage/index-db.test.ts; e2e coverage
// of handlers passing a real db lives in test/tools/curation.test.ts.
const role = (read: string[]): AccessContext => ({
  user: "t",
  roleName: "r",
  role: { read, write: [], promote: false, ratify: false },
});

const entry = (sourceA: string, sourceB: string): TensionEntry => ({
  date: "2026-07-12",
  title: "t",
  kind: "factual",
  sourceA,
  claimA: "a",
  sourceB,
  claimB: "b",
  status: "unresolved",
  loggedBy: "test",
  resolved: false,
});

describe("tension-access", () => {
  it("an alias path never widens visibility", () => {
    // secret/../pricing/x.md canonicalizes to pricing/x.md (readable), but
    // pricing/../secret/x.md canonicalizes to secret/x.md (not readable).
    const r = role(["pricing", "intel"]);
    expect(canSeeTension(null, r, "secret/../pricing/a.md", "intel/b.md")).toBe(true);
    expect(canSeeTension(null, r, "pricing/../secret/a.md", "intel/b.md")).toBe(false);
  });

  it("requires read on BOTH sides, in either direction", () => {
    const pricingOnly = role(["pricing"]);
    expect(canSeeTension(null, pricingOnly, "pricing/a.md", "intel/b.md")).toBe(false);
    expect(canSeeTension(null, pricingOnly, "intel/b.md", "pricing/a.md")).toBe(false);
    expect(canSeeTension(null, role(["pricing", "intel"]), "pricing/a.md", "intel/b.md")).toBe(true);
    expect(canSeeTension(null, pricingOnly, "pricing/a.md", "pricing/b.md")).toBe(true);
  });

  it("errs closed on escaping or blank sides for every role", () => {
    const wildcardless = role(["pricing", "..", ""]); // even a weird config cannot match
    expect(canSeeTension(null, wildcardless, "../escape.md", "pricing/a.md")).toBe(false);
    expect(canSeeTension(null, wildcardless, "", "pricing/a.md")).toBe(false);
  });

  it("access undefined means everything is visible", () => {
    expect(canSeeTension(null, undefined, "secret/a.md", "hidden/b.md")).toBe(true);
  });

  it("visibleTensions drops only invisible entries and preserves order", () => {
    const entries = [
      entry("pricing/a.md", "pricing/b.md"),
      entry("pricing/a.md", "secret/x.md"),
      entry("intel/c.md", "pricing/d.md"),
    ];
    const out = visibleTensions(null, entries, role(["pricing", "intel"]));
    expect(out).toEqual([entries[0], entries[2]]);
    expect(visibleTensions(null, entries, undefined)).toEqual(entries);
  });
});
```

Note on the errs-closed test: `canonicalRel("../escape.md")` yields a `..`-leading path whose first segment is `".."`; `permits` matches only `*` or exact strings, and a literal `".."`/`""` in a read list is nonsense config — but the test deliberately includes them to pin that BLANK canonical sides are invisible regardless (the guard is on the canonical emptiness/escape, not on config luck). If implementation makes `".."` match a literal `".."` read entry, that is acceptable for the escape case (config explicitly lists it) — then drop `".."` from the role in this test and assert only the blank-side case. Prefer the stricter guard below, which makes both pass as written.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/curation/tension-access.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/curation/tension-access.ts`:

```ts
// tension-access — the single visibility rule for tension entries (#212).
//
// A tension quotes claims from two documents; seeing either half crosses the
// ACL boundary of the other. Rule (matching the #211 contested-annotation
// gate): a caller may see an entry only with read access to BOTH sides'
// collections. Invisible entries are omitted entirely — never redacted — so
// neither existence nor authorship context leaks.
//
// This module holds policy only. Curation computations (clusters, blast)
// take the filter by injection so they never import RBAC or the index.

import { type AccessContext, canRead } from "../access/rbac.js";
import { canonicalRel } from "../search/contested.js";
import { collectionForPath, type IndexDb } from "../storage/index-db.js";
import type { TensionEntry } from "./tension.js";

// True iff the caller may see a tension between these two sources. Sides are
// canonicalized before resolution — an alias must not widen visibility. A
// side that canonicalizes to blank or escapes the root (`..`-leading) is
// visible to no role: such a path can never be a readable vault document.
// `access` undefined ⇒ RBAC unconfigured ⇒ visible, matching every other
// read surface. `db` null ⇒ index unavailable ⇒ pure first-segment rule
// (fail-closed; never fails the caller).
export function canSeeTension(
  db: IndexDb | null,
  access: AccessContext | undefined,
  sourceA: string,
  sourceB: string,
): boolean {
  if (!access) return true;
  return sideReadable(db, access, sourceA) && sideReadable(db, access, sourceB);
}

function sideReadable(db: IndexDb | null, access: AccessContext, source: string): boolean {
  const canonical = canonicalRel(source);
  if (canonical.length === 0 || canonical.startsWith("..")) return false;
  return canRead(access.role, collectionForPath(db, canonical));
}

// The subset of `entries` visible to the caller, original order preserved.
export function visibleTensions(
  db: IndexDb | null,
  entries: TensionEntry[],
  access?: AccessContext,
): TensionEntry[] {
  if (!access) return entries;
  return entries.filter((e) => canSeeTension(db, access, e.sourceA, e.sourceB));
}
```

- [ ] **Step 4: Verify green**

Run: `npx vitest run test/curation/tension-access.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/curation/tension-access.ts test/curation/tension-access.test.ts
git commit -m "feat(curation): tension-access — both-sides visibility predicate (#212)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `entryFilter` injection seam in clusters and blast

**Files:**
- Modify: `src/curation/tension-clusters.ts:174-181` (`loadTensionClusters`)
- Modify: `src/curation/tension-blast.ts:207-231` (`computeTensionBlast`)

Behavior-neutral plumbing (default identity); pinned by existing tests staying green plus Task 4's e2e.

- [ ] **Step 1: Implement**

`tension-clusters.ts` — extend the signature:

```ts
export async function loadTensionClusters(
  vaultRoot: string,
  now: Date = new Date(),
  // Visibility policy injected by the tool layer (#212) so this module never
  // imports RBAC. Identity when omitted — non-tool callers see everything.
  entryFilter: (entries: TensionEntry[]) => TensionEntry[] = (e) => e,
): Promise<Result<TensionClustersResult, Error>> {
  const tensions = await listTensions(vaultRoot);
  if (!tensions.ok) return err(tensions.error);
  return ok(computeTensionClusters(entryFilter(tensions.value), now));
}
```

`tension-blast.ts` — same param on `computeTensionBlast`, threaded to its internal call:

```ts
export async function computeTensionBlast(
  vaultRoot: string,
  input: TensionBlastInput,
  entryFilter: (entries: TensionEntry[]) => TensionEntry[] = (e) => e,
): Promise<Result<TensionBlastResult, Error>> {
```

and change the internal `const clustersResult = await loadTensionClusters(vaultRoot);` to
`const clustersResult = await loadTensionClusters(vaultRoot, new Date(), entryFilter);`.
(`TensionEntry` may need adding to the type imports from `./tension.js` in both files.)

- [ ] **Step 2: Regression + build**

Run: `npx vitest run test/curation/ && npm run build`
Expected: all existing curation tests pass; tsc clean.

- [ ] **Step 3: Commit**

```bash
git add src/curation/tension-clusters.ts src/curation/tension-blast.ts
git commit -m "refactor(curation): inject entryFilter into clusters/blast — policy stays at the tool layer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Read-tool handlers — clusters and blast filter before aggregating

**Files:**
- Modify: `src/tools/curation.ts` (`vaultTensionClusters` ~line 205, `vaultTensionBlast` ~line 224, imports)
- Test: `test/tools/curation.test.ts`

- [ ] **Step 1: Write the failing e2e tests**

`test/tools/curation.test.ts` uses fresh `mkdtempSync` vaults per test (`beforeEach`). Add a describe with its own fixture helper (two collections, three docs, docs written with `writeFileSync` + frontmatter, tensions via `addTension` — import `addTension` from `../../src/curation/tension.js`, and `AccessContext` type from `../../src/access/rbac.js`):

```ts
  describe("tension RBAC alignment (#212)", () => {
    const pricingOnly: AccessContext = {
      user: "t",
      roleName: "analyst",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };
    const both: AccessContext = {
      user: "t",
      roleName: "lead",
      role: { read: ["pricing", "intel"], write: [], promote: false, ratify: false },
    };

    async function seedCrossTension(v: string) {
      mkdirSync(join(v, "pricing"), { recursive: true });
      mkdirSync(join(v, "intel"), { recursive: true });
      writeFileSync(join(v, "pricing/a.md"), "---\ntitle: A\n---\nbody a");
      writeFileSync(join(v, "pricing/b.md"), "---\ntitle: B\n---\nbody b");
      writeFileSync(join(v, "intel/c.md"), "---\ntitle: C\n---\nbody c");
      const t1 = await addTension(v, {
        title: "in-pricing", kind: "factual",
        sourceA: "pricing/a.md", claimA: "x", sourceB: "pricing/b.md", claimB: "y",
        loggedBy: "test",
      });
      const t2 = await addTension(v, {
        title: "cross", kind: "factual",
        sourceA: "pricing/a.md", claimA: "x", sourceB: "intel/c.md", claimB: "z",
        loggedBy: "test",
      });
      if (!t1.ok || !t2.ok) throw new Error("seed failed");
      return { t1: t1.value, t2: t2.value };
    }

    it("clusters: hidden tensions are absent from members AND counts", async () => {
      await seedCrossTension(vault);
      const restricted = await vaultTensionClusters(vault, {}, pricingOnly);
      expect(restricted.ok).toBe(true);
      if (!restricted.ok) return;
      const docs = restricted.value.clusters.flatMap((c) => c.documents);
      expect(docs).not.toContain("intel/c.md");
      // Only the in-pricing tension remains: exactly one cluster of the pair.
      expect(restricted.value.clusters).toHaveLength(1);
      expect(restricted.value.clusters[0]?.documents.sort()).toEqual([
        "pricing/a.md", "pricing/b.md",
      ]);
      // Spec case 6's "absent from counts": the surviving cluster counts only
      // the visible tension. (Check the field name on TensionClustersResult —
      // tension_count or similar — and pin it.)
      expect(restricted.value.clusters[0]?.tension_count).toBe(1);

      const full = await vaultTensionClusters(vault, {}, both);
      expect(full.ok).toBe(true);
      if (!full.ok) return;
      expect(full.value.clusters.flatMap((c) => c.documents)).toContain("intel/c.md");
    });

    it("blast: unreadable explicit doc is denied by path, before existence", async () => {
      await seedCrossTension(vault);
      const denied = await vaultTensionBlast(vault, { document: "intel/c.md" }, pricingOnly);
      expect(denied.ok).toBe(false);
      if (denied.ok) return;
      expect(denied.error.message).toContain("access denied");
      expect(denied.error.message).toContain("intel/c.md");
      // Purely input-derived: a NONEXISTENT doc in an unreadable collection
      // gets the identical denial shape, not "not found".
      const ghost = await vaultTensionBlast(vault, { document: "intel/ghost.md" }, pricingOnly);
      expect(ghost.ok).toBe(false);
      if (ghost.ok) return;
      expect(ghost.error.message).toContain("access denied");
      expect(ghost.error.message).not.toContain("not found");
    });

    it("blast: hidden tensions do not seed cluster membership", async () => {
      await seedCrossTension(vault);
      const res = await vaultTensionBlast(vault, { document: "pricing/a.md" }, pricingOnly);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.cluster_documents).not.toContain("intel/c.md");
    });
  });
```

Add needed imports at the top of the test file (merge into existing import lines): `addTension` (from curation/tension.js), `AccessContext` type. `mkdirSync`, `writeFileSync`, `join` are already imported.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/tools/curation.test.ts -t "tension RBAC"`
Expected: FAIL — restricted clusters still contain `intel/c.md` (pre-change the two tensions share pricing/a.md, so the unfiltered graph is ONE merged 3-doc cluster; the not-toContain and documents-equality assertions are what go red); blast returns ok instead of denial.

- [ ] **Step 3: Implement the handler changes**

In `src/tools/curation.ts` add imports:

```ts
import { visibleTensions } from "../curation/tension-access.js";
import { canonicalRel } from "../search/contested.js";
import { collectionForPath, type IndexDb } from "../storage/index-db.js";
import { openIndexForActiveProvider } from "./search.js";
```

Add one shared helper near `requireReadAccess`:

```ts
// Read-only index handle for collection lookups. openIndexForActiveProvider
// ONLY — never ensureIndexReady, which reindexes on an empty index; these
// tools must never reindex. Open failure degrades to null: visibility then
// gates on the pure first-segment rule (fail-closed), and the tool call
// itself never fails for RBAC-lookup reasons.
function openIndexForAccessOrNull(vaultRoot: string): IndexDb | null {
  const opened = openIndexForActiveProvider(vaultRoot);
  return opened.ok ? opened.value : null;
}
```

`vaultTensionClusters` — replace the body's final line. Note the access-gated open: in no-RBAC mode these readOnlyHint tools must not create `.daftari/index.db` as a side effect — filtering is identity there anyway.

```ts
  const db = access ? openIndexForAccessOrNull(vaultRoot) : null;
  try {
    return await loadTensionClusters(vaultRoot, new Date(), (entries) =>
      visibleTensions(db, entries, access),
    );
  } finally {
    db?.close();
  }
```

`vaultTensionBlast` — after the existing arg coercion and BEFORE calling `computeTensionBlast`, gate the explicit doc (input-only, pre-existence):

```ts
  const db = access ? openIndexForAccessOrNull(vaultRoot) : null;
  try {
    if (document !== undefined && access) {
      const canonical = canonicalRel(document);
      const readable =
        canonical.length > 0 &&
        !canonical.startsWith("..") &&
        canRead(access.role, collectionForPath(db, canonical));
      if (!readable) {
        return err(
          new Error(
            `access denied: role '${access.roleName}' cannot blast from '${document}'`,
          ),
        );
      }
    }
    return await computeTensionBlast(vaultRoot, { document, cluster_id }, (entries) =>
      visibleTensions(db, entries, access),
    );
  } finally {
    db?.close();
  }
```

(`canRead` is already imported in this file. Keep the existing `document`/`cluster_id` coercion code untouched above this.)

- [ ] **Step 4: Verify green + no-RBAC regression**

Run: `npx vitest run test/tools/curation.test.ts test/curation/`
Expected: new tests pass; every pre-existing test (all run access-less) unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/tools/curation.ts test/tools/curation.test.ts
git commit -m "feat(rbac): tension clusters/blast filter to both-sides-visible entries (#212)

Aggregates are computed over the caller's view — sizes, membership, and
blast seeds reveal nothing about hidden tensions. Blast's explicit-doc
gate is input-only and runs before the existence check, so the denial
cannot become an existence oracle.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Write-tool handlers — log and resolve

**Files:**
- Modify: `src/tools/curation.ts` (`vaultTensionLog` ~line 59; `vaultTensionResolve` ratify block ~lines 170-181)
- Test: `test/tools/curation.test.ts` (same describe)

- [ ] **Step 1: Write the failing tests**

```ts
    it("log: denied naming only the caller-supplied path; both-sides and no-RBAC log fine", async () => {
      mkdirSync(join(vault, "pricing"), { recursive: true });
      mkdirSync(join(vault, "intel"), { recursive: true });
      const argsFor = (b: string) => ({
        title: "t", kind: "factual",
        sourceA: "pricing/a.md", claimA: "x", sourceB: b, claimB: "y",
        agent: "test",
      });
      const denied = await vaultTensionLog(vault, argsFor("intel/c.md"), pricingOnly);
      expect(denied.ok).toBe(false);
      if (denied.ok) return;
      expect(denied.error.message).toBe(
        "access denied: role 'analyst' cannot log a tension naming 'intel/c.md'",
      );
      expect(await vaultTensionLog(vault, argsFor("intel/c.md"), both)).toMatchObject({ ok: true });
      expect(await vaultTensionLog(vault, argsFor("intel/d.md"))).toMatchObject({ ok: true });
    });

    it("resolve: invisible tension is indistinguishable from nonexistent, even for loop-authored", async () => {
      const { t2 } = await seedCrossTension(vault);
      // Loop-authored invisible entry: the ordering pin. A non-ratify,
      // one-sided caller must get NOT-FOUND, not the ratify error.
      const loop = await addTension(vault, {
        title: "loop cross", kind: "factual",
        sourceA: "pricing/a.md", claimA: "x", sourceB: "intel/c.md", claimB: "z",
        loggedBy: CONSOLIDATE_AGENT,
      });
      if (!loop.ok) throw loop.error;

      const resolution = { kind: "accepted" } as const;
      const invisible = await vaultTensionResolve(
        vault, { id: t2.id, kind: resolution.kind }, pricingOnly,
      );
      const nonexistent = await vaultTensionResolve(
        vault, { id: "tension-99999", kind: resolution.kind }, pricingOnly,
      );
      expect(invisible.ok).toBe(false);
      expect(nonexistent.ok).toBe(false);
      if (invisible.ok || nonexistent.ok) return;
      // String equality with the id swapped: the denial carries zero extra info.
      expect(invisible.error.message).toBe(`tension not found: ${t2.id}`);
      expect(nonexistent.error.message).toBe("tension not found: tension-99999");

      const loopInvisible = await vaultTensionResolve(
        vault, { id: loop.value.id, kind: resolution.kind }, pricingOnly,
      );
      expect(loopInvisible.ok).toBe(false);
      if (loopInvisible.ok) return;
      expect(loopInvisible.error.message).toBe(`tension not found: ${loop.value.id}`);
      expect(loopInvisible.error.message).not.toContain("ratify");

      // Visible + loop-authored still requires ratify (existing rule intact).
      const loopVisible = await addTension(vault, {
        title: "loop in-pricing", kind: "factual",
        sourceA: "pricing/a.md", claimA: "x", sourceB: "pricing/b.md", claimB: "y",
        loggedBy: CONSOLIDATE_AGENT,
      });
      if (!loopVisible.ok) throw loopVisible.error;
      const ratifyDenied = await vaultTensionResolve(
        vault, { id: loopVisible.value.id, kind: resolution.kind }, pricingOnly,
      );
      expect(ratifyDenied.ok).toBe(false);
      if (ratifyDenied.ok) return;
      expect(ratifyDenied.error.message).toContain("cannot resolve a loop-authored tension");
    });
```

Imports to add: `vaultTensionResolve` (from tools/curation.js, if not already there), `CONSOLIDATE_AGENT` (from `../../src/consolidate/constants.js`). Check `vaultTensionResolve`'s exact args shape in the file (~line 120) — the test above assumes `{ id, kind }`; adjust field names to what the handler validates if different (read the handler first).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/tools/curation.test.ts -t "tension RBAC"`
Expected: the log test FAILS (denied call currently succeeds); resolve test FAILS (invisible resolve currently succeeds or hits ratify first).

- [ ] **Step 3: Implement**

`vaultTensionLog` — after all arg validation, before `addTension`:

```ts
  // #212: you cannot quote what you cannot read. Deny names the
  // caller-supplied path only — resolving it to a collection first would
  // leak a frontmatter-declared collection for existing docs.
  if (access) {
    const db = openIndexForAccessOrNull(vaultRoot);
    try {
      for (const side of [sourceA.value, sourceB.value]) {
        const canonical = canonicalRel(side);
        const readable =
          canonical.length > 0 &&
          !canonical.startsWith("..") &&
          canRead(access.role, collectionForPath(db, canonical));
        if (!readable) {
          return err(
            new Error(
              `access denied: role '${access.roleName}' cannot log a tension naming '${side}'`,
            ),
          );
        }
      }
    } finally {
      db?.close();
    }
  }
```

`vaultTensionResolve` — the existing block already does `listTensions` + `find` for the ratify check. Insert the visibility check BETWEEN the `find` and the ratify condition:

```ts
  const all = await listTensions(vaultRoot);
  if (!all.ok) return all;
  const target = all.value.find((t) => t.id === id.trim());
  // #212: an invisible tension must be indistinguishable from a nonexistent
  // one — checked BEFORE the ratify rule, whose error would otherwise
  // confirm existence to a caller who cannot see the entry.
  if (target && access) {
    const db = openIndexForAccessOrNull(vaultRoot);
    try {
      if (!canSeeTension(db, access, target.sourceA, target.sourceB)) {
        return err(new Error(`tension not found: ${id.trim()}`));
      }
    } finally {
      db?.close();
    }
  }
  if (target && target.loggedBy === CONSOLIDATE_AGENT && access && !canRatify(access.role)) {
    ...existing ratify denial unchanged...
  }
```

Add `canSeeTension` to the tension-access import in this file.

- [ ] **Step 4: Verify green + full curation regression**

Run: `npx vitest run test/tools/curation.test.ts test/tools/tension-resolve.test.ts test/curation/`
Expected: all pass (tension-resolve.test.ts runs access-less or visible-path cases — unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/tools/curation.ts test/tools/curation.test.ts
git commit -m "feat(rbac): tension log/resolve require read on both named sides (#212)

Log denials name the caller-supplied path, never a resolved collection.
Resolving an invisible tension returns the exact not-found error, checked
before the ratify rule so no denial confirms a hidden entry exists.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: CHANGELOG, lint, build, full suite

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]` — add a `### Security` subsection if absent)

- [ ] **Step 1: CHANGELOG entry**

```markdown
### Security

- **Tension tools now enforce the both-sides visibility rule** (#212).
  `vault_tension_clusters` and `vault_tension_blast` compute over only the
  tensions whose BOTH sides the caller can read — filtered before
  aggregation, so counts, cluster sizes, and blast seeds reveal nothing
  about hidden entries. `vault_tension_log` refuses to record claims naming
  a document the caller cannot read (denial names the caller-supplied path
  only); `vault_tension_resolve` returns the exact not-found error for
  invisible tensions, checked before the loop-authored ratify rule. This
  closes the bypass around #211's contested-annotation gate: one rule
  (`collectionForPath` + `canSeeTension`) now governs every tension
  surface. No-RBAC deployments are unaffected. Known residual (accepted):
  sequential tension ids still reveal the total entry count to callers who
  can log.
```

- [ ] **Step 2: Gate commands** (report actual output)

```bash
npx biome check src/curation/tension-access.ts src/curation/tension-clusters.ts src/curation/tension-blast.ts src/tools/curation.ts src/storage/index-db.ts src/search/contested.ts test/curation/tension-access.test.ts test/tools/curation.test.ts test/storage/index-db.test.ts
npm run build
npm test
```

Expected: lint clean (fix, don't suppress), build clean, full suite green. Known unrelated flakes: embedding-model load in search tests; `staged-actions` timeout — re-run the failed file in isolation before concluding regression.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for tension-tool RBAC alignment (#212)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Done means

Six tasks committed on `mihir/tension-rbac-alignment`; `npm test` green; build + biome clean. Then push and PR to `main`: title "fix(rbac): tension tools enforce both-sides visibility (#212)", body linking the spec, closing #212, and filing the deferred follow-up issue for the edge-graph exposure class (blast downstream lists / `vault_edges` / `vault_lint` naming unreadable docs).
