// Deterministically forces the "delayed writer" lost-update race for a
// read-modify-write tool that defaults its optimistic-concurrency token to the
// load-time content hash (TargetDocument.contentHash, src/tools/write.ts):
// intercepts the tool's FIRST internal readFile call for the target path, and
// — as a side effect of that call, before it returns — lands a genuinely
// concurrent write. The tool under test then builds its mutation from
// pre-concurrent-write bytes while the disk already holds the concurrent
// write: the same non-overlapping-lease-window shape as the issue #14 A/B
// race (write.test.ts), except forced instead of hoped-for.
//
// A tool that still passes no base_version by default would silently clobber
// the concurrent write (the exact bug this fix closes); a tool wired through
// retryOnStale detects the mismatch inside the write lock, reloads, and
// recomputes — the concurrent write survives.
//
// Why not plain Promise.all: measured directly against this repo's fixture
// vault, the winner of a Promise.all race holds the file lock for its WHOLE
// transaction (write + index + commit), so the loser's synchronous
// lock-acquire attempt collides WHILE the winner still holds it (a correct,
// already-loud "locked by" rejection) far more often than it arrives after
// release with a stale snapshot — across 40+ sampled trials in both call
// orders, the stale-branch was never reached. This helper removes the timing
// dependency entirely instead of relying on scheduler luck.
import { vi } from "vitest";
import * as localStorage from "../../src/storage/local.js";

export async function withInjectedRace<T>(
  targetAbsPath: string,
  landConcurrentChange: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  const original = localStorage.readFile;
  let triggered = false;
  const spy = vi.spyOn(localStorage, "readFile").mockImplementation(async (p: string) => {
    const value = await original(p);
    if (!triggered && p === targetAbsPath) {
      triggered = true;
      await landConcurrentChange();
    }
    return value;
  });
  try {
    return await run();
  } finally {
    spy.mockRestore();
  }
}
