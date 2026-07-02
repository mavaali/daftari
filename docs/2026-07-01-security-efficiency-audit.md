# Daftari v1.29.0 — Security & Efficiency Audit

**Date:** 2026-07-01
**Tree state:** `paper/draft-preserve-dont-resolve` at `8a13ee6`, v1.29.0 (source unchanged from `main`; only `docs/paper/*` differ)
**Scope:** targeted dual review of the runtime code — (1) security, (2) efficiency. ~23k LOC across `access`, `storage`/`search`, `tools`, `consolidate`, `frontmatter`/`hooks`, `lifecycle`, `utils`.
**Method:** static reading of source with file:line evidence for every claim. Five parallel reviewers, one per subsystem; the two highest-severity findings (S1, S2) were re-verified by hand against source. Labels: **CONFIRMED** = traced to an exploit/failure path in source; **PLAUSIBLE** = suspected, exploit path not fully closed. `npm test` / `npm run build` were **not** run this session (tree is on a docs branch); no green-suite claim is made here.

---

## Verdict

**Architecture is sound; two confirmed write-path ACL/locking bugs and one conditional ReDoS are worth fixing before any multi-user exposure. The product keystone holds under adversarial reading.**

- **Keystone verified.** Every LLM-output → write path was traced: there is **no** code path from a model completion to a value-mint, supersession, content-overwrite, or delete. The most a crafted note can drive is a `candidate` (k=0) `derives_from` edge or an advisory tension. "A tension may never masquerade as a supersession" survives adversarial reading (`src/consolidate/envelope.ts` whitelists exactly `edge-observe` / `edge-contest`).
- **No command injection.** `src/utils/git.ts` shells out via `execFile` with argument arrays and `--` guards; caller strings are `=`-joined into single argv elements.
- **No SQL injection.** Every query uses bound `?` params; dynamic `IN`-lists interpolate generated `?` marks only; FTS5 `MATCH` strings are sanitized to `[a-z0-9]`.
- **No YAML/deserialization RCE.** gray-matter + js-yaml 4 use the safe schema; prototype pollution via merge is not exploitable (own-property assignment only). Hook loading is config-gated, never document-gated.
- **Prior v1.19 findings:** S1 symlink escape **confirmed closed** (PR #142); staged-actions RBAC **confirmed intact**; the process-lock PID substring match (old S3) and lock-TTL-expiry (old S4) **remain open** (below).

---

## Part 1 — Security findings

### S1. Write-side ACL bypass via caller-declared `collection` — **HIGH × CONFIRMED**
`src/tools/write.ts:410-424` (same shape in `vault_merge`, `:1151`)

`vault_write`'s RBAC gate derives the collection from the caller-supplied `rawFrontmatter.collection` when it is a non-empty string, but the file is physically written to `resolveVaultPath(vaultRoot, path.value)` — the directory implied by `path.value`, not by the declared collection. The gate and the write disagree.

**Failure scenario.** Role `analyst` with `write: [competitive-intel]`, no write on `pricing`:
```
vault_write(path="pricing/leak.md", frontmatter={collection:"competitive-intel", ...})
```
Gate checks `canWrite(analyst, "competitive-intel")` → allowed; bytes land in `pricing/`. Without a `base_version` this also **overwrites** existing `pricing/*` docs. Read-side tools derive collection from on-disk frontmatter, so the smuggled doc is then mis-attributed on read as well.

**Fix.** Gate on the collection derived from the resolved target path's top-level directory, or require `frontmatter.collection` to equal it (Daftari's convention — cf. the schema description at `write.ts:1422`, "must match a top-level directory"). Apply to both `vault_write` and the `vault_merge` target branch.
**Status:** fix in flight (background task `task_e9dc360a`).

### S2. File write-lock keyed on the raw, un-canonicalized path — **HIGH × CONFIRMED**
`src/tools/write.ts:548` (→ `performWrite` `relPath: path.value`) → `:271` → `src/access/locks.ts:81`

The lock key is the raw caller string `path.value`. `a/b.md`, `./a/b.md`, `a//b.md`, and `a/./b.md` all resolve to the same file but produce **distinct** lock keys, so two concurrent writers acquire "the same file" → lost update, and the `base_version` optimistic-concurrency check is defeated (it is guarded by the same non-exclusive lock). This is the aliasing class #127/#128 were meant to close: the *identity* checks were canonicalized, the **lock key** was not — so that fix is only half-done. (Case-insensitive filesystems add `A/b.md` vs `a/b.md` as a second vector; no case/NFC normalization exists in the path layer.)

**Fix.** Have `resolveVaultPath` also return the canonical vault-relative path (`relative(realRoot, realTarget)`) and lock on that, not on `path.value`. Write the alias test first.
**Status:** fix in flight (background task `task_eb169e93`).

### S3. ReDoS via schema-extension `pattern` — **HIGH (conditional) × CONFIRMED-by-measurement**
`src/frontmatter/schema.ts:55`; pattern origin `src/utils/config.ts:278-291`

A config-declared `pattern` regex is compiled and `.test()`-ed against caller-supplied frontmatter on the write path (`write.ts:513`), with only a "does it compile" check — no linear-time guarantee. In a shared multi-author vault the input author ≠ the config author. Measured locally: `(a+)+$` against a 30-char input blocked the event loop for **~29 seconds** (40 chars ≈ hours). Single-threaded Node → full DoS; the write lock is held throughout. Conditional on the owner declaring a natural-looking-but-catastrophic regex (e.g. an email/URL validator), which no one hand-audits for backtracking. Read path is unaffected (extensions default empty on read).

**Fix.** Run pattern matching under a linear-time engine (`re2`) or bound it (length cap on the value + per-write regex-time budget); at minimum reject nested-quantifier patterns at config load.

### S4. `--budget` does not bound LLM spend — **HIGH × CONFIRMED**
`src/consolidate/index.ts:504, 574`

Both `runBirthLoop` and `runRevisionLoop` set `budgetRemaining: Number.POSITIVE_INFINITY`. `--budget` only caps queue *items* (`prioritize()`), not the ≤40 `completeJson` calls each birth item fans out to (20 neighbors × 2 orders, `birth.ts:230,243`). `daftari consolidate --budget 5` can still emit dozens of calls; a cold start compounded to ~1280 calls / ~$2.95 with no `--budget` able to stop it. The flag actively misleads.

**Fix.** Thread real remaining budget into `budgetRemaining` so the existing `birth.ts:243` guard (`llmCalls + 2 > budgetRemaining`) fires; or rename the flag to reflect that it is an item cap, and document `--max-births` / `BIRTH_TOP_K` as the real spend levers.

### S5. Consolidate shadow mode is OFF by default despite docs implying otherwise — **HIGH × CONFIRMED**
`src/utils/config.ts:124, 532`

`shadowMode` defaults `false` when there is no config file or `shadow_mode` is unset, yet HELP text and module comments (`index.ts:6-8,72-76`) frame shadow as "the calibration posture." A cron `daftari consolidate --mode both` on a vault whose config predates `shadow_mode` makes **real** edge-store writes (`edge-write.ts:66,79`), not journaled shadows.

**Fix.** Default `shadowMode` to `true` for the consolidate loop, or hard-refuse `--mode != scan` when `shadow_mode` is not explicitly set in config (force an opt-in to live writes).

### S6. `limit` truncation happens before ACL filtering — **MEDIUM × CONFIRMED (correctness, not disclosure)**
`src/search/hybrid.ts:317` (`hits.slice(0, opts.limit)`) vs ACL filter in `src/tools/search.ts:145`

Ranking cuts to `limit` hits, then the handler drops the ones the role can't read. Restricted-collection docs that ranked in the top-N consume slots and are silently discarded, so permitted results ranked just past the cut are never returned. Not a leak (title/snippet never returned; the coverage-add path *is* re-ACL'd at `:154`) — an under-return that worsens with more restricted collections.

**Fix.** Push `canRead` into ranking before the slice, or over-fetch (`limit × k`) and slice after ACL. (Folded into the E1 refactor task.)

### S7. `vault_merge` is not crash-atomic — **MEDIUM × CONFIRMED (acknowledged in-code)**
`src/tools/write.ts:1305-1329`

Merge writes up to three files then does one commit. A throw / disk-full / SIGTERM between writes leaves a partial supersession graph — target written but a source not yet superseded → two canonical docs. Note the process-lock takeover in `lifecycle/lock.ts` *sends* SIGTERM to a running instance, so this is reachable.

**Fix.** Snapshot the three files' prior bytes before the write loop and restore on any failure; or stage to temp and rename.

### S8. Write lock TTL (60s) never refreshes — **MEDIUM × CONFIRMED** (was v1.19 S4)
`src/access/locks.ts:20` + `src/tools/write.ts:271`

`acquireLock` stamps `expiresAt = now + 60s` once. `performWrite` then does fs write + `indexDocument` + `git commit` + provenance under that single lease. A slow hook or a `git commit` on a large repo can exceed 60s; the next acquirer runs `purgeExpired` and both write the same file.

**Fix.** Heartbeat-refresh during long steps, or hold an in-process mutex keyed on the canonical path (cross-process is already forbidden by the process lock).

### S9. Hooks run synchronously, in-process, with no timeout — **MEDIUM × CONFIRMED (trusted-code by design)**
`src/hooks/runner.ts:91` (and `:18`)

A loaded hook that infinite-loops or blocks on sync I/O wedges the server; the write lock is held throughout. Hooks are documented as trusted owner code (why this is MEDIUM), but nothing enforces the sync-only, fast contract.

**Fix.** Run hooks in a worker thread with a wall-clock deadline; abort the write with a synthetic issue on timeout.

### S10. Process-lock liveness is a `ps` substring match on the vault path — **LOW × PLAUSIBLE** (was v1.19 S3)
`src/lifecycle/lock.ts:86-98, 171`

Ownership is decided by `ps -o command=` containing `vaultRoot` as a substring. If the original daftari died and the PID was recycled to an unrelated process whose argv contains that path (e.g. `nvim /vault/notes.md`), `isDaftariProcess` returns true and the code SIGTERMs it. Low likelihood (PID recycle + path in argv).

**Fix.** Also require a daftari-specific marker in the command line (e.g. `--vault` immediately preceding the path, or the resolved entry-script path).

### S11. `ttl_days` unbounded at the tool layer — **LOW × CONFIRMED**
`src/tools/staged-actions.ts:120-126`

The tool accepts any finite `ttl_days`. `stageAction` rejects `<= 0` one layer down, but a huge positive (`1e12`) flows into `addDaysISO` → `"Invalid Date"` → `Date.parse` is `NaN` → the sweep's `NaN < now` is false → the staged action **never expires**, defeating the 14-day TTL cleanup.

**Fix.** Clamp at the tool boundary: `if (!Number.isFinite(ttl_days) || ttl_days <= 0 || ttl_days > 3650) return err(...)`.

### S12. `changedSince` omits the `--` separator before an interpolated ref — **LOW / latent × PLAUSIBLE**
`src/utils/git.ts:236`

`["diff", "--name-only", `${sinceCommit}..HEAD`]` has no `--` guard. Fed today only from internal state (`consolidate/index.ts:207`), so not agent-reachable — but it is the one git call in the file missing the separator; a future caller or poisoned state file makes it option-injection.

**Fix.** `["diff", "--name-only", sinceCommit, "--"]`, or validate the ref against `/^[0-9a-f]{7,40}$/`.

### S13. Prompt-injection → spurious edges/tensions — **MEDIUM × PLAUSIBLE (bounded by keystone)**
`src/consolidate/birth.ts:333,390`

Off-shadow, a note an agent authored flows verbatim (truncated to 1500 chars) into the derivation prompt with no delimiter hardening; the verdict then drives a real `edge-observe` + `addTension`. Crafted content can seed bogus candidate edges and flood the advisory tension log. Blast is bounded — the keystone means no mint/supersede/delete, and candidate edges + tensions are reversible.

**Fix.** Fence document content with explicit `<untrusted_document>` delimiters and instruct the judge to ignore embedded instructions.

---

## Part 2 — Efficiency findings

### E1. Whole-vault `SELECT * FROM documents` on every search — **HIGH × CONFIRMED**
`src/search/hybrid.ts:256` (`getAllDocuments`, `index-db.ts:662`)

Every `vault_search` / `vault_search_related` loads *every* document row — full `content` body included — into a JS `Map` and `JSON.parse`s tags/tokens for all rows, even though FTS/vec already returned a small candidate set (typically <100). ~40MB copied + parsed per query on a 10k-note vault, blocking the synchronous event loop; cost scales O(vault), not O(hits).

**Fix.** Collect candidate paths from the rankers first, then `SELECT * FROM documents WHERE path IN (…)` (chunked, per the existing `existingEmbeddingHashes` pattern at `index-db.ts:558`), or fetch per-hit via `getDocument`. The `content` blob is only needed for the ~`limit` surviving hits.
**Status:** fix in flight (background task `task_5d9cd0bd`), which also carries the S6 ACL-ordering caveat.

### E2. `config.yaml` re-read + re-parsed + re-validated on every write — **MEDIUM × CONFIRMED**
`src/utils/config.ts:453`, called at 7 sites in `write.ts` (477, 604, 714, 811, 898, 1017, 1144)

Each write does a synchronous `readFileSync` + full js-yaml parse + full re-validation (roles, schema_extensions, hooks, backfill map, embeddings) on the hot path while the lock is held. It already loads once at `index.ts:92`.

**Fix.** Load config once at startup and thread it down, or cache by `(path, mtime)` and invalidate on the fs watch event the server already runs.

### E3. `vault_themes` loads all embeddings + runs 4× k-means per call, no cache — **MEDIUM × CONFIRMED**
`src/tools/themes.ts:363-382`

Each call `SELECT`s all documents, `JSON.parse`s tags per row, loads all chunk embeddings, then runs k-means (up to 50 iters) for each of k∈{10,15,20,25} plus silhouette scoring — no memoization, no ceiling on document/chunk count. A `collection`/`tags` filter narrows only *after* all embeddings are loaded.

**Fix.** Cache the pooled-vector set keyed by index generation (invalidate on reindex); push the `collection` filter into the SQL so out-of-scope embeddings are never loaded.

### E4. Double `realpathSync` per file in `vault_index` / `vault_status` scans — **MEDIUM × CONFIRMED**
`src/storage/local.ts:54-55`, called per-file from `src/tools/read.ts:163`

`resolveVaultPath` calls `realpathConfined` on both root and target (≥2 syscalls). `vaultIndex` calls it inside a loop over every markdown file; `vaultStatus` calls `vaultIndex` + `listStaleFiles` + `readProvenanceLog`. A 5k-doc `vault_status` issues ~10k+ redundant `realpath` syscalls, resolving the root identically 5k times.

**Fix.** Resolve `realRoot` once per vaultRoot (memoize). For the trusted internal loop over glob output, a lexical `relative().startsWith("..")` check suffices — the symlink recheck is only needed for untrusted caller paths.

### E5. `indexDocument` opens/closes/reopens the index DB 3× per incremental write — **MEDIUM × CONFIRMED**
`src/search/reindex.ts:499-523`

Each open reloads the sqlite-vec extension and runs a 1-vector ABI smoke-test (`index-db.ts:271-277`). A 500-file sync burst pays open→smoke-test→close→open per file. The per-path 500ms debounce coalesces per path but not across paths.

**Fix.** Do the empty-check on the same open handle; add a coarse cross-path debounce or a "many events → one full reindex" threshold.

### E6. Lower-severity items
- **`gcOrphanedEmbeddings`** (`index-db.ts:598-619`): uncorrelated `NOT IN (SELECT …)` + per-orphan paired deletes on the vec0 table. → `NOT EXISTS` / `LEFT JOIN` with `idx_chunks_content_hash`; batch the deletes.
- **`staged-actions.jsonl` re-read + collapsed 3× per `vault_ratify`** (`staged-actions.ts:348,364`): collapse once and thread the map, or use the SQLite `staged_actions` index for the point lookup.
- **Hook re-`stat()` per write + ESM module-cache leak on reload** (`hooks/loader.ts:54-59`): each edited hook leaks a never-GC'd module URL; cache by `(path, mtime)` and evict the prior entry.
- **Duplicate symmetric-pair LLM derivations in birth**: pair {A,B} is derived when A is born and again when B is born (4 calls where 2 suffice). Memoize on `sha256(sortedPair + model)` — directly cuts the ~1280-call cold start.
- **`relatedSearch` builds a 64-term prefix-OR MATCH** (`hybrid.ts:410-412`): heavy FTS query with arbitrary first-64 truncation; rank the 64 by IDF or lower the cap.
- **No size bound before `matter()`** (`frontmatter/parser.ts:23` ← `storage/local.ts:77`): a pathological multi-hundred-MB `.md` (possible via `daftari import`) blocks/OOMs the parse. Cap file size before parsing.

---

## What is verified solid (do not re-audit)

- Symlink escape closed — `realpathConfined` resolves both root and target and fails closed on any non-ENOENT error (`local.ts:23-64`).
- Staged-actions RBAC — stage-time `canWrite` (gated before the not-found probe, no existence oracle) + ratify-time `canRatify` + inner-write `canWrite`/`canPromote` re-checks. Intact.
- Git option-injection on commit/author/paths — `=`-joined single argv elements under `execFile`; `add`/`log`/`fileGitMeta` use `--`. Not exploitable.
- Secret handling — API key read only from `process.env.ANTHROPIC_API_KEY`, passed straight to the client; never logged, written, or placed in error messages / the envelope journal / commit messages.
- SQL injection — none; FTS `MATCH` sanitized; `IN`-list and vec-dim interpolation take only generated `?` marks / an integer-guarded value.
- YAML deserialization + prototype pollution — safe engine; all merge paths set own properties only (empirically verified).
- Read-side ACL — collection derived from on-disk frontmatter; `filterByReadPermission` drops denied docs; tensions require read on both endpoints.
- Handlers return `Result`; `server.ts:86` catch-all backstops stray throws and returns `e.message` only (no stack). (fs error messages reaching the client verbatim remains prior-audit S5 — informational.)

---

## Recommendations, in order

1. **S1 + S2** — the two confirmed write-path bugs; together they finish closing the #127/#128 aliasing class. *(fix tasks running: `task_e9dc360a`, `task_eb169e93`)*
2. **E1** — the single biggest per-query cost; the refactor also fixes the S6 ACL-ordering under-return. *(fix task running: `task_5d9cd0bd`)*
3. **S3** — swap the schema-pattern matcher to `re2`; the one place third-party input meets an owner regex with no linear-time bound.
4. **S4 + S5** — make `--budget` a real spend cap and flip/force the shadow default; both are behavioral and belong before any auto-write graduation of the cortex loop.
5. **E2, E3, E4, E5** — hot-path allocation/syscall reductions; worthwhile as vaults grow past a few thousand docs.
6. **S7–S13, E6** — hardening and cleanup; batch into a maintenance pass.

*Method note: no test suite was run this session. Re-run `npm test` / `npm run build` after the fixes land; watch for the known CI embedding-model flake (re-run `--failed` before assuming a regression).*
