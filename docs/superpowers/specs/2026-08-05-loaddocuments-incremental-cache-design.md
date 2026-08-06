# `loadDocuments` Incremental Stat Cache — Design Spec

**Status:** draft — awaiting Mihir approval
**Origin:** Fable security/perf/integration audit of daftari 3.0.0, perf finding #4. This spec covers only #4; the other audit fixes shipped independently (#348–#354).
**Branch:** `docs/loaddocuments-cache-spec` (this doc). Implementation lands on its own branch off `main`.

---

## 1. Problem

`loadDocuments(vaultRoot)` (`src/curation/vault-docs.ts:30`) reads and YAML-parses **every** markdown file under the vault on **every** call: a `listFiles` glob, then a serial `readFile` + `parseDocument` per file. It is invoked at request time by a large fan of MCP-exposed and CLI curation surfaces — `vault_lint` (`lint.ts:230`), `vault_tier1` (`tier1.ts:128`), `vault_tier2` (`tier2.ts:83`), `vault_tension_blast` (`tension-blast.ts:240`), `court/docket.ts:92`, `sleep/cycle.ts:83`, `canon`, `interview`, `witness/track-record`, `consolidate/index.ts:256`, `staged-actions.ts:421`, and `shadow.ts:173`.

On a multi-thousand-file vault every such call pays thousands of file reads plus YAML parses. In a long-lived `serve` or stdio session that repeats per curation request even when the vault has not changed between calls. The read+parse pass is the expensive part; nothing memoizes it.

## 2. Goals / non-goals (explicit YAGNI)

**Goal:** collapse the repeated read+parse work to **once per change** while preserving today's exact contract: byte-fresh reads and full-fidelity `LoadedDoc` (full `Frontmatter` + `ValidationReport`).

**Non-goals:**
- **Not** serving curation from the SQLite index. The index stores only decomposed frontmatter columns and no `ValidationReport`; serving from it would be lossy and would couple curation freshness to the watcher's debounce. Rejected during brainstorming in favour of keeping disk as source of truth (approach "A").
- **Not** changing the `loadDocuments` signature or any of its ~14 callers.
- **Not** touching `loadDocumentsAt(vaultRoot, commit)` (`src/asof/snapshot.ts`) — it reads a **past git commit**, a different source with no live-disk fingerprint. It is out of scope and uncached.
- **Not** a new user-facing config knob. The cache is transparent and always on.
- **Not** an LRU / byte-budget eviction scheme (see §5 for why idle-eviction is used instead).

## 3. Decisions (recommended — flag any you reject)

- **D1 — Keep disk as source of truth; memoize with a stat fingerprint ("A-stat").** Each call recomputes a cheap `path → {mtime, size}` fingerprint and reuses the cached parse when it matches. Byte-freshness falls out of `mtime`/`size` rather than out of any write-site bookkeeping.
- **D2 — Incremental, per-file reuse.** The cache keys parsed docs by `relPath`; only files whose `{mtime, size}` changed (plus new files) are re-read and re-parsed. Unchanged files reuse their cached `LoadedDoc`; vanished files are dropped. The "something changed" path is therefore O(changed), not O(all).
- **D3 — `{mtime, size}` as the change discriminator.** `mtime` alone can miss two edits inside one filesystem mtime tick (second-granularity on some filesystems); pairing it with `size` closes the common case of a same-tick edit that changes length. This is a best-effort freshness signal, consistent with what the reindex freshness manifest already trusts.
- **D4 — Idle-eviction, no size cap.** No LRU, no byte budget. A per-vault idle timer (default **60s**, no `loadDocuments` call) drops the **entire** vault cache entry, releasing its resident docs. Rationale in §5.
- **D5 — Single-flight refresh.** Concurrent `loadDocuments` calls for the same vault share one in-progress refresh rather than each walking the vault.

## 4. Design

### 4.1 The unit

A per-vault incremental document cache, private to `src/curation/vault-docs.ts` (or a small sibling module it owns), behind the **unchanged** `loadDocuments` signature. Module-level state:

```
type CacheEntry = { mtimeMs: number; size: number; doc: LoadedDoc };

type VaultCache = {
  entries: Map<relPath, CacheEntry>;
  inflight: Promise<Result<LoadedDoc[], Error>> | null;
  idleTimer: NodeJS.Timeout | null;
};

const caches = new Map<string /* vaultRoot */, VaultCache>();
```

`vaultRoot` is used verbatim as the map key — callers already pass a resolved absolute path (`resolve(vaultArg)`), consistent with the rest of the codebase.

`relPath` for `CacheEntry` and the fingerprint is the **raw `listFiles` path** — the exact string stored as `LoadedDoc.path` today (`vault-docs.ts:43`), **not** `resolveVaultPath`'s canonical `relPath`. `loadDocuments` computes both and they can differ under a symlinked vault root; using the `listFiles` path uniformly (as key, as `stat` target, and as `LoadedDoc.path`) keeps the cache key, the fingerprint, and the returned document consistent and preserves today's output exactly.

### 4.2 Algorithm (one `loadDocuments` call)

1. **Single-flight:** if `cache.inflight` is set, `await` and return it.
2. **Fingerprint:** `listFiles(vaultRoot)` → sorted relPaths; `stat` each (bounded concurrency) → `path → {mtimeMs, size}`. A `stat` failure for a path treats it as changed/absent (never served from cache) — fail toward a fresh read, never a phantom.
3. **Diff & reuse:** for each current path, if a cache entry exists with matching `mtimeMs` **and** `size`, reuse its `LoadedDoc`; else `readFile` + `parseDocument` and build a fresh entry. As today, a file that fails **any** of the three steps — `resolveVaultPath` (`vault-docs.ts:37`), `readFile` (`:39`), or `parseDocument` (`:41`) — is **silently skipped and not cached**, so a malformed or unresolvable file never crashes the surface, never poisons the cache, and is retried on the next call.
4. **Prune:** drop cache entries whose path is no longer in the current set.
5. **Assemble:** return `LoadedDoc[]` in `listFiles` (sorted) order — identical ordering to today.
6. **Bookkeeping:** replace `cache.entries` with the new map, clear `inflight`, reset the idle timer.

The `inflight` promise wraps steps 2–6 so concurrent callers converge.

### 4.3 Freshness & correctness

- **External edits** (editor, sync engine, scripted writer) and **daftari's own writes** both change the file's `mtimeMs`/`size` on disk; the next `loadDocuments` call re-fingerprints and re-reads that path. No dependency on the chokidar watcher, on the 500ms debounce, or on self-write registration.
- **Additions / deletions** change the path set from `listFiles`, so they are detected structurally.
- **Residual miss:** two writes to one file within a single mtime tick that also leave `size` unchanged. Accepted as best-effort — it matches the freshness guarantee the reindex manifest already relies on, and curation surfaces are advisory.
- **`loadDocumentsAt`** is untouched and never consults this cache.

### 4.4 Memory & idle-eviction

See §5.

### 4.5 Error handling

Unchanged from today: read/parse failures skip the file; a top-level `listFiles` failure returns `err(...)` exactly as now. Nothing in the cache path introduces a new throw. `stat` failures degrade to "treat as changed."

## 5. Memory posture

The cache holds one resident `LoadedDoc` (full body + frontmatter + validation report) per live vault file for the process lifetime. Today's code already materialises all of them **transiently** on each call; the cache converts that recurring transient peak into a **sustained** resident floor of roughly one vault's parsed docs.

This interacts with a known operational concern: **many daftari node processes may be running at once.** An unbounded, permanently-resident per-process cache would multiply that floor across every process, including the many that are idle at any given moment.

**Idle-eviction (D4)** is the mitigation. A per-vault timer, reset on every `loadDocuments` call, fires after 60s of inactivity and drops the whole vault entry. Idle processes therefore fall back to baseline memory; only actively-curating processes hold the resident set, and they are the ones getting the latency benefit. Chosen over LRU/byte-budget because a partial cap would cause re-parse churn on exactly the large vaults that need the cache most, whereas idle-drop bounds the **sustained** cost without bounding the **active** benefit — and it is a single timestamp + timer, not eviction machinery.

> Related, out of scope for this spec: the "many nodes spun up" symptom itself is being investigated as a **separate** task (candidate causes: multiple clients each spawning a stdio server, a re-spawn loop, or lock contention now partly addressed by #350/#351). This spec is memory-considerate but does not attempt to fix process proliferation.

## 6. Testing

- **Cold call** populates the cache and returns all docs (unchanged behaviour vs today).
- **Warm call, no change** returns the same docs and performs **zero** `parseDocument` calls — asserted via an injected parse counter / spy.
- **Incremental reuse:** touch one file (new mtime), assert exactly **one** re-parse and the rest reused.
- **Size-only change within a tick** (same mtime, different size) invalidates that file.
- **Addition** and **deletion** are reflected without re-parsing untouched files.
- **Malformed file** is skipped, not cached, and does not poison later calls.
- **Single-flight:** two concurrent calls trigger one fingerprint+parse pass.
- **Idle-eviction:** after the idle window the entry is dropped (next call is a cold rebuild). Use an injectable clock / short window in tests, mirroring the watcher suite's debounce-override seam.
- **`reset()`** test hook clears all caches between tests.

## 7. Interfaces & seams

- Public surface unchanged: `loadDocuments(vaultRoot): Promise<Result<LoadedDoc[], Error>>`.
- Test-only exports: `resetDocumentCache()` and an options seam for the idle window + a `statFn`/`parseFn` injection (mirroring `watcher.ts`'s `WatcherOptions` pattern) so tests run without real timers or spurious FS timing.
- Implementation note to resolve during planning: whether the glob layer can return `stats:true` in one pass (making the fingerprint nearly free) or whether a separate batched `stat` pass is needed. Either way the fingerprint is O(files) `stat`-cost, not O(files) read+parse-cost.

## 8. Rollout

Single PR, behaviour-preserving, auto-mergeable under the CI gate (e2e, regression, build 20/22). No migration, no config, no caller changes.
