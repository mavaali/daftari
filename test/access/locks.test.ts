import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOCK_TTL_MS,
  acquireLock,
  getLock,
  isLocked,
  openLockDb,
  releaseLock,
  type LockDb,
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
});
