// Self-write suppression for the fs.watch reactive indexer.
//
// The write-path tools (vault_write, vault_append, vault_promote,
// vault_deprecate) already call indexDocument() in-process after writing the
// file to disk. The chokidar watcher will *also* see that write as an `add` /
// `change` event and would queue a redundant re-index. To avoid the duplicate
// work we mark each path the writer just touched and the watcher silently
// drops events whose path is still in the set.
//
// Implementation: a Map<absPath, expiresAt>. The writer calls
// noteSelfWrite(absPath) after the file is on disk and indexDocument() has
// returned, so by the time chokidar fires (no earlier than its 500ms
// per-path debounce window elapses) the path is already registered. The
// watcher calls consumeSelfWrite(absPath) when an event fires; if the path is
// present and the TTL has not lapsed, the event is dropped and the entry is
// removed. Expired entries are purged lazily on every check.
//
// Keys are normalized via path.resolve() so the writer and watcher agree on
// "the same path" regardless of how each side formed it (chokidar may emit
// paths with no symlink resolution; node:path.resolve does the same on macOS).

import { resolve } from "node:path";

// 1 second is long enough to cover the watcher's 500ms debounce window plus
// some slack for FSEvents latency, and short enough that a *real* external
// edit that lands within the window is at worst delayed-not-dropped: the next
// edit will still fire after the set has expired.
const SELF_WRITE_TTL_MS = 1_000;

const pending = new Map<string, number>();

function purgeExpired(now: number): void {
  for (const [key, expiresAt] of pending) {
    if (expiresAt <= now) pending.delete(key);
  }
}

// Register a path that Daftari itself just wrote so the watcher ignores its
// next event for that path. Path is resolved to its absolute form so the
// watcher's normalised path matches regardless of how it was supplied.
export function noteSelfWrite(absPath: string, now: number = Date.now()): void {
  purgeExpired(now);
  pending.set(resolve(absPath), now + SELF_WRITE_TTL_MS);
}

// True if `absPath` is currently in the self-write set. When true the entry is
// consumed (a single self-write covers a single watcher event) so a second,
// genuinely-external edit shortly after is not silently dropped.
export function consumeSelfWrite(absPath: string, now: number = Date.now()): boolean {
  purgeExpired(now);
  const key = resolve(absPath);
  const expiresAt = pending.get(key);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    pending.delete(key);
    return false;
  }
  pending.delete(key);
  return true;
}

// Tests load multiple suites against the singleton; clearing between them
// keeps cross-test pollution out of the set.
export function resetSelfWriteState(): void {
  pending.clear();
}
