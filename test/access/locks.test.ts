import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  getLock,
  isLocked,
  LOCK_TTL_MS,
  type LockDb,
  leaseHostTag,
  mintLeaseHolder,
  openLockDb,
  releaseLock,
} from "../../src/access/locks.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const PATH = "pricing/foo.md";
const ALICE = "agent:alice";
const BOB = "agent:bob";

describe("locks", () => {
  let vault: string;
  let db: LockDb;

  beforeEach(() => {
    vault = makeTempVault();
    const opened = openLockDb(vault);
    if (!opened.ok) throw opened.error;
    db = opened.value;
  });

  afterEach(() => {
    db.close();
    cleanupVault(vault);
  });

  it("acquires a lock and reports it as held", () => {
    const result = acquireLock(db, PATH, ALICE, 1_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.holder).toBe(ALICE);
    expect(result.value.expiresAt).toBe(1_000 + LOCK_TTL_MS);
    expect(isLocked(db, PATH, 1_000)).toBe(true);
  });

  it("reports an un-acquired path as not locked", () => {
    expect(isLocked(db, PATH)).toBe(false);
    expect(getLock(db, PATH)).toBeNull();
  });

  it("blocks a second holder while the first lock is live", () => {
    const first = acquireLock(db, PATH, ALICE, 1_000);
    expect(first.ok).toBe(true);

    // Contention: Bob tries to lock the same file 1s later, well inside TTL.
    const second = acquireLock(db, PATH, BOB, 2_000);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error.message).toContain(ALICE);
  });

  it("lets the same holder re-acquire and refresh its own lock", () => {
    acquireLock(db, PATH, ALICE, 1_000);
    const again = acquireLock(db, PATH, ALICE, 5_000);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.expiresAt).toBe(5_000 + LOCK_TTL_MS);
  });

  it("releases a lock so another holder can take it", () => {
    acquireLock(db, PATH, ALICE, 1_000);
    const released = releaseLock(db, PATH, ALICE);
    expect(released.ok && released.value.released).toBe(true);
    expect(isLocked(db, PATH, 1_000)).toBe(false);

    const bob = acquireLock(db, PATH, BOB, 1_100);
    expect(bob.ok).toBe(true);
  });

  it("treats a release by a non-holder as a no-op", () => {
    acquireLock(db, PATH, ALICE, 1_000);
    const released = releaseLock(db, PATH, BOB);
    expect(released.ok && released.value.released).toBe(false);
    // Alice's lock is untouched.
    expect(isLocked(db, PATH, 1_000)).toBe(true);
  });

  it("auto-releases a lock once its 60s TTL has passed", () => {
    acquireLock(db, PATH, ALICE, 1_000);
    const justBefore = 1_000 + LOCK_TTL_MS - 1;
    const justAfter = 1_000 + LOCK_TTL_MS + 1;
    expect(isLocked(db, PATH, justBefore)).toBe(true);
    expect(isLocked(db, PATH, justAfter)).toBe(false);

    // An expired lock no longer blocks a different holder.
    const bob = acquireLock(db, PATH, BOB, justAfter);
    expect(bob.ok).toBe(true);
  });

  it("locks paths independently", () => {
    acquireLock(db, "pricing/a.md", ALICE, 1_000);
    expect(isLocked(db, "pricing/b.md", 1_000)).toBe(false);
    const bobElsewhere = acquireLock(db, "pricing/b.md", BOB, 1_000);
    expect(bobElsewhere.ok).toBe(true);
  });

  describe("mintLeaseHolder (S3-a)", () => {
    it("mints a distinct holder on every call, even for the same agent", () => {
      const a = mintLeaseHolder(ALICE);
      const b = mintLeaseHolder(ALICE);
      expect(a).not.toBe(b);
    });

    it("keeps the agent as a readable suffix, so contention messages stay informative", () => {
      const holder = mintLeaseHolder(ALICE);
      expect(holder.endsWith(`:${ALICE}`)).toBe(true);
    });

    // The S3-a regression test: two mutation attempts by the same agent must
    // mutually exclude on the same path. Against today's wiring — the raw
    // agent string passed straight through as holder — this scenario
    // false-shares: acquireLock treats same-holder as a TTL-refreshing
    // re-acquire (locks.ts:98), so both callers would wrongly succeed.
    it("mutually excludes two same-agent mutations on the same path", () => {
      const first = acquireLock(db, PATH, mintLeaseHolder(ALICE), 1_000);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const second = acquireLock(db, PATH, mintLeaseHolder(ALICE), 1_100);
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.message).toContain(first.value.holder);
    });
  });

  // 54pq: a decider that crashed mid-lease used to block every retry for the
  // full 60s TTL. A lease whose holder ran on this host under a pid that is
  // now dead is purged at once; anything else waits out the TTL as before.
  describe("dead same-host holder (54pq)", () => {
    // A pid that certainly existed on this host and has exited.
    function deadPid(): number {
      const child = spawnSync(process.execPath, ["-e", ""]);
      if (child.pid === undefined) throw new Error("spawn failed");
      return child.pid;
    }

    it("records this host's tag in every minted holder", () => {
      expect(mintLeaseHolder(ALICE).startsWith(`${process.pid}@${leaseHostTag()}:`)).toBe(true);
    });

    it("purges a lease held by a dead pid on this host immediately, well inside the TTL", () => {
      const crashed = `${deadPid()}@${leaseHostTag()}:00000000-dead:${ALICE}`;
      expect(acquireLock(db, PATH, crashed, 1_000).ok).toBe(true);
      const retry = acquireLock(db, PATH, mintLeaseHolder(BOB), 1_100);
      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.value.holder.endsWith(`:${BOB}`)).toBe(true);
    });

    it("never purges a dead pid recorded by another host — its pid means nothing here", () => {
      const foreign = `${deadPid()}@another-host-tag:00000000-dead:${ALICE}`;
      expect(acquireLock(db, PATH, foreign, 1_000).ok).toBe(true);
      const retry = acquireLock(db, PATH, mintLeaseHolder(BOB), 1_100);
      expect(retry.ok).toBe(false);
      // ...until the TTL lapses, as before.
      expect(acquireLock(db, PATH, mintLeaseHolder(BOB), 1_000 + LOCK_TTL_MS).ok).toBe(true);
    });

    it("never purges a holder that records no host (older format or a raw agent string)", () => {
      const legacy = `${deadPid()}:00000000-dead:${ALICE}`;
      expect(acquireLock(db, PATH, legacy, 1_000).ok).toBe(true);
      expect(acquireLock(db, PATH, mintLeaseHolder(BOB), 1_100).ok).toBe(false);
    });

    it("keeps a live same-host holder's lease", () => {
      const live = mintLeaseHolder(ALICE); // this process: alive
      expect(acquireLock(db, PATH, live, 1_000).ok).toBe(true);
      expect(acquireLock(db, PATH, mintLeaseHolder(BOB), 1_100).ok).toBe(false);
    });
  });
});
