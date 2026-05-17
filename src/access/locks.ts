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

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { err, ok, type Result } from "../frontmatter/types.js";

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
    purgeExpired(db, now);
    const existing = db.prepare("SELECT * FROM locks WHERE path = ?").get(path) as
      | LockRow
      | undefined;
    if (existing && existing.holder !== holder) {
      return err(
        new Error(
          `file is locked by ${existing.holder}: ${path} ` +
            `(expires in ${Math.max(0, existing.expires_at - now)}ms)`,
        ),
      );
    }
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
