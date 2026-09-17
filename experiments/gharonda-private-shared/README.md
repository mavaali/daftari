# Gharonda spike — U1: household vault topology fixture

Proves that daftari's existing cross-vault federation (read composition over
sovereign vaults, config-driven `federation.principals`, deny-all-guest
default, read-only mounts) delivers the 1Password-style private+shared memory
model Gharonda's household assistant needs — with **no new daftari code**.

## Topology

```
vaults/
  alice-private/.daftari/config.yaml   — federation.principals: human:alice only
  bob-private/.daftari/config.yaml     — federation.principals: human:bob only
  shared/.daftari/config.yaml          — federation.principals: human:alice + human:bob
```

Each vault is a sovereign daftari vault (its own `.daftari/config.yaml`, own
`roles:` block). `federation.principals` in a vault's config is read by a
*mounting* process to decide which authenticated principal, mounting this
vault as a reference, may see it and as which local role. An unlisted
principal (including a bare `"*"` wildcard, which neither private vault
declares) resolves to the deny-all guest at mount load — that is the
default posture, not an opt-in.

- `alice-private` grants read to `human:alice` only.
- `bob-private` grants read to `human:bob` only.
- `shared` grants read to both `human:alice` and `human:bob`.

A real deployment would additionally configure `federation.mounts` on
whichever vault(s) *compose* over these (e.g. an alice-session mount pointing
`local` at `alice-private` plus an `alias: shared` mount at `shared`) — that's
a mount-load / server-start concern (`src/federation/mounts.ts`) outside this
unit's scope (config-shape only). This fixture proves the config half of the
contract: each vault's own policy, loaded standalone.

## Seed data

No `seed.ts` script — the belief docs below were written directly as static
markdown files (this *is* the documented manual seed; there's no daftari
write-path being exercised in this unit, just config load + doc presence, so
a script would only reproduce what's already on disk).

| Vault | Docs | Leak canary |
|---|---|---|
| `alice-private` | `therapy-notes.md`, `job-search.md` | `ALICE_SECRET_CANARY` |
| `bob-private` | `gift-ideas.md`, `health-notes.md` | `BOB_SECRET_CANARY` |
| `shared` | `household-budget.md`, `kids-school-schedule.md`, `home-maintenance.md` | `SHARED_HOUSEHOLD_FACT` |

A later unit (federated read/search across a mount) can grep a composed
read's output for `ALICE_SECRET_CANARY` while mounted as `human:bob` — if it
ever appears, isolation has failed. This unit only proves the docs and the
per-vault config exist and load.

## Verification

```
npx vitest run experiments/gharonda-private-shared/config.test.ts
```

`config.test.ts` imports `loadConfig` from `src/utils/config.ts` directly (no
daftari source was modified) and asserts:

1. All three configs load with no validation error.
2. `alice-private`'s `federation.principals` has `human:alice` but not
   `human:bob` and not `"*"`.
3. `bob-private`'s `federation.principals` has `human:bob` but not
   `human:alice` and not `"*"`.
4. `shared`'s `federation.principals` has both `human:alice` and `human:bob`.

Result: 6/6 passing.

## Config schema used (not invented)

Confirmed by reading `src/utils/config.ts` (`FederationConfig`,
`FederationPrincipalConfig`, `validateFederation`) and
`test/federation/config.test.ts`:

```ts
export interface FederationPrincipalConfig {
  role: string;
}
export interface FederationConfig {
  mounts: FederationMountConfig[];
  principals: Record<string, FederationPrincipalConfig>;
}
```

`federation.principals` is a map of principal id (e.g. `"human:alice"`) to
`{ role: <name of a role declared in this vault's own roles: block> }`. It is
read by the *referenced* vault, independent of `federation.mounts` (read by
the *mounting* vault) — config load stays pure of identity, per the comment
at `src/utils/config.ts:298-305`.

## Shared-write decision (U3)

U2 proved federation mounts are **read-only**: a write-shaped tool
(`vault_write`, `vault_assert`, …) targeting an `alias:`-prefixed path is
refused at dispatch (`federatedRefusal`) before it touches disk. So writing
to `shared` requires a process for which `shared` — not a mount — is the
**canonical** vault.

**Two options considered:**

1. **Two-process-per-principal** — each spouse runs *two* servers: one
   canonical on their own private vault (with `shared` mounted read-only for
   reasoning), and a second canonical on `shared` for writes. The assistant
   routes a write by picking the matching principal's shared-canonical
   process.
2. **One shared-canonical process, both principals** — a single process is
   canonical on `shared`; each write call carries the acting principal's
   `AccessContext` (`human:alice` or `human:bob`), exactly like `vaultRead`/
   `vaultSearch`/`vaultWrite` already take an `access` parameter per call
   rather than baking identity into the process. Private writes still go
   through each principal's own private-canonical process, unchanged from
   U1/U2.

**Decision: option 2.** `shared/.daftari/config.yaml`'s `federation.principals`
already grants **both** `human:alice` and `human:bob` the identical
`householder` role (`read: ["*"], write: ["*"]`) on `shared` — there is no
secrecy between the two spouses to isolate *at the shared vault*, unlike
their private vaults. Running two shared-canonical processes (one "for"
alice, one "for" bob) would be two identically-configured instances of the
same vault, differentiated by nothing except which principal happens to
dial them — the RBAC/positions gates in `src/tools/write.ts` already key off
the per-call `AccessContext`, not the process. So a second process buys no
additional structural isolation (R5 is preserved identically either way: a
shared-canonical process, in both options, has no mount into either private
vault, so its blast radius is bounded to `shared` regardless of principal
count) while doubling the write-routing surface the assistant has to manage
(2 processes to keep alive, address, and secure instead of 1) for zero
isolation gain. Concurrency between the two principals' writes is not a
reason to prefer option 1 either — `src/access/locks.ts` locks are
file-path-keyed in a SQLite db on disk, so they already serialize correctly
across any number of processes pointed at the same vault root; one process
vs. two makes no difference to correctness there, only to routing
complexity. Total topology: 3 canonical processes (`alice-private`,
`bob-private`, `shared`), not 4.

### Verification

```
npx vitest run experiments/gharonda-private-shared/shared-write.test.ts
```

`shared-write.test.ts` exercises the **real** write+lock path — `vaultWrite`
(`src/tools/write.ts`) and its lock acquire/release
(`src/access/locks.ts`'s `acquireLock`/`releaseLock`/`mintLeaseHolder`), not
a synthetic lock — against a fresh tmpdir copy of the `shared` fixture
vault per test (writes create `index.db`, `locks.db`, and a nested git repo
via `vaultWrite`'s auto-commit path, so a copy keeps the checked-in fixture
under `vaults/shared/` byte-for-byte unchanged — asserted by the trailing
"U3 fixture hygiene" test).

1. **Different docs, concurrent** (`note-alice.md` / `note-bob.md`) — both
   `vaultWrite` calls (as `human:alice` / `human:bob`) succeed; per-file
   locking means they never contend.
2. **Same doc, concurrent** (`contended.md` / `contended-race.md`) — two
   sub-cases:
   - **Deterministic**: bob's process pre-acquires the real lock
     (`acquireLock`) on the path; alice's `vaultWrite` is refused with a
     `"locked"` error while the lock is held, and a read during that window
     returns "not found" (no partial file ever lands). Releasing the lock
     makes the path immediately writable again (TTL never permanently
     wedges it).
   - **Genuine race**: both principals' `vaultWrite` calls fired via
     `Promise.all` against the same new path. Mirrors the finding already
     documented in `test/tools/write.test.ts` (its "deterministic injected
     race" section): because `performWrite` holds the file lock for its
     *whole* transaction (write + index + commit), a bare `Promise.all`
     race reliably lands the loser's lock-acquire attempt **while** the
     winner still holds it, rather than after release — so this test
     asserts **exactly one** of the two calls succeeds and the other fails
     with `"locked"`, deterministically in this run. The final file content
     is read back and asserted to equal exactly the winner's body
     (newline-framing aside) — proving no interleaved/corrupted bytes and
     no silent last-write-wins, because the loser never wrote at all.
3. **Shared is genuinely shared** — alice writes `kitchen-reno-budget.md`
   through the canonical-shared vault; a subsequent read *as bob* (through
   the same canonical-shared vault root, differentiated only by
   `AccessContext` per U3's decision) returns the new content.

Result: 5/5 passing (`npx vitest run experiments/gharonda-private-shared/`:
45/45 across U1–U3).

**Honest caveat on concurrency fidelity:** all of the above runs in a single
Node process/vitest worker, so "two principals' processes" are simulated as
two concurrent async calls into the same in-process `vaultWrite`, not two
real OS processes. This is the same fidelity level `test/tools/write.test.ts`
itself operates at for its own lock-contention tests, and the mechanism
under test — `src/access/locks.ts`'s SQLite-backed lock — is deliberately
file-based (not in-memory/mutex), so it enforces identically whether the two
callers are two `await` chains in one process or two real OS processes
hitting the same `locks.db`; genuine multi-process contention was not
additionally exercised here.
