// Self-write suppression integration test.
//
// The unit tests in watcher.test.ts already exercise the watcher's
// consumeSelfWrite() branch with a hand-rolled noteSelfWrite() call. This
// suite verifies the *wiring*: that the write-path tools (vault_write
// specifically — the others share performWrite) register the absolute path
// after their in-process indexDocument() call, so the watcher's subsequent
// event for that same write is dropped.
//
// This is the part the locked design called out as "most likely to surprise":
// the registration has to happen AFTER the file is on disk so the chokidar
// event has not arrived yet but the path is in the set by the time the
// watcher's debounce window fires.

import { EventEmitter } from "node:events";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok } from "../../src/frontmatter/types.js";
import { resetIndexState } from "../../src/search/index-state.js";
import { resetSelfWriteState } from "../../src/search/self-write.js";
import { startWatcher } from "../../src/search/watcher.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

function osPath(p: string): string {
  return sep === "/" ? p : p.split("/").join(sep);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class FakeChokidar extends EventEmitter {
  public closed = false;
  async close(): Promise<void> {
    this.closed = true;
  }
}

const AGENT = "agent:claude-code";

function newFrontmatter(): Record<string, unknown> {
  return {
    title: "Self-Write Test",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-05-01",
    updated: "2026-05-01",
    updated_by: "agent:seed",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: ["pricing"],
  };
}

describe("self-write suppression — write tool wire-up", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
    resetIndexState();
    resetSelfWriteState();
  });

  afterEach(() => {
    cleanupVault(vault);
    resetIndexState();
    resetSelfWriteState();
  });

  it("vault_write registers the path so the watcher's event is dropped", async () => {
    const fake = new FakeChokidar();
    const watcherCalls: string[] = [];
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
      indexFn: async (_root, relPath) => {
        watcherCalls.push(relPath);
        return ok(undefined);
      },
    });

    // The write tool's own indexDocument() call runs against the real
    // index — fine for this test, the sample vault has been pre-indexed
    // by the helper's parent setup. (If the index is empty, vault_write
    // falls back to reindexVault internally; both paths still call
    // noteSelfWrite after.)
    const result = await vaultWrite(vault, {
      path: "pricing/new-self-write.md",
      body: "# Self-write\n\nBody.\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    // Now the watcher sees the file appear (chokidar's `add`). With the
    // wire-up working, the path is in the self-write set and the event
    // is dropped silently — no indexFn call.
    fake.emit("add", osPath(join(vault, "pricing/new-self-write.md")));
    await sleep(60);
    expect(watcherCalls).toEqual([]);

    await w.close();
  }, 60_000);

  it("a later external edit to the same path is NOT suppressed", async () => {
    const fake = new FakeChokidar();
    const watcherCalls: string[] = [];
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
      indexFn: async (_root, relPath) => {
        watcherCalls.push(relPath);
        return ok(undefined);
      },
    });

    const result = await vaultWrite(vault, {
      path: "pricing/edit-me.md",
      body: "# Edit\n\nBody.\n",
      frontmatter: newFrontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    // First event drops on the self-write set.
    fake.emit("change", osPath(join(vault, "pricing/edit-me.md")));
    await sleep(60);
    expect(watcherCalls).toEqual([]);

    // Self-write set is single-use; a follow-up external change fires.
    fake.emit("change", osPath(join(vault, "pricing/edit-me.md")));
    await sleep(60);
    expect(watcherCalls).toEqual(["pricing/edit-me.md"]);

    await w.close();
  }, 60_000);
});
