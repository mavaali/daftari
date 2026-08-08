# Multi-User Contested Beliefs — Slice 3 Implementation Plan (re-scoped)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan Implementation-Unit by Implementation-Unit. The execution skill owns the per-unit test-first cycle (RED test first, watch it fail, then GREEN).

**Readiness:** implementation-ready
**Goal:** Harden the existing per-mutation file lease for intra-process concurrency under `daftari serve` — fix lease-holder false-sharing, serialize the tension-log read-modify-write, and document the concurrency model so no future spec re-derives "replace the process lock."
**Architecture:** Three surgical changes at existing choke points. No new modules, no process-lock changes, no schema changes (`holder` is already TEXT). The lease machinery in `src/access/locks.ts` is reused as-is except for one new holder-minting helper.
**Tech Stack:** TypeScript, better-sqlite3, `node:crypto` `randomUUID`, vitest.
**Source spec:** `docs/superpowers/plans/2026-08-08-multiuser-contested-beliefs-slice3-design.md` (the design pass that REJECTED the original U-13 "replace the process lock" premise; its COEXIST verdict governs this plan).

**Labeling:** [DATA] = verified in code this run (file:line, this worktree). [TRAINING] = model knowledge. [HYPOTHESIS] = inference with kill condition.

---

## Requirements

- **R1 — Per-mutation mutual exclusion.** Two concurrent mutations of the same file must never both proceed, even when both carry the same free-text `agent` string. [DATA] Today they false-share: `performWrite` passes `params.agent` as holder (src/tools/write.ts:455) and `acquireLock` treats same-holder as a TTL-refreshing re-acquire (src/access/locks.ts:98).
- **R2 — Release pairing.** The exact holder value passed to `acquireLock` must reach every matching `releaseLock`, including error/finally paths. [DATA] `releaseLock` deletes `WHERE path = ? AND holder = ?` (locks.ts:132) — a mismatched holder is a silent no-op (`released: false`, not an error) and the lock wedges for the full 60s TTL.
- **R3 — Tension-log RMW serialization.** `addTension` (read → allocate id → append) and `resolveTension` (read → rewrite whole file) must be serialized against each other and against themselves under concurrent serve requests. [DATA] `resolveTension` has await windows between `readFile` (tension.ts:404) and `writeFile` (tension.ts:460) — a classic lost-update race even within one process. `addTension` is sync end-to-end (tension.ts:219–244) and safe today, but only accidentally.
- **R4 — No self-deadlock.** A mutation already holding a file lease on a relPath that then touches the tension log must not deadlock.
- **R5 — Fail-fast consistency.** Lease contention fails fast with an informative error, matching the existing file-lock behavior ([DATA] locks.ts:98–104; docs/architecture.md:552–554 "No queuing" is a stated design property).
- **R6 — Documented concurrency model.** Process lock = single-process ADMISSION control; locks.db = per-mutation file lease; multi-user writes = `daftari serve` (one process, per-request identity). Written where the next spec author will find it.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/access/locks.ts` | modify | Add exported `mintLeaseHolder(agent)` helper. No other change — acquire/release/TTL semantics untouched. |
| `src/tools/write.ts` | modify | Thread minted holders through the two acquire/release pairs (`performWrite`, `vault_merge`). |
| `src/curation/tension.ts` | modify | Wrap `addTension` and `resolveTension` RMW sections in a `"__tensions__"` lease. |
| `docs/architecture.md` | modify | Concurrency-model statement in the existing locking section. |
| `CLAUDE.md` | modify | One key-decision line. |
| `test/access/locks.test.ts` | extend | Holder-format + reserved-key tests. |
| `test/tools/write.test.ts` | extend | Same-agent concurrent-write exclusion; release pairing on error paths. |
| `test/curation/tension.test.ts` | extend | Interleaved add/resolve lost-update tests; contention behavior. |

---

## Implementation Units

### S3-a. Fix lease-holder false-sharing

**Goal:** Make the lease holder unique per in-flight mutation so two concurrent serve requests with the same `agent` string mutually exclude instead of false-sharing (R1), without ever unpairing acquire from release (R2).

**Requirements:** R1, R2.
**Dependencies:** none.
**Files:** `src/access/locks.ts`, `src/tools/write.ts`, `test/access/locks.test.ts`, `test/tools/write.test.ts`.

**Approach — locked decisions:**

1. **Holder string format:** `` `${process.pid}:${randomUUID()}:${agent}` ``. The agent stays as a human-readable *suffix* so the existing contention message — which prints the raw holder ([DATA] locks.ts:101 `file is locked by ${existing.holder}: ${path}`) — still ends with the acting identity. No change to the locks.ts message format.
2. **UUID source:** `randomUUID` from `node:crypto`. [DATA] Not yet imported anywhere in `src/` (grep: zero hits), but `node:crypto` is already used across the codebase (`randomBytes` in src/server.ts:8 and src/fence/index.ts:9; `createHash` in src/utils/hash.ts:7 et al.). [TRAINING] `randomUUID` is built-in since Node 14.17/16 — no new dependency. Import it in `src/access/locks.ts` only.
3. **Where minting lives:** add `export function mintLeaseHolder(agent: string): string` to `src/access/locks.ts`, next to `acquireLock`. Rationale: three call sites (performWrite, vault_merge, S3-b tension path) must agree on the format, and the helper co-locates the format with the machinery that consumes it. Not a premature abstraction — it is the enforcement point for R2's "one holder value per mutation" rule.
4. **Release-pairing wiring, exactly:**
   - `performWrite` (src/tools/write.ts): mint ONCE into a `const holder = mintLeaseHolder(params.agent)` after the shadow-mode early return (line 448) and before the `acquireLock` at line 455. That const is used at both the acquire (455) and the `finally` release (539). [DATA] These are the only two uses of the holder in `performWrite`; the release is already in a `finally`, so the error path is covered by the same const — no new control flow.
   - `vault_merge` (src/tools/write.ts): mint ONCE before the sorted acquire loop (before line 2065), use the const in every `acquireLock` (2066) and in the `finally` release loop (2134). One holder for all paths of one merge is correct and required: the same-holder re-acquire rule means a merge whose (deduped, sorted — [DATA] 2061) path set is acquired under one holder cannot self-conflict.
   - Rule stated for the implementer: **never call `mintLeaseHolder` more than once per mutation attempt, and never pass anything but that const to `releaseLock`.** Minting a second value at a release site recreates the R2 wedge silently — `releaseLock` reports `released: false` instead of erroring ([DATA] locks.ts:133), so nothing fails loudly.
5. **No locks.ts semantic change:** `acquireLock`'s same-holder-refresh behavior stays ([DATA] locks.ts:77–121). It becomes unreachable-in-practice for mutation leases (each attempt has a fresh holder) but remains pinned by existing tests and is relied on by the multi-path merge acquire.

**Existing tests a naive change would break (checked, [DATA]):**
- `test/tools/write.test.ts:120–133` pre-holds a lock with raw holder `"agent:other"` and asserts the write error contains `"locked by agent:other"`. This SURVIVES the fix (the pre-held raw holder is what gets printed) — but breaks if the implementer "cleans up" the locks.ts message to strip prefixes or otherwise reformat. Do not touch the message.
- `test/tools/write.test.ts:589–604` pre-holds/releases with matching raw holders — unaffected.
- `test/access/locks.test.ts` uses raw ALICE/BOB holders against `acquireLock` directly — unaffected (the helper is additive).
- No existing test relies on same-agent pass-through in `performWrite` (grep found only `"agent:other"` pre-holds), so no test *encodes* the false-sharing bug. The RED test below is genuinely new coverage.

**Test scenarios (RED first — the execution skill runs the cycle):**

- `test/access/locks.test.ts` — `mintLeaseHolder`:
  1. Two calls with the same agent string → two distinct holder values (input: `"agent:claude-code"` twice; expected: `a !== b`).
  2. The holder ends with the agent string (input: `"agent:claude-code"`; expected: `endsWith(":agent:claude-code")` — pins the message-readability property).
  3. Two minted holders for the same path mutually exclude: `acquireLock(db, p, mintLeaseHolder(A))` ok, second `acquireLock(db, p, mintLeaseHolder(A))` errs with the first holder in the message. **This is the S3-a regression test — against today's wiring (raw agent as holder) the equivalent performWrite-level scenario false-shares.**
- `test/tools/write.test.ts`:
  4. **The concurrency scenario:** two concurrent `vault_write` calls to the same doc with the same `agent` string (`Promise.all`) → exactly one succeeds, the other returns a locked error naming the winner's holder; file content on disk matches the winner; exactly one provenance entry for the winning write. **RED against current code: both succeed today (false-share).** Execution note: if `Promise.all` interleaving proves nondeterministic in vitest, fall back to pre-acquiring with a minted holder and asserting the second write fails — the locks.test scenario 3 already pins the core property deterministically.
  5. Concurrent writes to two DIFFERENT docs both succeed (no accidental global serialization).
  6. Release pairing on the error path: a write rejected by the stale-`base_version` check ([DATA] write.ts:461–477 — inside the lock, returns before release only via `finally`) leaves the path immediately re-acquirable by a fresh holder.
  7. `vault_merge` regression: a merge succeeds end-to-end (multi-path acquire under one minted holder), and after it completes all touched paths are immediately re-acquirable (release loop used the same holder).

**Patterns to follow:** existing `locks.test.ts` style (in-memory temp db, injectable `now`); existing write.test.ts pre-hold/assert pattern at :120.
**Verification:** new tests green; full `npm test` green with zero edits to existing lock/write assertions (proves the message and same-holder semantics were not disturbed).

---

### S3-b. Serialize the tension-log read-modify-write

**Goal:** Close the lost-update window in `resolveTension` (and make `addTension`'s safety explicit rather than accidental) by wrapping each RMW in a lease on a reserved key, using the same locks.ts machinery (R3), fail-fast on contention (R5), no self-deadlock (R4).

**Requirements:** R3, R4, R5.
**Dependencies:** S3-a (uses `mintLeaseHolder`).
**Files:** `src/curation/tension.ts`, `test/curation/tension.test.ts`.

**Approach — locked decisions:**

1. **Reserved key literal:** `"__tensions__"`, defined as an exported const (e.g. `TENSIONS_LOCK_KEY`) in `src/curation/tension.ts` (it names a tension-domain resource; locks.ts stays domain-agnostic). [DATA] Lock keys today are canonical vault relPaths (write.ts:642–645 #127/#128 rule); no vault document path can collide with `__tensions__` in practice. Residual risk (trivial): a vault file literally named `__tensions__` at the root would share the key — it is not a valid `.md` doc path for the write tools, so no real collision surface. Accepted.
2. **Where the lockDb handle comes from:** each function opens its own handle via `openLockDb(vaultRoot)` and closes it in `finally` — the exact pattern `performWrite` uses ([DATA] write.ts:450–452, 545). Both `addTension` and `resolveTension` already receive `vaultRoot` and are already `async` ([DATA] tension.ts:166, 397), so **no signature changes** — every caller ([DATA] tools/curation.ts:137/245, tools/positions.ts:286/523-area, tools/edges.ts:217, curation/staged-actions.ts:418, consolidate/index.ts:569, audit/semantic.ts:177) gets the protection for free.
3. **Holder identity:** reuse S3-a's `mintLeaseHolder`, suffixed with the best available identity: `input.loggedBy` in `addTension`, `resolution.resolvedBy` in `resolveTension` (both are required non-empty fields). Same one-const-per-mutation pairing rule as S3-a.
4. **Lease extent:**
   - `resolveTension`: acquire `"__tensions__"` before the `readFile` at tension.ts:404; release in a `finally` that covers everything through the `writeFile` at tension.ts:460 (including all the early `return err(...)` paths in between — not-found, already-resolved). `lockDb.close()` in the same `finally`, after release.
   - `addTension`: acquire before the `readFileSync` at tension.ts:221 (i.e., wrap the existing "critical section" comment block at 212–244), release in `finally`. The section stays sync inside the lease; the lease turns the per-process-accident invariant (the comment at tension.ts:212–218 says so explicitly) into an enforced one, and serializes add-vs-resolve, which the sync trick alone never did.
   - Held ONLY for the RMW — validation (tension.ts:167–208) runs before acquisition.
5. **Contention behavior: fail-fast, no wait, no retry.** Matches the file-lock behavior and the documented "No queuing" design property (R5; [DATA] docs/architecture.md:552–554). The design pass's optional single-retry sugar (§3.5) is **deferred** — see Deferred to Follow-Up Work. Wrap the acquire error with tension context so callers see `cannot update tension log: file is locked by <holder>: __tensions__ (...)` rather than a bare path message — additive wrapping only; do not change locks.ts.
6. **Re-entrancy analysis (stated for the record, R4):** a mutation holding a file lease on some relPath that then calls `addTension` acquires a DIFFERENT key (`"__tensions__"` vs the relPath), so there is no self-deadlock — and `acquireLock` is non-blocking anyway (fail-fast, never waits), so deadlock is structurally impossible in this design; the only failure mode is a spurious fail-fast under contention. [DATA] Confirmed no code path acquires `"__tensions__"` twice in one call chain: `performWrite` never calls addTension/resolveTension (write.ts:419–547 contains no tension call), and the tools that do both (positions.ts) call performWrite-family writes and tension functions sequentially, never nested.
7. **TTL:** the standard 60s applies. The tension RMW is milliseconds of file I/O — no TTL concern.

**Existing tests a naive change would break:**
- [DATA] `test/curation/tension.test.ts` (and tension-triage/clusters tests) build bare temp vaults; `openLockDb` runs `mkdirSync(join(vaultRoot, ".daftari"), { recursive: true })` (locks.ts:44), so no fixture changes needed. But if the implementer opens the db OUTSIDE the try/finally, a thrown open error leaks the handle — follow performWrite's shape exactly.
- [HYPOTHESIS] Some tension tests may call `addTension` many times in a tight loop; since each call opens/closes its own lockDb and same-call holder is unique, sequential calls never contend — no breakage expected. Kill condition: a test that deliberately holds `"__tensions__"` across calls would now see failures — none exists today (the key is new).

**Test scenarios (RED first):**

- `test/curation/tension.test.ts`:
  1. **The lost-update scenario (the RED test that fails against today's code):** seed a tensions.md with two unresolved tensions; fire `resolveTension(id1)` and `resolveTension(id2)` concurrently (`Promise.all`) → the winner succeeds, the loser fails fast with the tension-log-locked error; the file afterwards contains the winner's resolution intact and the loser's tension untouched-and-unresolved — **never** a file where one resolution silently overwrote the other. (Today both "succeed" and one resolution can be lost.) Execution note: if the event-loop interleaving doesn't reliably overlap the two awaits, force the race deterministically by pre-acquiring `"__tensions__"` with a foreign holder and asserting `resolveTension` fails fast without touching the file — plus a separate non-contended two-sequential-resolves test asserting both survive.
  2. `addTension` under a held `"__tensions__"` lease (pre-acquire with a foreign holder): fails fast, appends nothing, allocates no id.
  3. `resolveTension` under a held lease: fails fast, file byte-identical to before.
  4. Lease released on every early-error path: after a `resolveTension` that fails with "tension not found" and one that fails with "already resolved", `"__tensions__"` is immediately acquirable.
  5. Sequential `addTension` × N still yields N entries with N distinct sequential ids (pins that the lease didn't break the id-allocation critical section).
  6. Cross-key independence: holding a file lease on `pricing/a.md` does not block `addTension`, and holding `"__tensions__"` does not block a `vault_write` to `pricing/a.md` (the R4 property, from both directions). May live in `test/access/locks.test.ts` as the reserved-key-coexists case plus a tension.test.ts integration case.

**Patterns to follow:** `performWrite`'s open-lock-db / acquire / inner-try / finally-release / finally-close shape ([DATA] write.ts:450–546).
**Verification:** new tests green; the full existing tension suite (tension.test.ts, tension-triage, tension-clusters, positions/edges/staged-actions tests that mint tensions) green unmodified.

---

### S3-c. Document the concurrency model

**Goal:** Record the two-layer model in the places a future spec author reads first, so "replace the process lock" is never re-derived (R6).

**Requirements:** R6.
**Dependencies:** S3-a, S3-b (document what shipped, not what's planned).
**Files:** `docs/architecture.md`, `CLAUDE.md`. **No new file** — [DATA] docs/architecture.md already has the locking section ("What the locking is NOT", ~lines 549–585, and the Layer-3 walkthrough at 1036–1050); that is the home.

**Approach — locked decisions:**

1. **Home:** a short subsection inside docs/architecture.md's existing locking discussion (adjacent to line ~549). Content, three sentences plus the two S3 changes:
   - `.daftari/process.lock` (src/lifecycle/lock.ts) is single-process ADMISSION control — one daftari process per vault, precedence matrix unchanged.
   - `.daftari/locks.db` (src/access/locks.ts) is the per-mutation file lease — 60s TTL, fail-fast, lockless reads; holders are unique per in-flight mutation (`pid:uuid:agent`); the tension log is leased under the reserved `__tensions__` key.
   - Multi-user writes happen through ONE `daftari serve` process with per-request identity; the stdio→serve refusal is the router toward that topology, not an obstacle. Cross-process writing is out of scope by design (cite the 2026-08-08 design pass as the bill of materials).
2. **CLAUDE.md:** one line in Key decisions, same three-clause shape, pointing at the design pass doc. Keeps the next session's context loaded with the verdict.
3. Do NOT restate the precedence matrix (already in CLAUDE.md) — link, don't duplicate.

**Test expectation: none — documentation-only unit.** (If `daftari audit` — src/audit doc-to-code coherence — runs in CI, confirm the new text doesn't trip it; [HYPOTHESIS] it won't, audit is CLI-invoked not CI-invoked. Kill condition: a CI audit step exists — then run it locally first.)

**Verification:** both docs updated; a reader can answer "which lock do I change to allow two writers?" with "neither — you connect to serve."

---

## Sequencing

S3-a → S3-b → S3-c. S3-b consumes S3-a's helper; S3-c documents both. Each unit lands independently green.

## Deferred to Implementation

- Exact placement/name of the `holder` const in `vault_merge` (any point after shadow-mode return, before the acquire loop).
- Whether write.test.ts scenario 4 needs a scheduling nudge (e.g. `setImmediate` staggering) to make the `Promise.all` race deterministic — decided at RED time by watching what actually interleaves.
- The exact wording of the wrapped tension-contention error message (must contain the underlying holder + TTL info; exact prefix free).

## Deferred to Follow-Up Work / OUT OF SCOPE

- **The rejected REPLACE:** anything cross-process — tension-log cross-process locking, git-commit queuing/retry, jsonl id-allocation locks, index single-writer election, per-call index freshness re-check, watcher election, PID-keyed lease takeover. The design pass §5 is the bill of materials; revisit only against a concrete requirement serve-topology cannot meet.
- Bounded single-retry with jitter on `"__tensions__"` contention (design §3.5 "optional sugar") — fail-fast ships first; add retry only if system-generated tension writes (vault_assert auto-logging) measurably contend.
- TTL tuning (60s stays; design §3.2) and any `pid` column future-proofing on locks.db (design §3.4).
- Leasing the sync jsonl appends (staged-actions/edges/shadow) — safe within one process ([DATA] appendFileSync throughout), not this slice.

## Riskiest decision (named)

The release-pairing wiring (S3-a decision 4). A holder mismatch does not error — `releaseLock` silently reports `released: false` ([DATA] locks.ts:133) and the lock wedges for 60s, which no happy-path test will catch. Mitigation: one-mint-per-mutation rule enforced by the `mintLeaseHolder` helper + the explicit error-path re-acquirability tests (write scenario 6, tension scenario 4).
