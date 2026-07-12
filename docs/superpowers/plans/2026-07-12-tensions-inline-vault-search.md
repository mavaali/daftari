# Tensions Inline in `vault_search` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `vault_search` hits carry an optional `contested` annotation — the full two-sided marker for unresolved tensions involving the document — post-joined from `.daftari/tensions.md`.

**Architecture:** One new module, `src/search/contested.ts`, owns the tension-log mtime cache, path canonicalization, and per-hit lookup (mirrors `src/search/current-source.ts` in role and `src/utils/config.ts`'s E2 cache in mechanism). `vaultSearch` calls it in the existing per-hit enrichment loop. Two optional fields land on `HybridHit`. No ranking change, no schema change, no new tool.

**Spec:** `docs/superpowers/specs/2026-07-12-tensions-inline-vault-search-design.md` — read it first; it is the contract. Key decisions: unresolved tensions only; cap 3 per hit + honest `contestedCount`; order by date desc then log-file position desc; RBAC = omit entirely unless the caller can read the counterpart's collection; annotation failure is never search failure.

**Tech Stack:** TypeScript (Node 20+), vitest, better-sqlite3 index (read-only here), biome.

**Project rules (from CLAUDE.md):** no classes — functions and types; tool handlers return `Result`, never throw; tests mirror `src/` structure.

**Working directory:** `/Users/mihirwagle/projects/daftari/.claude/worktrees/tensions-inline-search` (branch `mihir/tensions-inline-search`). All commands below run from this directory. Do NOT `git checkout` or switch branches.

---

### Task 1: `contested.ts` — types, canonicalization, log parse into a by-path map

**Files:**
- Create: `src/search/contested.ts`
- Test: `test/search/contested.test.ts`

The module's core: parse the tension log once, index unresolved entries by canonical path with both sides pre-oriented. The alias test is written FIRST — path aliasing has caused two prior security bugs (#127, #128).

- [ ] **Step 1: Write the failing tests**

Create `test/search/contested.test.ts`:

```ts
import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { addTension, resolveTension, tensionsPath } from "../../src/curation/tension.js";
import { clearContestedCache, contestedFor } from "../../src/search/contested.js";
import { openIndexForActiveProvider, vaultReindex } from "../../src/tools/search.js";
import type { IndexDb } from "../../src/storage/index-db.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// Two real fixture docs to hang tensions on.
const DOC_A = "pricing/helios-consumption-pricing.md";
const DOC_B = "competitive-intel/vega-insight-positioning.md";

async function logTension(
  vault: string,
  overrides: Partial<Parameters<typeof addTension>[1]> = {},
) {
  const result = await addTension(vault, {
    title: "pricing vs positioning",
    kind: "factual",
    sourceA: DOC_A,
    claimA: "credits are consumption-priced",
    sourceB: DOC_B,
    claimB: "Vega undercuts on flat pricing",
    loggedBy: "test",
    ...overrides,
  });
  if (!result.ok) throw result.error;
  return result.value;
}

describe("contested", () => {
  let vault: string;
  let db: IndexDb;

  beforeAll(async () => {
    vault = makeTempVault();
    const reindexed = await vaultReindex(vault);
    if (!reindexed.ok) throw reindexed.error;
    const opened = openIndexForActiveProvider(vault);
    if (!opened.ok) throw opened.error;
    db = opened.value;
  }, 60_000);

  afterAll(() => {
    db.close();
    cleanupVault(vault);
  });

  afterEach(() => {
    // Each test manages its own log; wipe both file and cache between cases.
    rmSync(tensionsPath(vault), { force: true });
    clearContestedCache();
  });

  it("joins a tension logged under an alias path to the canonical hit", async () => {
    await logTension(vault, { sourceA: "pricing/../pricing/helios-consumption-pricing.md" });
    const hit = contestedFor(vault, db, DOC_A);
    expect(hit).not.toBeNull();
    expect(hit?.contested[0]?.counterpart).toBe(DOC_B);
  });

  it("annotates both sides, with claimSelf/claimOther oriented per side", async () => {
    await logTension(vault);
    const a = contestedFor(vault, db, DOC_A);
    const b = contestedFor(vault, db, DOC_B);
    expect(a?.contested[0]).toMatchObject({
      counterpart: DOC_B,
      claimSelf: "credits are consumption-priced",
      claimOther: "Vega undercuts on flat pricing",
      kind: "factual",
    });
    expect(b?.contested[0]).toMatchObject({
      counterpart: DOC_A,
      claimSelf: "Vega undercuts on flat pricing",
      claimOther: "credits are consumption-priced",
    });
    expect(a?.contested[0]?.id).toBe(b?.contested[0]?.id);
  });

  it("does not annotate resolved tensions", async () => {
    const entry = await logTension(vault);
    clearContestedCache();
    const resolved = await resolveTension(vault, entry.id as string, {
      resolved_at: new Date().toISOString(),
      resolved_by: "test",
      kind: "accepted",
    });
    expect(resolved.ok).toBe(true);
    expect(contestedFor(vault, db, DOC_A)).toBeNull();
  });

  it("returns null when the log is absent and for uninvolved paths", async () => {
    expect(contestedFor(vault, db, DOC_A)).toBeNull();
    await logTension(vault);
    expect(contestedFor(vault, db, "pricing/no-such-doc.md")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/search/contested.test.ts`
Expected: FAIL — `Cannot find module '../../src/search/contested.js'` (or missing exports).

- [ ] **Step 3: Write the implementation**

Create `src/search/contested.ts`:

```ts
// contested — post-join of the tension log onto search hits.
//
// The tension-graph feud benchmark (2026-07-04) measured this shape: a
// contradiction surfaced INLINE in the retrieval payload is acted on ~6x more
// often than one reachable through a dedicated tool the agent must choose to
// call (tg-3b vs tg-3a, all three panel models). This module is the inline
// half: vaultSearch asks contestedFor per surviving hit, in the same
// enrichment pass as resolveCurrentSource.
//
// Advisory, additive, lossless: contested-ness never feeds ranking, and a
// missing or malformed tension log degrades to "no annotations", never a
// failed search. Unresolved tensions only — a resolved tension's outcome is
// already expressed through supersede/deprecate edges, and the live marker
// must mean live disagreement.

import { readFileSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";
import { type AccessContext, canRead } from "../access/rbac.js";
import {
  parseTensionLog,
  type TensionKind,
  tensionsPath,
} from "../curation/tension.js";
import { getDocument, type IndexDb } from "../storage/index-db.js";

export interface ContestedTension {
  id?: string; // absent only for legacy entries
  kind: TensionKind;
  counterpart: string; // canonical vault-relative path of the other side
  claimSelf: string; // this hit's claim, per the log
  claimOther: string; // the counterpart's claim
  loggedAt: string; // entry date, YYYY-MM-DD
}

// Payload bound per hit. contestedCount reports the true total, so the cap
// never silently truncates.
export const CONTESTED_CAP = 3;

// One side of one entry, pre-oriented at map-build time so the per-hit join
// is a plain lookup.
interface SideRecord {
  order: number; // block position in the log (append-only ⇒ logged order)
  id?: string;
  kind: TensionKind;
  date: string;
  counterpart: string;
  claimSelf: string;
  claimOther: string;
}

// Lexical, IO-free canonicalization of a vault-relative path: aliasing
// (`pricing/../pricing/a.md`) must join its canonical hit (#127/#128 class).
// A path that escapes the root normalizes to a `..`-leading form, which can
// never equal an indexed hit path — escapes simply never join.
function canonicalRel(p: string): string {
  return posix.normalize(p.trim().replace(/\\/g, "/")).replace(/^\.\//, "");
}

// mtime-keyed cache of the parsed, indexed log — the E2 loadConfig pattern
// (utils/config.ts): statSync per call, full re-read only when the mtime
// changes. ENOENT is itself a cache state (`mtimeMs: null`), so an absent log
// caches an empty map and a log that appears busts it. A non-ENOENT stat
// error yields NaN, which never satisfies `===` — such calls re-read rather
// than serve a stale hit.
interface CacheEntry {
  mtimeMs: number | null;
  byPath: Map<string, SideRecord[]>;
}
const cache = new Map<string, CacheEntry>();

// Test-only hook, mirroring clearConfigCache.
export function clearContestedCache(): void {
  cache.clear();
}

function buildByPath(raw: string): Map<string, SideRecord[]> {
  const byPath = new Map<string, SideRecord[]>();
  const add = (key: string, record: SideRecord) => {
    const list = byPath.get(key);
    if (list) list.push(record);
    else byPath.set(key, [record]);
  };
  parseTensionLog(raw).forEach((entry, order) => {
    if (entry.resolved) return;
    const a = canonicalRel(entry.sourceA);
    const b = canonicalRel(entry.sourceB);
    if (a.length === 0 || b.length === 0) return;
    const base = { order, id: entry.id, kind: entry.kind, date: entry.date };
    add(a, { ...base, counterpart: b, claimSelf: entry.claimA, claimOther: entry.claimB });
    add(b, { ...base, counterpart: a, claimSelf: entry.claimB, claimOther: entry.claimA });
  });
  return byPath;
}

function tensionsByPath(vaultRoot: string): Map<string, SideRecord[]> {
  const path = tensionsPath(vaultRoot);
  const key = resolve(vaultRoot);

  let mtimeMs: number | null;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch (e) {
    mtimeMs = (e as NodeJS.ErrnoException).code === "ENOENT" ? null : Number.NaN;
  }

  const cached = cache.get(key);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.byPath;

  let byPath: Map<string, SideRecord[]>;
  if (mtimeMs === null) {
    byPath = new Map();
  } else {
    let raw = "";
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      // Race (log deleted between stat and read) or unreadable file: degrade
      // to no annotations for this call. Never fail the search.
    }
    byPath = buildByPath(raw);
  }
  cache.set(key, { mtimeMs, byPath });
  return byPath;
}

// The counterpart's collection for the RBAC gate: the indexed row when
// present; the physical first path segment otherwise (the S1/#192 rule —
// key on where the bytes live, never on a declared string). The fallback
// errs closed: a `..`-leading or empty segment matches no role's read list.
function counterpartCollection(db: IndexDb, counterpart: string): string {
  const doc = getDocument(db, counterpart);
  return doc?.collection ?? counterpart.split("/")[0] ?? "";
}

// The per-hit join. Returns null when the hit has no visible unresolved
// tensions — callers leave the hit untouched (fields absent, never empty).
//
// RBAC: an annotation quotes the counterpart's claim, so it crosses the ACL
// boundary. A record is visible only when the caller can read the
// counterpart's collection; invisible records are omitted entirely (no
// existence leak) and excluded from contestedCount — the count never reveals
// hidden tensions. `access` undefined ⇒ RBAC unconfigured ⇒ all visible,
// matching vaultSearch's own filtering.
export function contestedFor(
  vaultRoot: string,
  db: IndexDb,
  hitPath: string,
  access?: AccessContext,
): { contested: ContestedTension[]; contestedCount: number } | null {
  const records = tensionsByPath(vaultRoot).get(canonicalRel(hitPath));
  if (records === undefined) return null;

  const visible = access
    ? records.filter((r) => canRead(access.role, counterpartCollection(db, r.counterpart)))
    : records;
  if (visible.length === 0) return null;

  // Date desc, then log position desc: dates are day-granular, so the file
  // position (logged order) is the load-bearing same-day tiebreak.
  const ordered = [...visible].sort(
    (x, y) => y.date.localeCompare(x.date) || y.order - x.order,
  );

  return {
    contested: ordered.slice(0, CONTESTED_CAP).map((r) => ({
      ...(r.id !== undefined ? { id: r.id } : {}),
      kind: r.kind,
      counterpart: r.counterpart,
      claimSelf: r.claimSelf,
      claimOther: r.claimOther,
      loggedAt: r.date,
    })),
    contestedCount: ordered.length,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/search/contested.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/search/contested.ts test/search/contested.test.ts
git commit -m "feat(search): contested module — tension-log post-join with mtime cache

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Ordering, cap, and count

**Files:**
- Modify: `test/search/contested.test.ts` (add tests; implementation from Task 1 should already satisfy them — these tests pin the contract)

- [ ] **Step 1: Write the tests**

Append inside the `describe("contested", ...)` block:

```ts
  it("caps at 3 (date desc, then logged order desc) and reports the true total", async () => {
    // Four same-day tensions on DOC_A: the tiebreak is logged order.
    for (const n of [1, 2, 3, 4]) {
      await logTension(vault, { title: `t${n}`, claimB: `counter-claim ${n}` });
    }
    const hit = contestedFor(vault, db, DOC_A);
    expect(hit?.contestedCount).toBe(4);
    expect(hit?.contested).toHaveLength(3);
    // Most recently logged first.
    expect(hit?.contested.map((c) => c.claimOther)).toEqual([
      "counter-claim 4",
      "counter-claim 3",
      "counter-claim 2",
    ]);
  });

  it("orders by date desc before logged order", async () => {
    await logTension(vault, { date: "2026-07-12", claimB: "newer" });
    await logTension(vault, { date: "2026-07-01", claimB: "older" });
    const hit = contestedFor(vault, db, DOC_A);
    expect(hit?.contested.map((c) => c.claimOther)).toEqual(["newer", "older"]);
  });
```

Note: `addTension` accepts an optional `date` in `TensionInput`. If the second test fails because `date` is ignored/rejected, check `TensionInput` in `src/curation/tension.ts` — `date?: string` is part of it.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/search/contested.test.ts`
Expected: PASS (6 tests). If ordering fails, fix the comparator in `contestedFor` — do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add test/search/contested.test.ts
git commit -m "test(search): pin contested cap, count, and ordering contract

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: RBAC — omit annotations whose counterpart the caller cannot read

**Files:**
- Modify: `test/search/contested.test.ts`

The implementation already carries the gate (Task 1); these tests prove it and pin the no-existence-leak rule.

- [ ] **Step 1: Write the failing/passing tests**

Append inside the describe block:

```ts
  const readsOnlyPricing: AccessContext = {
    user: "t",
    roleName: "analyst",
    role: { read: ["pricing"], write: [], promote: false, ratify: false },
  };
  const readsBoth: AccessContext = {
    user: "t",
    roleName: "lead",
    role: {
      read: ["pricing", "competitive-intel"],
      write: [],
      promote: false,
      ratify: false,
    },
  };

  it("omits the annotation entirely when the counterpart's collection is unreadable", async () => {
    await logTension(vault);
    // DOC_A's counterpart is DOC_B (competitive-intel): unreadable ⇒ omit.
    expect(contestedFor(vault, db, DOC_A, readsOnlyPricing)).toBeNull();
    // Same role, hit on the readable counterpart of an unreadable doc:
    // DOC_B's counterpart is DOC_A (pricing): readable ⇒ annotate.
    expect(contestedFor(vault, db, DOC_B, readsOnlyPricing)).not.toBeNull();
    // A role reading both sees it from both sides.
    expect(contestedFor(vault, db, DOC_A, readsBoth)).not.toBeNull();
  });

  it("contestedCount counts only visible tensions", async () => {
    await logTension(vault); // counterpart competitive-intel (hidden)
    await logTension(vault, {
      sourceB: "pricing/enterprise-tier-launch.md",
      claimB: "tier launch contradicts credit pricing",
    }); // counterpart pricing (visible)
    const hit = contestedFor(vault, db, DOC_A, readsOnlyPricing);
    expect(hit?.contestedCount).toBe(1);
    expect(hit?.contested[0]?.counterpart).toBe("pricing/enterprise-tier-launch.md");
  });

  it("falls back to the first path segment when the counterpart is not indexed", async () => {
    await logTension(vault, {
      sourceB: "competitive-intel/deleted-since-logging.md",
      claimB: "gone but logged",
    });
    // Segment says competitive-intel: hidden from pricing-only, visible to both-reader.
    expect(contestedFor(vault, db, DOC_A, readsOnlyPricing)).toBeNull();
    expect(contestedFor(vault, db, DOC_A, readsBoth)).not.toBeNull();
  });
```

Note: `pricing/enterprise-tier-launch.md` does not exist in the fixture vault — that is fine and intentional here: the counterpart is unindexed, so the RBAC gate uses the first-segment fallback (`pricing` → readable). Do not "fix" the path; only the first segment matters to this test.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/search/contested.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 3: Commit**

```bash
git add test/search/contested.test.ts
git commit -m "test(search): pin contested RBAC — omit unreadable counterparts, honest count

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Cache invalidation

**Files:**
- Modify: `test/search/contested.test.ts`

- [ ] **Step 1: Write the test**

This test must NOT call `clearContestedCache` between the two lookups — it proves the mtime bust does the work. (`afterEach` clearing is fine; it runs after.)

```ts
  it("sees a tension appended after a cached empty read (mtime bust, no manual clear)", async () => {
    expect(contestedFor(vault, db, DOC_A)).toBeNull(); // caches the absent log
    await logTension(vault); // creates the file — mtime state changes
    expect(contestedFor(vault, db, DOC_A)).not.toBeNull();
  });

  it("sees a resolution appended after a cached read", async () => {
    const entry = await logTension(vault);
    expect(contestedFor(vault, db, DOC_A)).not.toBeNull(); // caches the live entry
    await resolveTension(vault, entry.id as string, {
      resolved_at: new Date().toISOString(),
      resolved_by: "test",
      kind: "accepted",
    });
    expect(contestedFor(vault, db, DOC_A)).toBeNull();
  });
```

Flake guard: if the second lookup in either test ever serves stale data on a filesystem with coarse mtime granularity, the fix is comparing `mtimeMs` as done in loadConfig (which this copies) — investigate rather than adding sleeps; `resolveTension` rewrites the whole file, and same-ms rewrites are vanishingly rare but if CI disagrees, key the cache on `(mtimeMs, size)`.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run test/search/contested.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 3: Commit**

```bash
git add test/search/contested.test.ts
git commit -m "test(search): pin contested cache invalidation on log mtime

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire into `HybridHit`, `vaultSearch`, and the tool description

**Files:**
- Modify: `src/search/hybrid.ts` (the `HybridHit` interface, ~line 39)
- Modify: `src/tools/search.ts` (enrichment loop ~line 174; `vault_search` description ~line 281)
- Test: `test/tools/search.test.ts` (e2e additions)

- [ ] **Step 1: Write the failing e2e tests**

In `test/tools/search.test.ts`, add imports at the top:

```ts
import { addTension, tensionsPath } from "../../src/curation/tension.js";
import { clearContestedCache } from "../../src/search/contested.js";
import { rmSync } from "node:fs";
```

(Merge into the existing `node:fs` import if one exists.) Also extend the file's vitest import — it currently lacks `afterEach` and vitest globals are NOT enabled in this repo:

```ts
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
```

Then add the following describe block **nested inside `describe("search tools", ...)`** (the outer block at the top of the file, whose `beforeAll` builds `vault` from the sample fixture — the fixture paths below refer to that vault). Do not place it at top level (`vault` would be out of scope) or inside the current-source describe:

```ts
  describe("contested annotations", () => {
    afterEach(() => {
      rmSync(tensionsPath(vault), { force: true });
      clearContestedCache();
    });

    it("annotates a hit involved in an unresolved tension", async () => {
      await addTension(vault, {
        title: "pricing feud",
        kind: "factual",
        sourceA: "pricing/helios-consumption-pricing.md",
        sourceB: "competitive-intel/vega-insight-positioning.md",
        claimA: "credits are consumption-priced",
        claimB: "Vega undercuts on flat pricing",
        loggedBy: "test",
      });
      const result = await vaultSearch(vault, {
        query: "Helios compute credit consumption pricing",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const hit = result.value.hits.find(
        (h) => h.path === "pricing/helios-consumption-pricing.md",
      );
      expect(hit?.contested?.[0]).toMatchObject({
        counterpart: "competitive-intel/vega-insight-positioning.md",
        claimSelf: "credits are consumption-priced",
        claimOther: "Vega undercuts on flat pricing",
        kind: "factual",
      });
      expect(hit?.contestedCount).toBe(1);
    });

    it("leaves hits untouched when no tensions exist (fields absent, not empty)", async () => {
      const result = await vaultSearch(vault, { query: "pricing" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const hit of result.value.hits) {
        expect(hit.contested).toBeUndefined();
        expect(hit.contestedCount).toBeUndefined();
      }
    });
  });
```

- [ ] **Step 2: Run to verify the first test fails**

Run: `npx vitest run test/tools/search.test.ts -t "contested"`
Expected: FAIL — `contested` is undefined on the hit (and a TS error until Step 3 lands, which also counts as the failing state).

- [ ] **Step 3: Implement the wiring**

In `src/search/hybrid.ts`, add to the imports:

```ts
import type { ContestedTension } from "./contested.js";
```

and extend `HybridHit` after the `currentSource` line:

```ts
  contested?: ContestedTension[]; // unresolved tensions, capped at 3 — tool handler, not ranker
  contestedCount?: number; // TOTAL visible tensions (may exceed the cap)
```

In `src/tools/search.ts`, add to the imports:

```ts
import { contestedFor } from "../search/contested.js";
```

and extend the enrichment loop (keep the existing comment block; append to it):

```ts
    // Contested post-join (same pass): surface unresolved tensions inline.
    // The feud benchmark measured this shape — inline beats a dedicated tool
    // the agent must choose to call. Advisory only; never a score input.
    for (const hit of permitted) {
      const cs = resolveCurrentSource(db, hit.path, access);
      if (cs) hit.currentSource = cs;
      const ct = contestedFor(vaultRoot, db, hit.path, access);
      if (ct) {
        hit.contested = ct.contested;
        hit.contestedCount = ct.contestedCount;
      }
    }
```

In the `vault_search` tool definition, extend the description string:

```ts
    description:
      "Hybrid search across the vault: BM25 lexical ranking combined with " +
      "vector semantic similarity. Returns ranked documents with snippets. " +
      "Falls back to lexical-only ranking if embeddings are unavailable. " +
      "Hits may carry `contested`: unresolved recorded tensions involving " +
      "the document, with both claims shown (`claimSelf`/`claimOther`); " +
      "`contestedCount` gives the total when more than 3 exist.",
```

- [ ] **Step 4: Run the new tests, then both affected files**

Run: `npx vitest run test/tools/search.test.ts test/search/contested.test.ts`
Expected: PASS, no regressions in the existing search tests.

- [ ] **Step 5: Commit**

```bash
git add src/search/hybrid.ts src/tools/search.ts test/tools/search.test.ts
git commit -m "feat(search): surface unresolved tensions inline on vault_search hits

The 3b shape the feud benchmark earned: buried-side contradiction
surfacing goes ~8% -> ~46% when the tension rides the retrieval payload
instead of waiting behind a dedicated tool.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: RBAC end-to-end through `vaultSearch`

**Files:**
- Modify: `test/tools/search.test.ts`

The module tests (Task 3) prove the gate; this proves `vaultSearch` actually threads `access` through.

- [ ] **Step 1: Write the test**

Inside the `contested annotations` describe block:

```ts
    it("omits the annotation when the caller cannot read the counterpart", async () => {
      await addTension(vault, {
        title: "pricing feud",
        kind: "factual",
        sourceA: "pricing/helios-consumption-pricing.md",
        sourceB: "competitive-intel/vega-insight-positioning.md",
        claimA: "credits are consumption-priced",
        claimB: "Vega undercuts on flat pricing",
        loggedBy: "test",
      });
      const access: AccessContext = {
        user: "t",
        roleName: "analyst",
        role: { read: ["pricing"], write: [], promote: false, ratify: false },
      };
      const result = await vaultSearch(
        vault,
        { query: "Helios compute credit consumption pricing" },
        access,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const hit = result.value.hits.find(
        (h) => h.path === "pricing/helios-consumption-pricing.md",
      );
      expect(hit).toBeDefined(); // the hit itself is readable
      expect(hit?.contested).toBeUndefined(); // the annotation is not
    });
```

`AccessContext` is already imported in this file; if not, add `import type { AccessContext } from "../../src/access/rbac.js";`.

- [ ] **Step 2: Run the test file**

Run: `npx vitest run test/tools/search.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/tools/search.test.ts
git commit -m "test(search): contested RBAC omission holds end-to-end through vault_search

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: CHANGELOG, lint, full suite

**Files:**
- Modify: `CHANGELOG.md` (the `## [Unreleased]` section)

- [ ] **Step 1: Add the CHANGELOG entry**

Under `## [Unreleased]` → `### Added` (create the subsection if the current Unreleased block lacks it), add:

```markdown
- **`vault_search` hits carry unresolved tensions inline** (`contested` /
  `contestedCount`). Each annotation is the full two-sided marker — both
  claims, kind, counterpart, tension id — post-joined from
  `.daftari/tensions.md` in the same enrichment pass as `currentSource`,
  capped at 3 per hit with an honest total. RBAC-gated on the counterpart's
  collection (unreadable ⇒ omitted entirely, and excluded from the count).
  Measured motivation: the tension-graph feud benchmark (2026-07-04) — on
  feuds where retrieval buries one side, agents surface the contradiction
  ~8% baseline vs ~46% with the tension inline; the dedicated-tool shape
  loses to inline across all panel models. Tensions remain advisory and
  never affect ranking.
```

- [ ] **Step 2: Lint and typecheck**

Run: `npx biome check src/search/contested.ts test/search/contested.test.ts src/tools/search.ts src/search/hybrid.ts test/tools/search.test.ts && npm run build`
Expected: clean. Fix any complaints (import order is the usual one) rather than suppressing.

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: all green. Known flake: embedding-model load can intermittently fail search tests — rerun the failed file once before treating red as a regression.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for contested-inline vault_search annotations

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Done means

All 7 tasks committed on `mihir/tensions-inline-search`; `npm test` green; `npm run build` clean; `npx biome check src test` clean. Then: push, PR against `main` titled "feat(search): tensions inline in vault_search (benchmark 3b shape)", body linking the spec and the benchmark results branch.
