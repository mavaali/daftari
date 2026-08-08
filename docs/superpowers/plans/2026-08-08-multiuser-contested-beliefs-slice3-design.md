# Multi-User Contested Beliefs — Slice 3 Design Pass: the Per-Mutation Write Lease (U-13, R-18)

**Status:** design verdict — NOT implementation-ready as specced. See §5.
**Author:** Fable design pass, 2026-08-08, grounded against this worktree.
**Inputs:** `.plan-inputs/spec-full.md` (§5 / R-18 / U-13), `.plan-inputs/fury-review.md`, the code cited below.
**Labeling:** [DATA] = verified in code this run (file:line). [TRAINING] = model knowledge. [HYPOTHESIS] = inference, kill condition stated.

---

## 0. The one-paragraph verdict

The spec's U-13 — "per-mutation write lease **replacing** the exclusive process lock" — rests on a false premise: that the process lock is what serializes mutations. [DATA] It is not. Mutations are already serialized by a *different, already-existing* per-mutation lease: the SQLite file-level write lock in `src/access/locks.ts` (60s TTL, lazy stale purge, lockless reads), acquired around every `performWrite` (write.ts:455) and every `vault_merge` (write.ts:2066). The process lock's actual job is protecting everything the file lease does **not** cover — the shared `index.db` rebuild, git commit serialization, tension-log read-modify-write, jsonl id allocation, and per-process in-memory state. Removing it does not "add concurrency"; it removes the only guard on five unguarded shared surfaces. **Decision: COEXIST — the process lock stays, unchanged. Slice 3 shrinks to hardening the existing lease for the concurrency that already legally exists (concurrent requests inside one `daftari serve` process).** The multi-*process* story is already solved by the codebase's own architecture: multiple principals share one vault by connecting to one `daftari serve` (per-request identity, src/serve/index.ts:514 + CLAUDE.md MCP decision), and the lock's stdio→serve refusal message literally tells the second process to do exactly that (lock.ts:275–283). Full REPLACE is a concurrency re-architecture masquerading as a slice; it is deferred with the itemized bill in §5.

---

## 1. Current state (verified)

### 1.1 The process lock — whole-process hold

[DATA] Acquired **once at startup**, before any heavy work, held for the process lifetime:

- stdio entry: `acquireLock(vaultRoot, DAFTARI_VERSION, { mode: "stdio" })` at src/index.ts:82, immediately followed by `installShutdownHandlers` (index.ts:90).
- serve entry: `acquireLock(...)` at src/serve/index.ts:514.
- Released only on SIGTERM/SIGINT/exit (index.ts:266–279); `releaseLock` is sync because it runs from `process.on("exit")` (index.ts:261–262, lock.ts:336).

[DATA] Mechanics (src/lifecycle/lock.ts):

- **Claim is always atomic O_EXCL create** (`openSync(path, "wx")`, lock.ts:162), retried in a bounded loop (`MAX_ACQUIRE_ATTEMPTS = 5`, lock.ts:180, 254). Never a plain overwrite — this closed a stale-takeover TOCTOU (comment lock.ts:248–253).
- **Stale detection**: dead PID via `kill(pid, 0)` with EPERM-counts-as-alive (lock.ts:73–81); PID-recycle guard via `ps -p PID -o command=` + whole-token vault-path match (`commandLineTargetsVault`, lock.ts:103–115, 128–140). A stale lock is removed *only if byte-identical to the one inspected* (`removeLockIfUnchanged`, lock.ts:191–203), then the O_EXCL create is retried.
- **Live-holder precedence matrix** (lock.ts:269–309): stdio→stdio = SIGTERM + wait up to 3s (`SIGTERM_GRACE_MS`, lock.ts:155) then proceed; stdio→serve = REFUSE, message names the bind and says "connect to it over HTTP instead" (lock.ts:275–283); serve→anything = REFUSE unless `--takeover` (lock.ts:284–292).
- **Release ownership guard**: release only if the lockfile still records our own PID (lock.ts:337–346).
- Lockfile records `pid`, `mode`, `bind`, `startedAt`, `version` (lock.ts:23–33).

### 1.2 The already-existing per-mutation lease (the spec seems unaware of it)

[DATA] `src/access/locks.ts` — file-level write locks in `.daftari/locks.db` (separate from the search index, locks.ts:9–11), WAL mode (locks.ts:46):

- `LOCK_TTL_MS = 60_000` (locks.ts:20); TTL enforced lazily — `purgeExpired` runs before each acquire, no reaper (locks.ts:71–75).
- Acquire fails fast if a *different* holder has a live lock; same-holder re-acquire refreshes TTL (locks.ts:77–121). Release is holder-guarded, no-op otherwise (locks.ts:126–138). Reads never touch it — reads are already lockless.
- Call sites: `performWrite` acquires around write→index→commit→provenance, releases in `finally` (write.ts:455, 539); `vault_merge` acquires all touched paths in sorted order, "defensive against self-deadlock … the one-process invariant makes that theoretical" (write.ts:2055–2069, 2134).
- Lock key is the **canonical relPath** (#127/#128 rule, write.ts:642–645). Holder key is the **caller-supplied `agent` string** (write.ts:455) — *not* a process or request identity.

[DATA] So R-18's headline properties — short-TTL per-mutation lease, lockless reads, stale takeover on timeout — **already exist** for the frontmatter-write choke point. Every frontmatter mutation except merge funnels through `performWrite` (vault_write at write.ts:668 via `performFrontmatterWrite` write.ts:655–693, plus write.ts:1124, 1262; vault_ratify dispatches approved payloads back through the write tools, src/tools/staged-actions.ts:9, write.ts:854).

### 1.3 What the process lock is actually protecting (mutation surfaces with NO lease)

[DATA] These shared writes rely on the one-process invariant, not on locks.db:

1. **Tension log append** — `addTension` reads the whole `tensions.md` to allocate `nextTensionId`, then `appendFileSync` (tension.ts:226, 244). Sync end-to-end → atomic *within* one process, a read-modify-write race *across* processes.
2. **Tension resolve** — `resolveTension` is async: `await readFile` → rewrite the **whole file** → `await writeFile` (tension.ts:397–465). There is an await window between read and rewrite → lost-update race even **within one serve process** under concurrent requests, and certainly across processes.
3. **jsonl appends + id allocation** — staged actions, edges, shadow, consumes, provenance, read-log all `appendFile(Sync)` (staged-actions.ts:342, edges.ts:536, shadow.ts:265, provenance.ts:89, consumes.ts:80, read-log.ts:67). Single-line O_APPEND appends are safe-ish; id allocation that reads-then-appends is not, cross-process.
4. **Git commit** — `commit()` shells out `git add` + `git commit` (src/utils/git.ts:98–131). [TRAINING] Git serializes via `.git/index.lock` but a concurrent committer **fails** ("index.lock exists") rather than waits — the failed writer's file is on disk, uncommitted (the exact dirty-tree hazard performWrite's comment structure assumes away via the one-process invariant; vault_merge says so explicitly, write.ts:2071–2078).
5. **index.db lifecycle** — freshness is checked **once at startup** (`isIndexFresh`, index.ts:207, reindex.ts:180–194: manifest of mtimes stored in the db, reindex.ts:150–174); after that, coherence is maintained by (a) each write's own `indexDocument` (write.ts:483) and (b) the chokidar watcher for out-of-band edits, with `noteSelfWrite` suppressing own events (write.ts:491, index.ts:285–293). There is **no per-call freshness re-check anywhere**. `indexDocument` on an empty index falls back to a **full `reindexVault`** (reindex.ts:594–604) — a drop-and-rebuild racing another process's incremental write is index corruption by construction. Connections are per-operation (`openIndexForActiveProvider` per call, reindex.ts:590), WAL, no explicit busy_timeout ([TRAINING] better-sqlite3 defaults to 5000ms).
6. **Per-process in-memory state** — index-state machine (index.ts:24–29), watcher singleton (index.ts:253), staged-actions/edges sqlite materialization done once on the fresh path (index.ts:216–229), config mtime cache (config.ts:994–1050). Two processes each believe their own copy is authoritative.

### 1.4 The architectural fact the spec under-weights

[DATA] `daftari serve` already gives multiple principals concurrent access through **one** process: identity is resolved per request from the bearer, no sessions (CLAUDE.md MCP decision; serve entry src/serve/index.ts). The lock's stdio→serve refusal is not an obstacle to multi-user — it is the routing mechanism *toward* the multi-user topology the codebase already supports. Slice 1/2 (positions, consolidation) are live today under serve with zero lock changes.

---

## 2. The core decision: REPLACE vs COEXIST

**Decision: COEXIST. The process lock is untouched. The "per-mutation lease" work is a hardening of `src/access/locks.ts` and its coverage, scoped to intra-process concurrency under `daftari serve`.**

Argument from the code:

- The spec's lease already exists (§1.2). What "replace the process lock with a lease" would actually mean is: let N processes run `performWrite` concurrently, coordinated only by locks.db. But `performWrite` is the *only* covered surface. Surfaces 1–6 in §1.3 would immediately be multi-writer with no coordination. The lease REPLACE therefore is not U-13; it is six sub-projects (cross-process tension-log locking, git-commit retry/queue, jsonl id-allocation locking, index single-writer election or per-call freshness, watcher election, cache invalidation).
- Every guarantee in the precedence matrix exists for a reason still true after Slice 3:
  - **stdio→stdio SIGTERM takeover** (lock.ts:294–309): the single-user convenience — a restarted desktop session reclaims its vault. Dropping it changes UX for the primary (single-user) product. *Preserved.*
  - **stdio→serve refusal** (lock.ts:275–283): protects a durable multi-tenant server from being killed by a laptop session, and *routes* the second user to the correct topology. Under COEXIST this refusal is the multi-user feature, not a bug. *Preserved.*
  - **serve→\* refusal without `--takeover`** (lock.ts:284–292): a deployment must not silently kill a live session. *Preserved.*
  - **PID-recycle guard + O_EXCL claim + unchanged-only removal** (lock.ts:103–140, 159–174, 191–203): prevents SIGTERMing an innocent process and prevents the double-claim TOCTOU. *Preserved, and reused as the pattern for cross-process lease takeover if that ever ships (§3.4).*
- **Guarantees changed: none.** The COEXIST design deliberately changes zero process-lock semantics. That is the point.

[HYPOTHESIS] Rejected alternative — full REPLACE with a per-vault "mutation lease file" taken O_EXCL around each mutation: kills throughput (every mutation pays lock-file fs round-trips + contention retries), still doesn't cover git/index races unless those move inside the lease (making the lease long-held — reinventing the process lock per call), and forfeits the SIGTERM takeover UX. Kill condition: if a hard requirement emerges for two *stdio* processes writing one vault simultaneously (e.g. two local agents that cannot speak HTTP), COEXIST is insufficient and the §5 bill comes due.

---

## 3. Lease mechanics (the COEXIST scope)

What Slice 3 actually builds, at the existing choke points:

### 3.1 Holder identity fix

[DATA] Today's holder is the free-text `agent` string (write.ts:455). Two concurrent serve requests claiming `agent: "agent:claude-code"` — the common default — **false-share** a lock: locks.ts:98 treats same-holder as re-acquire and both proceed into the same file. This is the one live correctness bug in the existing lease.

**Design:** holder = `${process.pid}:${randomUUID-per-mutation}:${agent}`. Uniqueness per mutation attempt restores mutual exclusion; the agent suffix keeps the contention error message informative (locks.ts:99–104 already prints the holder). No schema change — holder is TEXT.

### 3.2 TTL

**Keep 60s** (locks.ts:20). Justification: the lease must outlive the slowest mutation it wraps. [DATA] `performWrite` holds it across file write + `indexDocument` (which can fall back to a *full reindex* on an empty index, reindex.ts:594–604 — minutes) + git commit + provenance. 60s already accepts that a reindex-fallback write can exceed the TTL; shortening it widens that hole, lengthening it slows crash recovery. The reindex-fallback case is single-process today and stays so under COEXIST — acceptable. No change, but write the test that documents the assumption (§6).

### 3.3 Coverage extension — the two unguarded mutation surfaces that matter under serve concurrency

1. **`resolveTension`** (tension.ts:397–465): wrap the read→rewrite in a lease on the canonical key `"__tensions__"` (a reserved non-path key in locks.db; paths are canonical relPaths so no collision — [DATA] lock keys today are relPaths, write.ts:642–645). Acquire before `readFile`, release in `finally` after `writeFile`. This closes the intra-process lost-update window (the await at tension.ts:404/460).
2. **`addTension`** (tension.ts:205–250): sync, therefore atomic within one process — [DATA] no await between the id-allocating read and the append. Under COEXIST no change is *required*; take the same `"__tensions__"` lease anyway so tension mutations serialize under one discipline and the invariant is explicit rather than accidental.

Staged-actions/edges/shadow appends are sync single-line appends within one process — [DATA] appendFileSync throughout (§1.3.3) — no lease needed under COEXIST. Ratified staged writes dispatch through the write tools → already leased.

### 3.4 Stale-lease takeover

[DATA] Today: pure TTL expiry (`purgeExpired`, locks.ts:73–75) — a crashed holder blocks its file for at most 60s, then the lock self-releases. Under COEXIST (one process) this is already correct and *simpler* than PID-liveness: an in-process abandoned lease means the request threw, and `finally` released it (write.ts:538–540); TTL only backstops a hard crash, where the whole process — and every in-flight mutation — died together, and the *process* lock's own stale-PID path handles the restart.

**Design: keep TTL-only takeover.** Wiring `isDaftariProcess` into locks.db (spec's "stale takeover keyed on PID-liveness") only pays off cross-process; adding a `pid` column now is cheap future-proofing but activating PID-based early takeover is explicitly out of scope. [HYPOTHESIS] Early takeover keyed on `isProcessAlive(pid)` within one process is a footgun: the PID is always alive (it's us), so it would never fire — correct but dead code. Kill condition: cross-process lease sharing ships.

### 3.5 Contention path

[DATA] Today: fail-fast with the holder and remaining TTL in the message (locks.ts:98–104). **Design: keep fail-fast at the tool boundary** — an MCP client retrying a clearly-worded "file is locked, expires in Nms" error is the same pattern as `rejected_stale` (write.ts:471–477). No blocking waits inside tool handlers: a wait pins a serve request slot and invites convoy behavior. Optional sugar (defer unless trivial): one bounded retry after 100–250ms jittered sleep for the `"__tensions__"` key only, since tension-log contention is system-generated (vault_assert auto-logging) rather than caller-visible.

### 3.6 Per-call index freshness re-check

The spec demands "index freshness re-checked per call." **Design: REJECT under COEXIST — with one narrow exception.** [DATA] `isIndexFresh` stats **every file in the vault** to build the mtime manifest (reindex.ts:150–174, 180–194); per-call it is O(vault) stat traffic on every read — precisely the cost the manifest was built to pay once at startup (index.ts:148–151 comment: skips a ~25-min pass). Within one process, self-writes index synchronously (write.ts:483) and the watcher covers out-of-band edits (index.ts:285–293); freshness-per-call solves a two-process problem that COEXIST rules out. The narrow exception worth keeping from the spec's intent: reads already degrade gracefully via `getIndexStatus()` "still indexing" (index.ts:10–12) — nothing new needed. If watch is disabled (`watch: false` config), out-of-band edits go stale until restart — [DATA] true today (index.ts:286–288), unchanged by this slice, documented as a known limit.

### 3.7 Release timing / crash recovery

Unchanged: release in `finally` (write.ts:538–540, 2133–2135); TTL backstops crashes; `.daftari/locks.db` is ephemeral and worthless after a minute (locks.ts:9–11). The new `"__tensions__"` lease follows the identical pattern.

---

## 4. Failure and edge modes

| Mode | Under COEXIST (this design) | Under the spec's REPLACE (why it was rejected) |
|---|---|---|
| Two processes race one mutation | Cannot happen: process lock still admits one process (lock.ts:254–257 O_EXCL). | locks.db serializes the file write only; git commit races fail non-deterministically ([TRAINING] index.lock), tension ids collide (§1.3.1–2), index drop-rebuild races incremental writes (reindex.ts:594–604). |
| Two serve **requests** race one file | Second acquire fails fast with holder + TTL (locks.ts:98–104) — *after the §3.1 holder fix*. Today they false-share. | Same, plus all the above. |
| Lease holder dies mid-write (partial file/index) | Only via whole-process crash → process-lock stale path recovers on restart; startup freshness check sees the mtime drift and reindexes (index.ts:207); git tree may be dirty-uncommitted — already an accepted window (write.ts:2071–2078 states it for merge; same shape for performWrite). | Another process takes the expired lease over a *partial on-disk write* it cannot distinguish from a complete one; index and file can permanently disagree until a manual reindex. |
| PID recycling during a lease | Irrelevant: lease takeover is TTL-only (§3.4); PID machinery stays on the process lock where `isDaftariProcess` guards it (lock.ts:128–140). | Would require porting `commandLineTargetsVault` into per-mutation hot path — a `ps` exec per contended acquire. |
| Clock skew on TTL | Single host, single process: `Date.now()` monotonic-enough; `now` is injectable for tests (locks.ts:85). [TRAINING] Wall-clock steps (NTP) can early-expire or overhold a lease by the step size — bounded, and only widens/narrows a 60s window whose loser fails safe (acquire error, not corruption). | Cross-process on one host: same. Cross-host was never in scope (vault is a local git working copy). |
| Reads during a mutation (staleness window) | Reads are lockless (no read path touches locks.db — [DATA] no call sites outside write.ts). A read between file-write (write.ts:481) and index-update (write.ts:483) can see new file + stale index row; window is milliseconds, and search results always re-read the file for content. Accepted, documented. | Same window plus a cross-process one with no bound. |
| Interaction with the process lock | None by construction — different layer (process admission vs per-file mutation). The tension `"__tensions__"` key coexists with path keys in one table. | The interaction *is* the project (§5). |

---

## 5. Scope / risk verdict — blunt

**The spec's U-13 as written ("replace the exclusive process lock") is NOT a slice. It is a multi-process concurrency re-architecture wearing a slice costume.** The honest bill for REPLACE: cross-process serialization for the tension log (read-modify-write, §1.3.1–2), git commit queuing/retry (§1.3.4), jsonl id-allocation locks (§1.3.3), index single-writer election or per-call O(vault) freshness (§1.3.5), watcher/materialization election (§1.3.6), plus porting the PID-recycle guard into the lease. Each is individually PR-sized; together they cross module boundaries (`curation`, `search`, `storage`, `utils/git`, `access`) and change durability semantics. High corruption risk, and green CI proves little because the failure modes are cross-process races vitest doesn't naturally exercise. **Do not self-merge that on green CI. Do not build it now.**

**What Slice 3 should be instead (ship-now, genuinely small):**

- **S3-a** Holder-identity fix (§3.1) — closes a real, current false-sharing bug under serve concurrency. ~10 lines + tests.
- **S3-b** `"__tensions__"` lease around `resolveTension` and `addTension` (§3.3) — closes a real, current lost-update race under serve concurrency. Small, one module.
- **S3-c** Docs: record the concurrency model explicitly (process lock = admission; locks.db = per-mutation lease; multi-user = serve) in `docs/architecture.md` + a CLAUDE.md key-decision line, so the next spec doesn't re-derive REPLACE.
- **Defer** everything cross-process, with this doc as the bill of materials. Revisit only against a concrete requirement that serve-topology cannot meet.

This deferral is consistent with R-18's *intent* (mutations serialized by short leases, reads lockless, crashed writers never wedge) — all of which holds after S3-a/b — while rejecting its *letter* ("replacing the exclusive process lock"), which the fury audit's own R-5 flagged as the spec's weakest area ("§5 lock deferred… concurrent writers don't exist until Slice 3"). **Recommendation: show Mihir this verdict before any implementation; the spec text for U-13 should be amended to the S3-a/b/c scope.**

---

## 6. Test plan

All under COEXIST scope. Files follow the tests-mirror-src rule.

**`test/access/locks.test.ts` (extend — [DATA] locks.ts has injectable `now`, locks.ts:85):**
1. Two distinct holders, same path: second acquire errs, message carries first holder + remaining TTL.
2. Same holder re-acquire refreshes TTL (existing behavior pinned).
3. Expired lock (now > expiresAt): new holder acquires; purge removed the row.
4. **Holder-identity regression (S3-a):** two mutation attempts with the same `agent` but different per-mutation holder ids do NOT false-share — second fails while first is live. This is the test that fails against today's code.
5. Reserved key `"__tensions__"` coexists with path keys; no cross-interference.

**`test/tools/write.test.ts` (extend):**
6. Two concurrent `vault_write` calls (same doc, same `agent` string, `Promise.all`): exactly one succeeds, the other returns the locked error; file content matches the winner; exactly one provenance entry + one commit. *(The corruption-prevention property, intra-process.)*
7. Concurrent writes to two different docs both succeed (no accidental global serialization).
8. Lease released on the error path: a write that fails validation/stale-check leaves the path immediately acquirable.

**`test/curation/tension.test.ts` (extend):**
9. Concurrent `resolveTension` on two different tension ids (`Promise.all`): both resolutions survive in the rewritten file — the lost-update test that fails against today's code (S3-b).
10. Concurrent `addTension` × N: N entries, N distinct sequential ids, no interleaved/garbled blocks.
11. `resolveTension` while an `addTension` lease is live: fail-fast (or single-retry, per §3.5 choice) — never a partial file.

**`test/lifecycle/lock.test.ts` (extend, regression only — no behavior change):**
12. Precedence matrix pinned: stdio→serve refuse, serve→live refuse without takeover, stdio→stdio SIGTERM path, stale-PID overwrite, `removeLockIfUnchanged` leaves a replaced lock alone. (Most exist; assert the matrix is total so a future REPLACE attempt trips loudly.)

**Integration (`test/serve/` if a serve harness exists, else defer to manual):**
13. One serve process, two bearer identities, concurrent `vault_assert` on one doc: one wins, one gets the lease error; positions array is consistent; exactly one positional tension minted. *(Slice 1 + Slice 3 composed — the scenario the whole feature exists for.)*

**Explicit non-tests:** no two-process corruption tests — the process lock forbids the topology, and lock.test.ts case 12 pins that it still does.
