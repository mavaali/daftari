# SP-A — Foreground the current source: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a `vault_search` hit is superseded, attach a structured pointer to its terminal-current source (RBAC-respecting), alongside the unchanged stale hit — no re-ranking.

**Architecture:** A new pure resolver module (`src/search/current-source.ts`) walks the `superseded_by` chain to the terminal head with cycle/dangling guards and strict RBAC degrade. The `vaultSearch` tool handler calls it per superseded hit and attaches the result to a new optional `currentSource` field. `decay.ts` gains a `superseded` banner branch and stops embedding document-supplied paths in banner text. The ranking function `rankDocuments` in `hybrid.ts` is untouched (only the `HybridHit` *type* gains an optional field).

**Tech Stack:** TypeScript, Node, better-sqlite3 (index), vitest. Style: no classes; functions + types; `Result<T,Error>`; never throw from tool handlers.

**Spec:** `docs/superpowers/specs/2026-06-21-sp-a-foreground-current-source-design.md`

**Before you start:** Branch off `docs/sp-a-foreground` (where this plan lives) → `feat/sp-a-foreground`. Build with `npm run build`; test with `npm test` (vitest). Run a single file with `npx vitest run test/path/file.test.ts`.

---

## File Structure

- **Create** `src/search/current-source.ts` — the `CurrentSource` type + `resolveCurrentSource` (chain walk, guards, RBAC degrade, preview snippet). Pure; depends only on `index-db` (`getDocument`, `IndexedDocument`, `IndexDb`) and `access/rbac` (`canRead`, `AccessContext`).
- **Create** `test/search/current-source.test.ts` — resolver unit tests (the bulk of the coverage).
- **Modify** `src/curation/decay.ts` — add `superseded` branch; remove document-supplied `superseded_by` from banner text.
- **Modify** `test/curation/decay.test.ts` — superseded banner; no-path-in-banner assertions.
- **Modify** `src/search/hybrid.ts` — add `currentSource?: CurrentSource` to the `HybridHit` interface (type only; `rankDocuments` logic unchanged).
- **Modify** `src/tools/search.ts` — wire `resolveCurrentSource` into `vaultSearch`, restructuring the `!access` early return so enrichment runs on both paths.
- **Modify** `test/tools/search.test.ts` (or create if absent) — integration: superseded hit carries `currentSource.resolved`; ordering unchanged.

---

## Task 1: `CurrentSource` type + resolver happy path (single + multi-hop)

**Files:**
- Create: `src/search/current-source.ts`
- Test: `test/search/current-source.test.ts`

- [ ] **Step 1: Write the failing tests (happy path)**

```ts
// test/search/current-source.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import {
  type IndexDb,
  type IndexedDocument,
  insertDocument,
  openIndexDb,
} from "../../src/storage/index-db.js";
import { resolveCurrentSource } from "../../src/search/current-source.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

function doc(over: Partial<IndexedDocument> & { path: string }): IndexedDocument {
  return {
    path: over.path,
    title: over.title ?? over.path,
    collection: over.collection ?? "pricing",
    domain: "accumulation",
    status: over.status ?? "canonical",
    confidence: "high",
    updated: "2026-05-01",
    tags: [],
    content: over.content ?? "body text",
    tokens: [],
    ttlDays: null,
    created: "2026-01-01",
    supersededBy: over.supersededBy ?? null,
  };
}

describe("resolveCurrentSource", () => {
  let vault: string;
  let db: IndexDb;

  beforeEach(() => {
    vault = makeTempVault();
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    if (!opened.ok) throw opened.error;
    db = opened.value;
  });
  afterEach(() => {
    db.close();
    cleanupVault(vault);
  });

  it("returns null for a non-superseded document", () => {
    insertDocument(db, doc({ path: "a.md" }));
    expect(resolveCurrentSource(db, "a.md")).toBeNull();
  });

  it("resolves a single hop to the successor", () => {
    insertDocument(db, doc({ path: "a.md", status: "superseded", supersededBy: "b.md" }));
    insertDocument(db, doc({ path: "b.md", title: "B", content: "the current value is 465" }));
    const cs = resolveCurrentSource(db, "a.md");
    expect(cs).toEqual({
      kind: "resolved",
      path: "b.md",
      title: "B",
      snippet: "the current value is 465",
      hops: 1,
    });
  });

  it("walks a chain to the terminal head and counts hops", () => {
    insertDocument(db, doc({ path: "a.md", status: "superseded", supersededBy: "b.md" }));
    insertDocument(db, doc({ path: "b.md", status: "superseded", supersededBy: "c.md" }));
    insertDocument(db, doc({ path: "c.md", title: "C", content: "terminal head" }));
    const cs = resolveCurrentSource(db, "a.md");
    expect(cs).toMatchObject({ kind: "resolved", path: "c.md", title: "C", hops: 2 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/search/current-source.test.ts`
Expected: FAIL — `resolveCurrentSource` not found / module missing.

- [ ] **Step 3: Implement the resolver (happy path + null)**

```ts
// src/search/current-source.ts
//
// resolveCurrentSource — follow a document's `superseded_by` chain to the
// terminal-current source, for inline foregrounding in search results.
//
// daftari authors the RELATION (points at the current source), never the
// VALUE (the snippet is read verbatim from the successor's indexed content).
// Pure over the index; never throws. Returns null when the document is not
// superseded (nothing to foreground).

import { type AccessContext, canRead } from "../access/rbac.js";
import { getDocument, type IndexDb } from "../storage/index-db.js";

// A leading preview of the successor's body — the successor did not
// necessarily match the query, so there are no query terms to centre on.
// Mirrors hybrid.ts's no-hit snippet (collapse whitespace, cap length).
const PREVIEW_MAX = 280;
function previewSnippet(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_MAX ? `${collapsed.slice(0, PREVIEW_MAX)}…` : collapsed;
}

export type CurrentSource =
  | { kind: "resolved"; path: string; title: string; snippet: string; hops: number }
  | { kind: "restricted" }
  | { kind: "dangling"; brokenAt: string }
  | { kind: "cycle" };

export function resolveCurrentSource(
  db: IndexDb,
  stalePath: string,
  access?: AccessContext,
): CurrentSource | null {
  let doc = getDocument(db, stalePath);
  if (!doc || doc.supersededBy === null) return null; // not superseded — nothing to foreground

  const visited = new Set<string>([doc.path]);
  let hops = 0;

  while (doc.supersededBy !== null) {
    const nextPath = doc.supersededBy;
    hops += 1;
    if (visited.has(nextPath)) return { kind: "cycle" };
    visited.add(nextPath);

    const nextDoc = getDocument(db, nextPath);
    if (!nextDoc) return { kind: "dangling", brokenAt: doc.path };

    // RBAC (strict): any unreadable hop, including the terminal head, degrades
    // to a path-free marker. `access` undefined ⇒ RBAC unconfigured ⇒ readable.
    if (access && !canRead(access.role, nextDoc.collection)) return { kind: "restricted" };

    doc = nextDoc;
  }

  return {
    kind: "resolved",
    path: doc.path,
    title: doc.title,
    snippet: previewSnippet(doc.content),
    hops,
  };
}
```

- [ ] **Step 4: Run to verify the happy-path tests pass**

Run: `npx vitest run test/search/current-source.test.ts`
Expected: PASS (all three tests).

- [ ] **Step 5: Commit**

```bash
git add src/search/current-source.ts test/search/current-source.test.ts
git commit -m "feat(search): resolveCurrentSource — chain walk to terminal head"
```

---

## Task 2: Cycle + dangling guards

**Files:**
- Modify: `test/search/current-source.test.ts`
- (implementation already covers these — these tests lock the behavior in)

- [ ] **Step 1: Write the failing tests**

```ts
  it("returns cycle when the chain loops", () => {
    insertDocument(db, doc({ path: "a.md", status: "superseded", supersededBy: "b.md" }));
    insertDocument(db, doc({ path: "b.md", status: "superseded", supersededBy: "a.md" }));
    expect(resolveCurrentSource(db, "a.md")).toEqual({ kind: "cycle" });
  });

  it("returns dangling when a successor is missing, naming the dangling source", () => {
    insertDocument(db, doc({ path: "a.md", status: "superseded", supersededBy: "gone.md" }));
    expect(resolveCurrentSource(db, "a.md")).toEqual({ kind: "dangling", brokenAt: "a.md" });
  });

  it("returns dangling mid-chain at the document whose pointer breaks", () => {
    insertDocument(db, doc({ path: "a.md", status: "superseded", supersededBy: "b.md" }));
    insertDocument(db, doc({ path: "b.md", status: "superseded", supersededBy: "gone.md" }));
    expect(resolveCurrentSource(db, "a.md")).toEqual({ kind: "dangling", brokenAt: "b.md" });
  });
```

- [ ] **Step 2: Run to verify**

Run: `npx vitest run test/search/current-source.test.ts`
Expected: PASS (the Task 1 implementation already handles cycle/dangling). If any fail, fix the resolver, not the test.

- [ ] **Step 3: Commit**

```bash
git add test/search/current-source.test.ts
git commit -m "test(search): lock cycle + dangling resolver behavior"
```

---

## Task 3: RBAC degrade

**Files:**
- Modify: `test/search/current-source.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import type { AccessContext } from "../../src/access/rbac.js";

function accessReading(...collections: string[]): AccessContext {
  // RoleConfig requires all four fields (read/write/promote/ratify) — promote
  // and ratify are non-optional; omitting them fails the TS build.
  return { user: "u", roleName: "r", role: { read: collections, write: [], promote: false, ratify: false } };
}

  it("degrades to restricted when the terminal head is unreadable", () => {
    insertDocument(db, doc({ path: "a.md", collection: "pricing", status: "superseded", supersededBy: "b.md" }));
    insertDocument(db, doc({ path: "b.md", collection: "secret" }));
    expect(resolveCurrentSource(db, "a.md", accessReading("pricing"))).toEqual({ kind: "restricted" });
  });

  it("degrades to restricted when an intermediate hop is unreadable", () => {
    insertDocument(db, doc({ path: "a.md", collection: "pricing", status: "superseded", supersededBy: "b.md" }));
    insertDocument(db, doc({ path: "b.md", collection: "secret", status: "superseded", supersededBy: "c.md" }));
    insertDocument(db, doc({ path: "c.md", collection: "pricing" }));
    expect(resolveCurrentSource(db, "a.md", accessReading("pricing"))).toEqual({ kind: "restricted" });
  });

  it("resolves when every hop is readable", () => {
    insertDocument(db, doc({ path: "a.md", collection: "pricing", status: "superseded", supersededBy: "b.md" }));
    insertDocument(db, doc({ path: "b.md", collection: "pricing", title: "B", content: "current" }));
    expect(resolveCurrentSource(db, "a.md", accessReading("pricing"))).toMatchObject({
      kind: "resolved",
      path: "b.md",
    });
  });

  it("resolves with a wildcard reader", () => {
    insertDocument(db, doc({ path: "a.md", collection: "pricing", status: "superseded", supersededBy: "b.md" }));
    insertDocument(db, doc({ path: "b.md", collection: "secret" }));
    expect(resolveCurrentSource(db, "a.md", accessReading("*"))).toMatchObject({ kind: "resolved" });
  });
```

- [ ] **Step 2: Run to verify**

Run: `npx vitest run test/search/current-source.test.ts`
Expected: PASS (Task 1 implementation already applies the RBAC check). Fix the resolver if any fail.

- [ ] **Step 3: Commit**

```bash
git add test/search/current-source.test.ts
git commit -m "test(search): lock strict RBAC degrade in resolver"
```

---

## Task 4: `decay.ts` — superseded banner + drop doc-supplied path from banner

**Files:**
- Modify: `src/curation/decay.ts:41-52` (add a `superseded` branch; drop the `superseded by: ${ref}` reason from both branches)
- Modify: `src/curation/decay.ts:99-106` (`renderBanner` — superseded-specific head)
- Modify: `test/curation/decay.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
  it("flags a superseded document with a banner (was previously silent)", () => {
    const d = computeDecay({ ...healthy(), status: "superseded", superseded_by: "b.md" }, NOW);
    expect(d?.level).toBe("deprecated");
    expect(d?.banner).toContain("SUPERSEDED");
  });

  it("never embeds the superseded_by path in the superseded banner", () => {
    const d = computeDecay({ ...healthy(), status: "superseded", superseded_by: "secret/b.md" }, NOW);
    expect(d?.banner).not.toContain("secret/b.md");
    expect(d?.reasons.join(" ")).not.toContain("secret/b.md");
  });

  it("never embeds the superseded_by path in the deprecated banner", () => {
    const d = computeDecay({ ...healthy(), status: "deprecated", superseded_by: "secret/b.md" }, NOW);
    expect(d?.level).toBe("deprecated");
    expect(d?.banner).not.toContain("secret/b.md");
    expect(d?.reasons.join(" ")).not.toContain("secret/b.md");
  });
```

Also: **delete the existing injection-forge test at `test/curation/decay.test.ts:73-87`** (`"collapses whitespace in superseded_by so the banner cannot be forged"`). It asserts the deprecated banner is exactly 3 lines (`d?.banner?.split("\n")).toHaveLength(3)`) — head + 2 reason lines, the second being the `superseded by:` line. SP-A removes that reason line entirely, so the banner is now 2 lines and the assertion hard-fails. The injection vector it guards no longer exists (no document-supplied path reaches the banner), and the new "never embeds the superseded_by path" tests above supersede it. Delete the whole `it(...)` block, don't try to adjust the line count.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/curation/decay.test.ts`
Expected: FAIL — superseded yields `null` today (no banner); the path-absence tests may pass or fail depending on current text.

- [ ] **Step 3: Edit `decay.ts`**

Replace the deprecated block (lines 40-52) with two branches that no longer interpolate the document-supplied ref:

```ts
  // Superseded — replaced by a specific successor. Retired severity. The
  // successor's identity is surfaced structurally by resolveCurrentSource, NOT
  // in this banner, so no document-authored string reaches the prompt here.
  if (input.status === "superseded") {
    level = "deprecated";
    reasons.push("status is superseded — a newer version of this document exists");
  }

  // Deprecated — formally retired knowledge. Highest precedence.
  if (input.status === "deprecated") {
    level = "deprecated";
    reasons.push("status is deprecated — this document has been retired");
  }
```

Update `renderBanner` (lines 99-106) to pick a superseded-specific head. Pass the triggering status through, e.g. add a parameter:

```ts
function renderBanner(level: DecayLevel, reasons: string[], status: string): string | null {
  if (level === "aging") return null;
  let head: string;
  if (status === "superseded") {
    head = "⚠ SUPERSEDED — a newer version of this document exists. See the current source rather than relying on this one.";
  } else if (level === "deprecated") {
    head = "⚠ DEPRECATED — this document has been retired. Do not rely on it; find the current source.";
  } else {
    head = "⚠ STALE — this document may no longer be accurate. Verify against a current source before relying on it.";
  }
  return `${head}\n${reasons.map((r) => `  - ${r}`).join("\n")}`;
}
```

Update the single call site (line 92): `return { level, reasons, banner: renderBanner(level, reasons, input.status) };`

Delete the now-unused whitespace-collapse block (old lines 44-51) — it existed solely to sanitize the interpolated ref, which is gone.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/curation/decay.test.ts`
Expected: PASS (all, including the updated deprecated test).

- [ ] **Step 5: Commit**

```bash
git add src/curation/decay.ts test/curation/decay.test.ts
git commit -m "feat(decay): superseded gets a banner; drop doc-supplied path from banner text"
```

---

## Task 5: Wire enrichment into `vaultSearch`

**Files:**
- Modify: `src/search/hybrid.ts:38-48` (add optional field to `HybridHit`)
- Modify: `src/tools/search.ts:110-141` (`vaultSearch` — call resolver, restructure `!access` early return)
- Modify/Create: `test/tools/search.test.ts`

- [ ] **Step 1: Add the optional field to `HybridHit`** (type-only; `rankDocuments` untouched)

In `src/search/hybrid.ts`, add the import and the field:

```ts
import type { CurrentSource } from "./current-source.js";
```
```ts
export interface HybridHit {
  path: string;
  title: string;
  collection: string;
  status: string;
  score: number;
  bm25Score: number;
  vectorScore: number;
  snippet: string;
  decay: DecayState | null;
  currentSource?: CurrentSource; // populated by the tool handler, not the ranker
}
```
(No `current-source.ts` → `hybrid.ts` import exists, so this is acyclic.)

- [ ] **Step 2: Write the failing integration test**

The DB needs to be the same one `vaultSearch` opens for the active provider. Use the established pattern: build a temp vault, write markdown files, index them, then call `vaultSearch`. Mirror the setup already used in `test/tools/search.test.ts` (read it first and match its harness — temp vault + `vault_index`/`reindexVault`, then `vaultSearch(vault, { query })`). The new assertions:

```ts
  it("attaches currentSource.resolved to a superseded hit", async () => {
    // ...index a vault where doc 'old.md' is status:superseded, superseded_by 'new.md',
    //    and both contain the query term so 'old.md' is a hit...
    const res = await vaultSearch(vault, { query: "<term in old.md>" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const hit = res.value.hits.find((h) => h.path === "old.md");
    expect(hit?.currentSource).toMatchObject({ kind: "resolved", path: "new.md" });
  });

  it("does not re-order: a non-superseded query is byte-identical with enrichment", async () => {
    const res = await vaultSearch(vault, { query: "<term only in healthy docs>" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hits.every((h) => h.currentSource === undefined)).toBe(true);
  });
```

> `test/tools/search.test.ts` already exists, but its harness builds ONE shared read-only temp vault in `beforeAll`. Do **not** mutate that shared vault. Add the superseded-fixture tests in their own `describe` block with a dedicated `makeTempVault()` + write two markdown files (`old.md` with `status: superseded` / `superseded_by: new.md` in frontmatter, both sharing a query term) + `reindexVault(vault)` in a local `beforeAll`/`afterAll`, then call `vaultSearch(vault, { query })`. Use `test/search/reindex.test.ts` as the template for the build+index sequence. Keep the fixture minimal. **Give the `beforeAll` an extended timeout (`60_000`)** — embedding cold-start exceeds vitest's 5s default and would otherwise look like a flake.

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run test/tools/search.test.ts`
Expected: FAIL — `currentSource` is undefined on the superseded hit (not yet wired).

- [ ] **Step 4: Wire the resolver into `vaultSearch`**

In `src/tools/search.ts`, add the import:

```ts
import { resolveCurrentSource } from "../search/current-source.js";
```

Replace the body from line 130 (`const result = await hybridSearch(...)`) through the early return so enrichment runs on **both** the access and no-access paths:

```ts
    const result = await hybridSearch(db, query, {
      weights: parseWeights(args.weights),
      limit: parseLimit(args.limit),
    });
    if (!result.ok) return result;

    // RBAC: drop hits in collections the role cannot read (only when an access
    // context is present). Enrichment then runs on the surviving hits.
    const hits = access
      ? result.value.hits.filter((h) => canRead(access.role, h.collection))
      : result.value.hits;

    // Foreground the current source for any superseded hit. Additive and
    // lossless — the stale hit keeps its place; we only attach a pointer.
    for (const hit of hits) {
      const cs = resolveCurrentSource(db, hit.path, access);
      if (cs) hit.currentSource = cs;
    }

    return ok({ ...result.value, count: hits.length, hits });
```

(This replaces both the old `if (!result.ok || !access) return result;` and the old filter+return. `db` is still open — enrichment sits inside the existing `try`, before the `finally` close at the bottom.)

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/tools/search.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/search/hybrid.ts src/tools/search.ts test/tools/search.test.ts
git commit -m "feat(search): foreground current source in vault_search results"
```

---

## Task 6: Full verification

- [ ] **Step 1: Typecheck + build**

Run: `npm run build`
Expected: no TypeScript errors. (Watch for: `renderBanner` arity change, the new import in `hybrid.ts`, `currentSource` optionality.)

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all green. If the embedding-model job flakes (known MiniLM load flake), re-run `npx vitest run --failed` before assuming a regression.

- [ ] **Step 3: Lint**

Run: `npm run lint` (if present in package.json scripts; otherwise skip).
Expected: clean.

- [ ] **Step 4: Manual sanity (optional)**

Supersede a doc in the sample vault and confirm `vault_search` returns `currentSource` on the stale hit:
```bash
npm run dev   # against test/fixtures/sample-vault
# then exercise vault_supersede + vault_search via the MCP client / a scratch script
```

- [ ] **Step 5: Final commit (if any cleanup)**

```bash
git add -A
git commit -m "chore(sp-a): verification pass — suite green"
```

---

## Done criteria

- `resolveCurrentSource` returns `resolved | restricted | dangling | cycle | null` exactly per the spec union, fully unit-tested (single/multi-hop, cycle, dangling mid-chain, RBAC terminal + intermediate degrade, wildcard, no-access).
- A `status: "superseded"` document now produces a banner; no decay banner embeds a document-supplied path.
- A superseded `vault_search` hit carries `currentSource`; non-superseded results carry none; **ordering is unchanged** (no re-rank).
- `rankDocuments` ranking logic is untouched. `vault_search_related` is deliberately not enriched (out of scope).
- `npm run build` and `npm test` are green.
