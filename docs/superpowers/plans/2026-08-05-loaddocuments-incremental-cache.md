# `loadDocuments` Incremental Stat Cache — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Memoize `loadDocuments(vaultRoot)` so it re-reads and re-parses only the vault files that changed since the last call, while preserving byte-freshness and the exact current contract.

**Architecture:** Keep disk as the source of truth. On each call, compute a cheap `path → {mtimeMs, size}` fingerprint (glob + `stat`), diff it against a per-vault cache, reuse unchanged parsed `LoadedDoc`s, re-read+parse only changed/new files, drop vanished ones. Concurrent calls share one in-flight refresh; a 60s idle timer drops the whole per-vault cache to bound sustained memory. `loadDocumentsAt` (git-history) is untouched.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `node:fs/promises` `stat`, existing `listFiles`/`readFile`/`resolveVaultPath`/`parseDocument`, vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-08-05-loaddocuments-incremental-cache-design.md`

---

## File structure

- **Modify:** `src/curation/vault-docs.ts` — replace the body of `loadDocuments` with a cache-backed implementation; add module-private cache state, a `refresh` helper, an idle timer, a `docCacheTestHooks` seam, and an exported `resetDocumentCache()`. The link-resolution helpers in this file (`extractLinks`, `resolveLink`, `buildPathIndexes`, `outgoingLinkTargets`) are unrelated and stay as-is.
- **Create:** `test/curation/vault-docs-cache.test.ts` — the cache's behavioural tests. (No dedicated `vault-docs` test file exists today; `loadDocuments` is exercised indirectly by `lint.test.ts` / `tension-blast.test.ts`, which must keep passing.)

**Non-goals (do not do):** no change to `loadDocuments`' public signature, no change to any caller, no touch to `src/asof/snapshot.ts::loadDocumentsAt`, no new config knob, no LRU/byte-budget, no SQLite-index serving.

---

## Task 1: Cache core — fingerprint, diff, per-file reuse

**Files:**
- Modify: `src/curation/vault-docs.ts:1-50` (imports + `loadDocuments`)
- Test: `test/curation/vault-docs-cache.test.ts` (create)

- [ ] **Step 1: Write the failing test — cold parity + warm reuse**

Create `test/curation/vault-docs-cache.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  docCacheTestHooks,
  loadDocuments,
  resetDocumentCache,
} from "../../src/curation/vault-docs.js";
import { parseDocument } from "../../src/frontmatter/parser.js";

let vault: string;

function writeDoc(rel: string, body: string): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body, "utf-8");
}

const DOC = (title: string) => `---\ntitle: ${title}\nupdated: 2026-01-01\nstatus: canonical\nconfidence: high\ncollection: notes\ndomain: accumulation\n---\nbody of ${title}\n`;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-doccache-"));
  resetDocumentCache();
  // Route parsing through the hook so tests can count parse calls.
  docCacheTestHooks.parseFn = parseDocument;
  docCacheTestHooks.idleMs = 60_000;
});
afterEach(() => {
  resetDocumentCache();
  docCacheTestHooks.parseFn = parseDocument;
  docCacheTestHooks.idleMs = 60_000;
  vi.restoreAllMocks();
  rmSync(vault, { recursive: true, force: true });
});

describe("loadDocuments cache", () => {
  it("cold call returns all docs, sorted by path", async () => {
    writeDoc("b.md", DOC("B"));
    writeDoc("a.md", DOC("A"));
    const r = await loadDocuments(vault);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((d) => d.path)).toEqual(["a.md", "b.md"]);
    expect(r.value[0]?.frontmatter.title).toBe("A");
  });

  it("warm call with no changes re-parses nothing", async () => {
    writeDoc("a.md", DOC("A"));
    writeDoc("b.md", DOC("B"));
    await loadDocuments(vault); // cold: parses both
    const spy = vi.fn(parseDocument);
    docCacheTestHooks.parseFn = spy;
    const r = await loadDocuments(vault);
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(0);
    if (r.ok) expect(r.value.map((d) => d.path)).toEqual(["a.md", "b.md"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/curation/vault-docs-cache.test.ts`
Expected: FAIL — `docCacheTestHooks` / `resetDocumentCache` are not exported.

- [ ] **Step 3: Implement the cache core**

Edit `src/curation/vault-docs.ts`. Add to the imports at the top:

```ts
import { stat } from "node:fs/promises";
```

Replace the existing `loadDocuments` function (lines ~27-50) with:

```ts
const DEFAULT_IDLE_MS = 60_000;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  doc: LoadedDoc;
}

interface VaultCache {
  entries: Map<string, CacheEntry>;
  inflight: Promise<Result<LoadedDoc[], Error>> | null;
  idleTimer: NodeJS.Timeout | null;
}

const caches = new Map<string, VaultCache>();

// Test seams (mirrors watcher.ts's injectable hooks). Production defaults; a
// test swaps these to count parses, inject stat results, or shrink the idle
// window. Never mutated by production code.
export const docCacheTestHooks = {
  idleMs: DEFAULT_IDLE_MS,
  statFn: async (absPath: string): Promise<{ mtimeMs: number; size: number }> => {
    const s = await stat(absPath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  },
  parseFn: parseDocument,
};

// Drops every cached vault (and its idle timers). Test-only; production relies
// on idle-eviction. Exported so a test's afterEach can guarantee isolation.
export function resetDocumentCache(): void {
  for (const c of caches.values()) {
    if (c.idleTimer) clearTimeout(c.idleTimer);
  }
  caches.clear();
}

function getCache(vaultRoot: string): VaultCache {
  let c = caches.get(vaultRoot);
  if (!c) {
    c = { entries: new Map(), inflight: null, idleTimer: null };
    caches.set(vaultRoot, c);
  }
  return c;
}

// Re-reads only what changed. Byte-freshness comes from the {mtimeMs,size}
// fingerprint: any content change moves at least one of them (the sole
// accepted miss is a same-mtime-tick edit that also preserves byte length).
async function refresh(vaultRoot: string, c: VaultCache): Promise<Result<LoadedDoc[], Error>> {
  const list = await listFiles(vaultRoot);
  if (!list.ok) return list;

  // Fingerprint pass: resolve + stat every listed path in parallel. stat holds
  // no file descriptor, so a wide Promise.all is safe on large vaults. A
  // resolve or stat failure yields a null fingerprint => the path is treated as
  // changed (re-read attempt below, which then skips on its own failure).
  const probed = await Promise.all(
    list.value.map(async (relPath) => {
      const resolved = resolveVaultPath(vaultRoot, relPath);
      if (!resolved.ok) return { relPath, absPath: null, fp: null };
      try {
        const fp = await docCacheTestHooks.statFn(resolved.value.absPath);
        return { relPath, absPath: resolved.value.absPath, fp };
      } catch {
        return { relPath, absPath: resolved.value.absPath, fp: null };
      }
    }),
  );

  const nextEntries = new Map<string, CacheEntry>();
  const docs: LoadedDoc[] = [];

  for (const { relPath, absPath, fp } of probed) {
    if (fp) {
      const prior = c.entries.get(relPath);
      if (prior && prior.mtimeMs === fp.mtimeMs && prior.size === fp.size) {
        nextEntries.set(relPath, prior);
        docs.push(prior.doc);
        continue;
      }
    }
    // changed / new / unresolvable / un-stattable: re-read + parse, skipping on
    // any failure exactly as the pre-cache loadDocuments did (never cached).
    if (!absPath) continue;
    const file = await readFile(absPath);
    if (!file.ok) continue;
    const parsed = docCacheTestHooks.parseFn(file.value);
    if (!parsed.ok) continue;
    const doc: LoadedDoc = {
      path: relPath,
      frontmatter: parsed.value.frontmatter,
      content: parsed.value.content,
      validation: parsed.value.validation,
    };
    if (fp) nextEntries.set(relPath, { mtimeMs: fp.mtimeMs, size: fp.size, doc });
    docs.push(doc);
  }

  c.entries = nextEntries;
  return ok(docs);
}

// Loads every markdown file under the vault root as frontmatter + body. Backed
// by a per-vault incremental cache: only files whose {mtimeMs,size} changed
// since the last call are re-read and re-parsed. Byte-fresh and full-fidelity —
// disk stays the source of truth. Files that fail to resolve, read, or parse
// are silently skipped, so one malformed file never crashes the surface.
export async function loadDocuments(vaultRoot: string): Promise<Result<LoadedDoc[], Error>> {
  const c = getCache(vaultRoot);
  return refresh(vaultRoot, c);
}
```

Leave `parseDocument`, `listFiles`, `readFile`, `resolveVaultPath`, and the `LoadedDoc` interface imports/definitions in place — they are still used.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/curation/vault-docs-cache.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/curation/vault-docs.ts test/curation/vault-docs-cache.test.ts
git commit -m "feat(curation): incremental stat cache for loadDocuments (core)"
```

---

## Task 2: Incremental invalidation — mtime and size

**Files:**
- Test: `test/curation/vault-docs-cache.test.ts`

- [ ] **Step 1: Write the failing tests**

Add inside `describe("loadDocuments cache", ...)`:

```ts
it("re-parses only the file whose mtime changed", async () => {
  writeDoc("a.md", DOC("A"));
  writeDoc("b.md", DOC("B"));
  await loadDocuments(vault);
  const spy = vi.fn(parseDocument);
  docCacheTestHooks.parseFn = spy;
  // Bump only a.md's mtime by injecting a newer fingerprint for it.
  const base = docCacheTestHooks.statFn;
  docCacheTestHooks.statFn = async (p) => {
    const fp = await base(p);
    return p.endsWith("/a.md") ? { ...fp, mtimeMs: fp.mtimeMs + 1000 } : fp;
  };
  const r = await loadDocuments(vault);
  expect(r.ok).toBe(true);
  expect(spy).toHaveBeenCalledTimes(1); // only a.md
});

it("invalidates on a size change within the same mtime tick", async () => {
  writeDoc("a.md", DOC("A"));
  await loadDocuments(vault);
  const spy = vi.fn(parseDocument);
  docCacheTestHooks.parseFn = spy;
  const base = docCacheTestHooks.statFn;
  docCacheTestHooks.statFn = async (p) => {
    const fp = await base(p);
    return { ...fp, size: fp.size + 1 }; // same mtime, different length
  };
  await loadDocuments(vault);
  expect(spy).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run to verify they pass (Task 1 impl already satisfies them)**

Run: `npx vitest run test/curation/vault-docs-cache.test.ts`
Expected: PASS (4 tests). If either fails, the fingerprint comparison in `refresh` is wrong — fix the `mtimeMs`/`size` equality check, do not weaken the test.

- [ ] **Step 3: Commit**

```bash
git add test/curation/vault-docs-cache.test.ts
git commit -m "test(curation): mtime + size invalidation for loadDocuments cache"
```

---

## Task 3: Additions and deletions

**Files:**
- Test: `test/curation/vault-docs-cache.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
it("reflects a newly added file without re-parsing untouched ones", async () => {
  writeDoc("a.md", DOC("A"));
  await loadDocuments(vault);
  const spy = vi.fn(parseDocument);
  docCacheTestHooks.parseFn = spy;
  writeDoc("c.md", DOC("C"));
  const r = await loadDocuments(vault);
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.map((d) => d.path)).toEqual(["a.md", "c.md"]);
  expect(spy).toHaveBeenCalledTimes(1); // only c.md
});

it("drops a deleted file from the result and the cache", async () => {
  writeDoc("a.md", DOC("A"));
  writeDoc("b.md", DOC("B"));
  await loadDocuments(vault);
  rmSync(join(vault, "b.md"));
  const r = await loadDocuments(vault);
  expect(r.ok).toBe(true);
  if (r.ok) expect(r.value.map((d) => d.path)).toEqual(["a.md"]);
});
```

- [ ] **Step 2: Run to verify they pass**

Run: `npx vitest run test/curation/vault-docs-cache.test.ts`
Expected: PASS (6 tests). Additions/removals are structural in `listFiles`, and `nextEntries` is rebuilt each call, so pruning is automatic.

- [ ] **Step 3: Commit**

```bash
git add test/curation/vault-docs-cache.test.ts
git commit -m "test(curation): add/remove handling for loadDocuments cache"
```

---

## Task 4: Malformed / unresolvable files are skipped, not cached

**Files:**
- Test: `test/curation/vault-docs-cache.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("skips a malformed file and retries it on the next call once fixed", async () => {
  writeDoc("good.md", DOC("Good"));
  writeDoc("bad.md", "---\n: not: valid: yaml\n---\n"); // parse fails
  const r1 = await loadDocuments(vault);
  expect(r1.ok).toBe(true);
  if (r1.ok) expect(r1.value.map((d) => d.path)).toEqual(["good.md"]);
  // Fix bad.md; it must appear on the next call (was never cached).
  writeDoc("bad.md", DOC("Bad"));
  const r2 = await loadDocuments(vault);
  expect(r2.ok).toBe(true);
  if (r2.ok) expect(r2.value.map((d) => d.path)).toEqual(["bad.md", "good.md"]);
});
```

- [ ] **Step 2: Run to verify it passes**

Run: `npx vitest run test/curation/vault-docs-cache.test.ts`
Expected: PASS (7 tests). A parse failure `continue`s without writing `nextEntries`, so the file is retried.

- [ ] **Step 3: Commit**

```bash
git add test/curation/vault-docs-cache.test.ts
git commit -m "test(curation): malformed files skipped and retried, not cached"
```

---

## Task 5: Single-flight concurrent refresh

**Files:**
- Modify: `src/curation/vault-docs.ts` (`loadDocuments`)
- Test: `test/curation/vault-docs-cache.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("collapses concurrent calls into one fingerprint+parse pass", async () => {
  writeDoc("a.md", DOC("A"));
  writeDoc("b.md", DOC("B"));
  let statCalls = 0;
  const base = docCacheTestHooks.statFn;
  docCacheTestHooks.statFn = async (p) => {
    statCalls++;
    return base(p);
  };
  const [r1, r2] = await Promise.all([loadDocuments(vault), loadDocuments(vault)]);
  expect(r1.ok && r2.ok).toBe(true);
  // Two files, ONE fingerprint pass shared by both callers => 2 stat calls, not 4.
  expect(statCalls).toBe(2);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/curation/vault-docs-cache.test.ts -t "concurrent"`
Expected: FAIL — `statCalls` is 4 (each call runs its own refresh).

- [ ] **Step 3: Add single-flight to `loadDocuments`**

Replace the `loadDocuments` body with:

```ts
export async function loadDocuments(vaultRoot: string): Promise<Result<LoadedDoc[], Error>> {
  const c = getCache(vaultRoot);
  if (c.inflight) return c.inflight;
  c.inflight = refresh(vaultRoot, c);
  try {
    return await c.inflight;
  } finally {
    c.inflight = null;
  }
}
```

- [ ] **Step 4: Run to verify it passes (and no regressions)**

Run: `npx vitest run test/curation/vault-docs-cache.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/curation/vault-docs.ts test/curation/vault-docs-cache.test.ts
git commit -m "feat(curation): single-flight concurrent loadDocuments refresh"
```

---

## Task 6: Idle-eviction

**Files:**
- Modify: `src/curation/vault-docs.ts` (`loadDocuments`, add `armIdleTimer`)
- Test: `test/curation/vault-docs-cache.test.ts`

- [ ] **Step 1: Write the failing test**

Use vitest fake timers so the idle expiry is deterministic (real short timers flake on loaded CI runners). `stat`/`readFile` are libuv-backed, not `setTimeout`-backed, so `await loadDocuments` still resolves normally under fake timers; only `armIdleTimer`'s `setTimeout` is faked, and `advanceTimersByTime` fires it synchronously.

```ts
it("drops the whole cache after the idle window, forcing a cold rebuild", async () => {
  vi.useFakeTimers();
  try {
    docCacheTestHooks.idleMs = 1000;
    writeDoc("a.md", DOC("A"));
    await loadDocuments(vault); // arms a 1000ms idle timer (faked)
    vi.advanceTimersByTime(1001); // fire it -> caches.delete(vault)
    const spy = vi.fn(parseDocument);
    docCacheTestHooks.parseFn = spy;
    await loadDocuments(vault); // cache was dropped => cold rebuild
    expect(spy).toHaveBeenCalledTimes(1); // re-parsed a.md from scratch
  } finally {
    vi.useRealTimers();
  }
});
```

Note: the `afterEach` already calls `vi.restoreAllMocks()`; the `finally` restores real timers even if an assertion throws.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/curation/vault-docs-cache.test.ts -t "idle"`
Expected: FAIL — the second call re-uses the cache (0 parses) because nothing evicts it.

- [ ] **Step 3: Add the idle timer**

Add this helper near `getCache` in `src/curation/vault-docs.ts`:

```ts
function armIdleTimer(vaultRoot: string, c: VaultCache): void {
  if (c.idleTimer) clearTimeout(c.idleTimer);
  c.idleTimer = setTimeout(() => {
    caches.delete(vaultRoot);
  }, docCacheTestHooks.idleMs);
  // Never keep the process alive just to expire a cache.
  c.idleTimer.unref?.();
}
```

Update `loadDocuments` to arm it after each call:

```ts
export async function loadDocuments(vaultRoot: string): Promise<Result<LoadedDoc[], Error>> {
  const c = getCache(vaultRoot);
  if (c.inflight) return c.inflight;
  c.inflight = refresh(vaultRoot, c);
  try {
    return await c.inflight;
  } finally {
    c.inflight = null;
    armIdleTimer(vaultRoot, c);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/curation/vault-docs-cache.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/curation/vault-docs.ts test/curation/vault-docs-cache.test.ts
git commit -m "feat(curation): idle-eviction (60s) for the loadDocuments cache"
```

---

## Task 7: Regression, lint, typecheck, final verify

**Files:** none (verification only)

- [ ] **Step 1: Run every suite that exercises `loadDocuments` callers**

Run: `npx vitest run test/curation test/consolidate test/tools/canon test/tools/tier1 test/tools/tier2 test/asof`
Expected: PASS. These cover `lint`, `tension-blast`, `shadow`, `consolidate`, `canon`, `tier1/2`, `staged-actions`, and `asof` (which uses the untouched `loadDocumentsAt`). No behavioural change is expected — the cache is byte-fresh and order-preserving.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no output (clean). If `docCacheTestHooks.statFn`'s return type mismatches, align it to `{ mtimeMs: number; size: number }`.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: clean (pre-existing `any` warnings in unrelated test files are acceptable; no new errors in `vault-docs.ts` / `vault-docs-cache.test.ts`). If Biome reports formatting, run `npx biome check --write src/curation/vault-docs.ts test/curation/vault-docs-cache.test.ts`.

- [ ] **Step 4: Full suite once**

Run: `npx vitest run`
Expected: PASS. Watch for any suite that asserted on `loadDocuments` re-reading disk mid-test without going through `loadDocuments` again — none is expected, but if one appears it is a real test-isolation issue to fix (add `resetDocumentCache()` in that suite's setup), not a reason to weaken the cache.

- [ ] **Step 5: Final commit (if lint/format applied any changes)**

```bash
git add -A
git commit -m "chore(curation): lint/format for loadDocuments cache" || echo "nothing to commit"
```

---

## Definition of done

- `loadDocuments` is cache-backed, byte-fresh, order-preserving, signature-unchanged.
- 9 new cache tests pass; all existing suites pass; tsc + Biome clean.
- `loadDocumentsAt` and every caller are untouched.
- Cache drops after 60s idle; concurrent calls single-flight.
