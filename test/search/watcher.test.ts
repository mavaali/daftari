// fs.watch reactive indexer tests.
//
// Most cases drive the watcher through an injected fake chokidar-shaped
// EventEmitter so the suite is fast and deterministic — no FSEvents latency,
// no actual file I/O timing. One real-chokidar smoke test at the end confirms
// the wire-up against the live filesystem.

import { EventEmitter } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { err, ok, type Result } from "../../src/frontmatter/types.js";
import { getInflightPaths, resetIndexState } from "../../src/search/index-state.js";
import { noteSelfWrite, resetSelfWriteState } from "../../src/search/self-write.js";
import { startWatcher } from "../../src/search/watcher.js";

// Sleep helper: tests use a tiny debounce window (20ms) so a single waitFor
// covers both the debounce timer and the indexFn microtask resolution.
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// chokidar's surface for our watcher is small: it emits add/change/unlink/error
// and exposes a close() Promise. An EventEmitter with a stub close() is a
// faithful enough double for the unit tests.
class FakeChokidar extends EventEmitter {
  public closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }
}

// Absolute paths only — the watcher rejects relative ones.
function abs(vault: string, rel: string): string {
  return join(vault, ...rel.split("/"));
}

// Resolves to the same separator chokidar emits on this OS.
function osPath(p: string): string {
  return sep === "/" ? p : p.split("/").join(sep);
}

describe("startWatcher", () => {
  let vault: string;

  beforeEach(async () => {
    vault = await mkdtemp();
    resetIndexState();
    resetSelfWriteState();
  });

  afterEach(async () => {
    await rm(vault, { recursive: true, force: true });
    resetIndexState();
    resetSelfWriteState();
  });

  it("debounces a burst of change events into one indexFn call", async () => {
    const fake = new FakeChokidar();
    const calls: string[] = [];
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
      indexFn: async (_root, relPath) => {
        calls.push(relPath);
        return ok(undefined);
      },
    });

    // Fire 5 change events for the same file inside the debounce window.
    for (let i = 0; i < 5; i++) {
      fake.emit("change", osPath(abs(vault, "notes/a.md")));
    }
    await sleep(60);
    expect(calls).toEqual(["notes/a.md"]);

    await w.close();
  });

  it("routes an external add to indexFn", async () => {
    const fake = new FakeChokidar();
    const calls: string[] = [];
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
      indexFn: async (_root, relPath) => {
        calls.push(relPath);
        return ok(undefined);
      },
    });

    fake.emit("add", osPath(abs(vault, "pricing/new.md")));
    await sleep(60);
    expect(calls).toEqual(["pricing/new.md"]);

    await w.close();
  });

  it("routes an external unlink to deleteFn when the file is really gone", async () => {
    const fake = new FakeChokidar();
    const deleted: string[] = [];
    const indexed: string[] = [];
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
      indexFn: async (_root, relPath) => {
        indexed.push(relPath);
        return ok(undefined);
      },
      deleteFn: async (_root, relPath) => {
        deleted.push(relPath);
        return ok(undefined);
      },
      statFn: async () => ({ exists: false }),
    });

    fake.emit("unlink", osPath(abs(vault, "pricing/old.md")));
    await sleep(60);
    expect(deleted).toEqual(["pricing/old.md"]);
    expect(indexed).toEqual([]);

    await w.close();
  });

  it("re-stats on unlink and treats a still-present file as a change", async () => {
    // Phantom unlink+add pair during atomic-rename saves (FSEvents, iCloud,
    // Dropbox): the file is gone for a single tick then re-appears. The
    // watcher's debounce-then-re-stat must NOT delete it.
    const fake = new FakeChokidar();
    const deleted: string[] = [];
    const indexed: string[] = [];
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
      indexFn: async (_root, relPath) => {
        indexed.push(relPath);
        return ok(undefined);
      },
      deleteFn: async (_root, relPath) => {
        deleted.push(relPath);
        return ok(undefined);
      },
      // statFn reports the file is present — same outcome as if the add
      // arrived inside the debounce window.
      statFn: async () => ({ exists: true }),
    });

    fake.emit("unlink", osPath(abs(vault, "competitive-intel/note.md")));
    await sleep(60);
    expect(deleted).toEqual([]);
    expect(indexed).toEqual(["competitive-intel/note.md"]);

    await w.close();
  });

  it("treats unlink followed by add inside the debounce window as a change", async () => {
    // Same scenario via the event sequence rather than statFn: the second
    // event resets the timer and overwrites lastEvent to "add", so by the
    // time dispatch fires we never enter the unlink branch.
    const fake = new FakeChokidar();
    const deleted: string[] = [];
    const indexed: string[] = [];
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 30,
      indexFn: async (_root, relPath) => {
        indexed.push(relPath);
        return ok(undefined);
      },
      deleteFn: async (_root, relPath) => {
        deleted.push(relPath);
        return ok(undefined);
      },
      statFn: async () => ({ exists: false }),
    });

    fake.emit("unlink", osPath(abs(vault, "pricing/x.md")));
    await sleep(5);
    fake.emit("add", osPath(abs(vault, "pricing/x.md")));
    await sleep(60);
    expect(deleted).toEqual([]);
    expect(indexed).toEqual(["pricing/x.md"]);

    await w.close();
  });

  it("drops events whose path was just self-written by Daftari", async () => {
    const fake = new FakeChokidar();
    const calls: string[] = [];
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
      indexFn: async (_root, relPath) => {
        calls.push(relPath);
        return ok(undefined);
      },
    });

    noteSelfWrite(abs(vault, "pricing/written.md"));
    fake.emit("change", osPath(abs(vault, "pricing/written.md")));
    await sleep(60);
    expect(calls).toEqual([]);

    await w.close();
  });

  it("only the first event after a self-write is suppressed", async () => {
    // The self-write set is single-use: a *second* genuinely external edit
    // after Daftari's own write must be re-indexed, not silently dropped
    // forever.
    const fake = new FakeChokidar();
    const calls: string[] = [];
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
      indexFn: async (_root, relPath) => {
        calls.push(relPath);
        return ok(undefined);
      },
    });

    noteSelfWrite(abs(vault, "pricing/foo.md"));
    fake.emit("change", osPath(abs(vault, "pricing/foo.md")));
    await sleep(60);
    expect(calls).toEqual([]);

    // Second event — not preceded by a self-write — must fire.
    fake.emit("change", osPath(abs(vault, "pricing/foo.md")));
    await sleep(60);
    expect(calls).toEqual(["pricing/foo.md"]);

    await w.close();
  });

  it("ignores .daftari/** events even if chokidar leaks them", async () => {
    // The chokidar `ignored` option already filters these at watch time;
    // the dispatch-level check is a defense in depth for macOS quirks. We
    // verify it directly by emitting a fake event for a .daftari path.
    const fake = new FakeChokidar();
    const calls: string[] = [];
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
      indexFn: async (_root, relPath) => {
        calls.push(relPath);
        return ok(undefined);
      },
    });

    fake.emit("change", osPath(abs(vault, ".daftari/index.db")));
    fake.emit("change", osPath(abs(vault, ".git/HEAD")));
    fake.emit("change", osPath(abs(vault, ".DS_Store")));
    await sleep(60);
    expect(calls).toEqual([]);

    await w.close();
  });

  it("ignores non-markdown files", async () => {
    const fake = new FakeChokidar();
    const calls: string[] = [];
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
      indexFn: async (_root, relPath) => {
        calls.push(relPath);
        return ok(undefined);
      },
    });

    fake.emit("change", osPath(abs(vault, "pricing/image.png")));
    fake.emit("change", osPath(abs(vault, "pricing/data.yaml")));
    fake.emit("change", osPath(abs(vault, "pricing/note.md")));
    await sleep(60);
    expect(calls).toEqual(["pricing/note.md"]);

    await w.close();
  });

  it("logs index errors and does not crash", async () => {
    const fake = new FakeChokidar();
    const logs: string[] = [];
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
      log: (msg) => logs.push(msg),
      indexFn: async (): Promise<Result<unknown, Error>> => err(new Error("boom")),
    });

    fake.emit("change", osPath(abs(vault, "pricing/a.md")));
    await sleep(60);
    expect(logs.some((m) => m.includes("index update failed") && m.includes("boom"))).toBe(true);

    await w.close();
  });

  it("marks the path in-flight while indexing, then clears it", async () => {
    const fake = new FakeChokidar();
    let resolveIndex: (() => void) | null = null;
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
      indexFn: async (_root, _relPath) => {
        await new Promise<void>((r) => {
          resolveIndex = r;
        });
        return ok(undefined);
      },
    });

    fake.emit("change", osPath(abs(vault, "pricing/slow.md")));
    // Wait past the debounce window so dispatch starts.
    await sleep(40);
    expect(getInflightPaths()).toContain("pricing/slow.md");

    // Let the indexer finish.
    resolveIndex?.();
    await sleep(20);
    expect(getInflightPaths()).not.toContain("pricing/slow.md");

    await w.close();
  });

  it("close() clears pending timers and prevents further dispatches", async () => {
    const fake = new FakeChokidar();
    const calls: string[] = [];
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 30,
      indexFn: async (_root, relPath) => {
        calls.push(relPath);
        return ok(undefined);
      },
    });

    fake.emit("change", osPath(abs(vault, "pricing/race.md")));
    // Close before the debounce window elapses — the pending timer should
    // be cleared and the indexer never called.
    await w.close();
    await sleep(60);
    expect(calls).toEqual([]);
    expect(fake.closed).toBe(true);
  });

  it("real chokidar: external change triggers indexFn", async () => {
    // One end-to-end smoke test against the real chokidar to confirm the
    // wire-up. Uses a slightly larger debounce window so FSEvents has a
    // chance to deliver, and writes the file twice with a delay so a single
    // late-delivery event does not flake.
    const filePath = abs(vault, "live.md");
    await writeFile(filePath, "# initial\n");

    const calls: string[] = [];
    const w = startWatcher(vault, {
      debounceMs: 100,
      indexFn: async (_root, relPath) => {
        calls.push(relPath);
        return ok(undefined);
      },
    });

    // chokidar's `ready` event fires asynchronously after the initial walk;
    // a short sleep gives it time to set up watches before our edit.
    await sleep(300);

    await writeFile(filePath, "# changed\n");
    // Wait well past the debounce window. FSEvents on macOS can take
    // hundreds of ms to deliver — 1500ms is generous but bounded.
    await sleep(1500);

    await w.close();
    expect(calls).toContain("live.md");
  }, 10_000);
});

// Local mkdtemp to avoid pulling the existing temp-vault helper (which copies
// the sample fixture — heavier than we need for watcher unit tests).
async function mkdtemp(): Promise<string> {
  const dir = join(tmpdir(), `daftari-watch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}
