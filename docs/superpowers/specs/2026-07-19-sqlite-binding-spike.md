# SQLite binding spike: better-sqlite3 → node:sqlite (#72)

**Status:** decision document — no migration in this change.
**Date:** 2026-07-19. Spike environment: Node v22.22.2, better-sqlite3 (SQLite 3.x), sqlite-vec 0.1.9, node:sqlite (SQLite 3.51.2).

## Decision criterion (from the issue, verbatim)

> If the API translation cost is non-trivial AND the binding switch produces
> no other measurable benefit (artifact size, perf, install reliability),
> recommend Option C — stay on better-sqlite3.

## Verdict

**Option A (node:sqlite) is technically viable today — every gate passes,
including the issue's "single biggest unknown" — but it is blocked by the
engines floor, not by API translation.** daftari declares `engines: node
>=20`; `node:sqlite` does not exist before Node 22.5 and is experimental
(startup warning, API subject to change) until Node 24.

**Recommendation: migrate at the next engines-floor bump to Node >=24
(realistically the next major), Option C until then.** The translation cost
is small and bounded (measured below), the benefit is real (28 MB dependency,
a 10-binary prebuild matrix, and a loader patch all deleted), and nothing
about waiting makes the migration harder. Do not migrate onto experimental
node:sqlite under a `>=22.5` floor: every server start would print an
ExperimentalWarning, and the API has no stability promise there.

## Empirical results (all PASS, this container)

| Gate | Result |
| --- | --- |
| Open + `PRAGMA journal_mode = WAL` via `exec` | works (`:memory:` reports `memory`, as SQLite defines) |
| FTS5 external-content table + triggers + `snippet()` | works — Node's bundled SQLite (3.51.2) compiles FTS5 |
| **sqlite-vec extension load** | **works — `sqliteVec.load(db)` duck-types on `.loadExtension`, which `DatabaseSync` exposes when constructed with `allowExtension: true`** |
| vec0 virtual table ABI smoke (insert + KNN `MATCH`) | works — 1 vector round-trips, same smoke daftari runs at open |
| Blob round-trip | works — returns `Uint8Array` (not `Buffer`); values intact |
| Transactions (manual `BEGIN`/`COMMIT`/`ROLLBACK`) | works |
| `run()` result shape | `{ changes, lastInsertRowid }` present, same fields daftari reads |
| Micro-benchmark (50k prepared inserts in one tx; 50k point reads) | node:sqlite 108 ms / 130 ms vs better-sqlite3 77 ms / 99 ms — **~30–40 % slower on raw statement throughput** |

The perf gap is real but immaterial for daftari: the hot cost in reindex is
embedding, not SQLite; per-request tool queries are single-digit-millisecond
either way. It is worth re-measuring at migration time on FTS5 MATCH and
vec0 KNN specifically.

## API translation inventory (measured, whole `src/`)

| better-sqlite3 API | Call sites | node:sqlite equivalent |
| --- | --- | --- |
| `prepare()` (`run`/`get`/`all`) | 58 | identical shape on `StatementSync` |
| `exec()` | 18 | identical |
| `transaction(fn)` | 8 | **no helper — needs a ~10-line manual wrapper** (`BEGIN` … `COMMIT`/`ROLLBACK` in try/catch). All 8 daftari sites are flat (no nesting, no savepoints), so one shared helper covers them |
| `pragma()` | 2 | `exec("PRAGMA …")` / `prepare("PRAGMA …").get()` |
| `pluck`/`raw`/`expand`/`iterate`/`backup`/`serialize` | **0** | n/a — daftari never left the basic surface |
| `Database` type (`IndexDb = Database.Database`) | 14 files import the alias | re-point the alias at `DatabaseSync`; call sites are shape-compatible |
| Direct `better-sqlite3` imports | 3 files (`storage/index-db.ts`, `access/locks.ts`, `curation/staged-actions.ts`) | swap constructor: `new DatabaseSync(path, { allowExtension: true })` |

Two behavioral deltas to handle at call sites:

1. **Blob reads return `Uint8Array`, not `Buffer`.** `blobToEmbedding`'s
   implementation (`copy.set(blob)` + `blob.length`) already works on
   `Uint8Array` unchanged — only its parameter type annotation moves. Audit
   the other ~7 `Buffer`-typed read sites the same way; none observed to use
   Buffer-only methods.
2. **`allowExtension: true` must be passed at construction** for the vec
   load; better-sqlite3 allowed it per-call. One line in each of the three
   openers.

## Measurable benefit (the strategic case, confirmed)

- `node_modules/better-sqlite3` is **28 MB** installed; it disappears
  entirely, along with npm-install native-module failure modes.
- `scripts/pack-mcpb.mjs` drops the **10-entry `TARGETS` matrix** (4 Node +
  6 Electron ABIs), the per-ABI tarball fetch, and the
  `lib/database.js` loader patch — the exact surface #72 documents as the
  recurring cost (v1.12.0→v1.12.4 was five patch releases chasing it).
- Electron ABI tracking ends as a category: Electron ≥ 37 bundles Node ≥ 22
  where `node:sqlite` ships in the runtime itself. (Verify the specific
  Claude Desktop Electron → Node mapping at migration time.)

## What blocks it today

- `engines: node >=20`. Node 20/21 users lose SQLite entirely under Option
  A. The engines floor is a product decision, not a spike finding.
- On Node 22.5–23: works (this spike ran there) but prints
  `ExperimentalWarning: SQLite is an experimental feature` on every server
  start, and Node reserves the right to change the API.

## Migration checklist (when the floor moves)

1. Bump `engines` to `>=24` (or `>=22.5` accepting the warning — not
   recommended).
2. Re-point `IndexDb` at `DatabaseSync`; swap the 3 constructors with
   `allowExtension: true`.
3. Add the shared `withTransaction(db, fn)` helper; convert the 8 sites.
4. Convert 2 `pragma()` sites; retype blob params `Buffer → Uint8Array`.
5. Delete the `TARGETS` matrix + loader patch from `pack-mcpb.mjs`; drop the
   `better-sqlite3` dependency.
6. Re-run this spike's gates as tests (vec load, vec0 smoke, FTS5 snippet)
   plus the full suite; re-benchmark FTS5 MATCH and vec0 KNN.

## Out of scope (per the issue)

Engine switches (DuckDB — #73, closed premature), replacing sqlite-vec,
and any async refactor. Option B (libsql/@vscode/sqlite3) was not spiked:
it deletes the ABI matrix but keeps a third-party native dep and a prebuild
pipeline — strictly weaker than Option A once the engines floor moves, and
no stronger than Option C before then.
