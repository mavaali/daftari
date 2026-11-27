// File-level write locks, SQLite-backed.
//
// A write to a vault document acquires an exclusive lock on its path for the
// duration of the operation. Locks carry a 60-second TTL: a lock whose
// expires_at has passed is treated as released, so a crashed or hung writer
// can never wedge a file permanently. There is no background reaper — TTL is
// enforced lazily, on every acquire/isLocked check.
//
// Locks live in their own .daftari/locks.db (separate from the search index)
// so a reindex never disturbs them. The file is still ephemeral: every lock
// expires within a minute, so a lost locks.db costs nothing.
//
// Dead same-host holders (54pq). A minted holder records its pid and a tag of
// its host (leaseHostTag), so a lease left by a crashed process need not wedge
// the path for the full TTL: when the holder's host tag is ours and its pid is
// dead (`process.kill(pid, 0)` → ESRCH), acquireLock purges the lease at once.
// A lease from another host, or one whose holder records no host (an older
// daftari, a raw agent string), is never judged by pid — it waits out the TTL.

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { err, ok, type Result } from "../frontmatter/types.js";
import { hostId, isProcessAlive } from "../lifecycle/lock.js";

export type LockDb = Database.Database;

export const LOCK_TTL_MS = 60_000;

export interface Lock {
  path: string;
  holder: string;
  acquiredAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

export function lockDbPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "locks.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS locks (
  path        TEXT PRIMARY KEY,
  holder      TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
`;

export function openLockDb(vaultRoot: string): Result<LockDb, Error> {
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    const db = new Database(lockDbPath(vaultRoot));
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);
    return ok(db);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot open lock db: ${reason}`));
  }
}

interface LockRow {
  path: string;
  holder: string;
  acquired_at: number;
  expires_at: number;
}

function rowToLock(row: LockRow): Lock {
  return {
    path: row.path,
    holder: row.holder,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

// Drops every lock whose TTL has passed. Called before each acquire so an
// expired lock is auto-released without a separate reaper.
function purgeExpired(db: LockDb, now: number): void {
  db.prepare("DELETE FROM locks WHERE expires_at <= ?").run(now);
}

// Mints a per-mutation lease holder: unique on every call, even for the same
// agent, so two overlapping mutations claiming the same free-text `agent`
// string never false-share a lock (acquireLock treats a matching holder as a
// TTL-refreshing re-acquire, not contention). The agent is kept as a
// readable suffix so the existing contention message — which prints the raw
// holder — still ends with the acting identity. Callers must mint exactly
// once per mutation attempt and pass that same value to both acquireLock and
// its paired releaseLock; a fresh mint at the release site unpairs them and
// releaseLock silently no-ops instead of erroring.
export function mintLeaseHolder(agent: string): string {
  return `${process.pid}@${leaseHostTag()}:${randomUUID()}:${agent}`;
}

// This host's tag in a lease holder: a short hash of the process lock's host
// identity (hostname, plus boot id and pid namespace on Linux, so sandboxes
// or containers sharing a kernel never read each other's pids as local).
// Hashed so the holder stays `:`-free up to the nonce.
let cachedHostTag: string | undefined;
export function leaseHostTag(): string {
  cachedHostTag ??= createHash("sha256").update(hostId()).digest("hex").slice(0, 12);
  return cachedHostTag;
}

// True when `holder` was minted on this host by a process that has since
// died — its lease can never be released or renewed by its owner.
function isDeadLocalHolder(holder: string): boolean {
  const m = /^(\d+)@([0-9a-f]+):/.exec(holder);
  if (!m || m[2] !== leaseHostTag()) return false;
  const pid = Number(m[1]);
  return pid > 0 && pid !== process.pid && !isProcessAlive(pid);
}

// Acquires an exclusive lock on `path` for `holder`. Fails if the file is held
// by a *different* holder under a still-live TTL. Re-acquiring a lock the same
// holder already owns succeeds and refreshes the TTL. `now` is injectable for
// deterministic tests.
export function acquireLock(
  db: LockDb,
  path: string,
  holder: string,
  now: number = Date.now(),
): Result<Lock, Error> {
  if (typeof path !== "string" || path.length === 0) {
    return err(new Error("acquireLock requires a non-empty path"));
  }
  if (typeof holder !== "string" || holder.length === 0) {
    return err(new Error("acquireLock requires a non-empty holder"));
  }
  try {
    // One IMMEDIATE transaction: the purge, the check and the claim see one
    // state, so a purge of a dead holder can never clobber a live claimer.
    const claim = db.transaction((): Result<Lock, Error> => {
      purgeExpired(db, now);
      const existing = db.prepare("SELECT * FROM locks WHERE path = ?").get(path) as
        | LockRow
        | undefined;
      if (existing && existing.holder !== holder && !isDeadLocalHolder(existing.holder)) {
        return err(
          new Error(
            `file is locked by ${existing.holder}: ${path} ` +
              `(expires in ${Math.max(0, existing.expires_at - now)}ms)`,
          ),
        );
      }
      // A dead same-host holder's row (54pq) is simply replaced here.
      const lock: Lock = {
        path,
        holder,
        acquiredAt: now,
        expiresAt: now + LOCK_TTL_MS,
      };
      db.prepare(
        `INSERT OR REPLACE INTO locks (path, holder, acquired_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      ).run(lock.path, lock.holder, lock.acquiredAt, lock.expiresAt);
      return ok(lock);
    });
    return claim.immediate();
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot acquire lock: ${reason}`));
  }
}

// Releases a lock. Only the holder may release its own lock; releasing a lock
// held by someone else (or one that no longer exists) is a no-op that reports
// `released: false` rather than an error.
export function releaseLock(
  db: LockDb,
  path: string,
  holder: string,
): Result<{ released: boolean }, Error> {
  try {
    const info = db.prepare("DELETE FROM locks WHERE path = ? AND holder = ?").run(path, holder);
    return ok({ released: info.changes > 0 });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot release lock: ${reason}`));
  }
}

// True if `path` carries a lock whose TTL has not yet passed.
export function isLocked(db: LockDb, path: string, now: number = Date.now()): boolean {
  const row = db.prepare("SELECT expires_at FROM locks WHERE path = ?").get(path) as
    | { expires_at: number }
    | undefined;
  return row !== undefined && row.expires_at > now;
}

// Returns the live lock on `path`, or null if none / expired.
export function getLock(db: LockDb, path: string, now: number = Date.now()): Lock | null {
  const row = db.prepare("SELECT * FROM locks WHERE path = ?").get(path) as LockRow | undefined;
  if (!row || row.expires_at <= now) return null;
  return rowToLock(row);
}
