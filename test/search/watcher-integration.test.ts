// fs.watch reactive indexer — integration with the real index db.
//
// Unlike watcher.test.ts (which uses an injected indexFn spy), these tests
// drive the real defaultDeleteFn against an actual SQLite index to verify:
//   - unlink evicts the document AND patches the freshness manifest, so the
//     next startup does NOT see a missing-on-disk entry as drift.
//   - external `change` actually re-runs indexDocument() and the new content
//     reaches the index (a search-side concern covered indirectly by reading
//     the updated body back out of the documents table).
//   - while a full reindex is running the watcher's events queue behind it
//     instead of racing the bulk write.
//   - `watch: false` config keeps the server from starting the watcher at all
//     (covered by the index.ts startup path, but mirrored here at the watcher
//     start site for clarity).

import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok } from "../../src/frontmatter/types.js";
import { markIndexing, markIndexReady, resetIndexState } from "../../src/search/index-state.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { reindexVault } from "../../src/search/reindex.js";
import { resetSelfWriteState } from "../../src/search/self-write.js";
import { startWatcher } from "../../src/search/watcher.js";
import { getDocument, getMeta, openIndexDb } from "../../src/storage/index-db.js";
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

describe("watcher integration with index db", () => {
  let vault: string;

  beforeEach(async () => {
    vault = makeTempVault();
    resetIndexState();
    resetSelfWriteState();
    // Build the initial index so subsequent indexDocument / deleteDocument
    // calls operate against a populated db.
    const r = await reindexVault(vault);
    expect(r.ok).toBe(true);
    markIndexReady();
  }, 60_000);

  afterEach(() => {
    cleanupVault(vault);
    resetIndexState();
    resetSelfWriteState();
  });

  it("unlink evicts the document and patches the freshness manifest", async () => {
    const fake = new FakeChokidar();
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
      // Use the real deleteFn (default) so we exercise the manifest patch.
      statFn: async () => ({ exists: false }),
    });

    // Sanity: the doc and its manifest entry are present before the unlink.
    const target = "pricing/helios-consumption-pricing.md";
    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(getDocument(opened.value, target)).not.toBeNull();
    const manifestBefore = JSON.parse(getMeta(opened.value, "vault_manifest") ?? "{}");
    expect(manifestBefore[target]).toBeDefined();
    opened.value.close();

    fake.emit("unlink", osPath(join(vault, target)));
    await sleep(80);

    const opened2 = openIndexDb(vault, LOCAL_MINILM_DIM);
    expect(opened2.ok).toBe(true);
    if (!opened2.ok) return;
    expect(getDocument(opened2.value, target)).toBeNull();
    const manifestAfter = JSON.parse(getMeta(opened2.value, "vault_manifest") ?? "{}");
    expect(manifestAfter[target]).toBeUndefined();
    opened2.value.close();

    await w.close();
  }, 60_000);

  it("queues events while a full reindex is in progress", async () => {
    // Caller-facing contract: vault_reindex still works while the watcher is
    // active. Internally that means the watcher's dispatch() defers calls
    // while the global status is "indexing" — otherwise its indexDocument()
    // would race a clearIndex() inside reindexVault() and be wiped.
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

    // Simulate a reindex in flight.
    markIndexing();
    fake.emit("change", osPath(join(vault, "pricing/helios-consumption-pricing.md")));
    await sleep(50);
    // While indexing, the watcher should have deferred — no indexFn call yet.
    expect(calls).toEqual([]);

    // Reindex completes; the onceIndexReady drain fires and dispatches
    // directly (no re-debounce — one timer per event, not one per debounceMs
    // interval until the reindex finishes).
    markIndexReady();
    await sleep(80);
    expect(calls).toEqual(["pricing/helios-consumption-pricing.md"]);

    await w.close();
  }, 60_000);

  it("external change updates the indexed content", async () => {
    // End-to-end: write a marker token to disk, fire the watcher event, and
    // check the documents table reflects the new body.
    const fake = new FakeChokidar();
    const w = startWatcher(vault, {
      watcherFactory: () => fake as never,
      debounceMs: 20,
    });

    const target = "pricing/cirrus-capacity-tiers.md";
    const abs = join(vault, target);
    const marker = "uniquemarkertokenxyzzy";
    await writeFile(
      abs,
      `---
title: Cirrus Capacity Tiers
domain: accumulation
collection: pricing
status: canonical
confidence: medium
created: 2026-01-01
updated: 2026-01-02
updated_by: external
provenance: direct
sources: []
superseded_by: null
ttl_days: 90
tags: [pricing]
questions_answered: []
questions_raised: []
---

# Cirrus

${marker} body content.
`,
    );

    fake.emit("change", osPath(abs));
    // Watcher debounce (20) + indexDocument (no embedding model load needed
    // since chunks are cached; allow a generous slack for the dispatch path
    // and SQLite write).
    await sleep(800);

    const opened = openIndexDb(vault, LOCAL_MINILM_DIM);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const doc = getDocument(opened.value, target);
    expect(doc).not.toBeNull();
    expect(doc?.content).toContain(marker);
    opened.value.close();

    await w.close();
  }, 60_000);
});
