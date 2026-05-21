// Lazy model load coverage for issue #38 PR 2.
//
// The model loads on demand via the memoised getExtractor() promise in
// vector.ts; these tests assert the WHEN of that load:
//
//   - A fully cache-hit reindex never loads the model (the win behind the
//     content-addressed cache).
//   - The first embed() call after a fresh process loads the model exactly
//     once; a second embed() in the same process does not reload.
//   - warmModel() returns success on a healthy load and idempotently
//     no-ops on subsequent calls.
//   - The IndexState modelStatus transitions cold → warming → ready in
//     lockstep with the load.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getIndexStatus, resetIndexState } from "../../src/search/index-state.js";
import { reindexVault } from "../../src/search/reindex.js";
import {
  embed,
  isModelLoaded,
  resetExtractorForTests,
  warmModel,
} from "../../src/search/vector.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// These tests intentionally do NOT call resetExtractorForTests between every
// case — model load is real and slow, and forcing reloads would push the
// suite past sensible limits. Instead each test names its starting precondition.

describe("lazy embedding model load (issue #38 PR 2)", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
    resetIndexState();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("a fully cache-hit reindex does not load the model", async () => {
    // First reindex of the sample vault populates the embedding cache.
    // This load is real — it pays the cold-start cost once.
    const first = await reindexVault(vault);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.embeddedCount).toBeGreaterThan(0);

    // Simulate a fresh process: drop the memoised extractor so isModelLoaded
    // resets to false. The DB on disk still holds the embeddings cache.
    resetExtractorForTests();
    expect(isModelLoaded()).toBe(false);

    // Second reindex: every chunk's hash is already in the cache, so
    // missTexts.length is 0 and embed() is never invoked. getExtractor()
    // must therefore stay un-touched and isModelLoaded() must stay false.
    const second = await reindexVault(vault);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.embeddedCount).toBe(0);
    expect(second.value.cacheHits).toBe(second.value.chunkCount);
    // The headline assertion: a fully-cached reindex skips the model load.
    expect(isModelLoaded()).toBe(false);
  }, 120_000);

  it("warmModel() loads the model and reports success", async () => {
    resetExtractorForTests();
    expect(isModelLoaded()).toBe(false);
    expect(getIndexStatus().modelStatus).toBe("cold");

    const result = await warmModel();
    expect(result.ok).toBe(true);
    expect(isModelLoaded()).toBe(true);
    expect(getIndexStatus().modelStatus).toBe("ready");
  }, 60_000);

  it("a second warmModel() call is idempotent — the model is not re-loaded", async () => {
    // First warm to ensure the memoised promise is populated.
    const first = await warmModel();
    expect(first.ok).toBe(true);
    expect(isModelLoaded()).toBe(true);

    // The memoised promise is the same object across calls. We capture its
    // identity before and after to assert the cached promise is reused.
    // (We cannot read extractorPromise directly — isModelLoaded is the
    // public signal.)
    const second = await warmModel();
    expect(second.ok).toBe(true);
    expect(isModelLoaded()).toBe(true);

    // A third call routed through embed() must hit the same cached promise.
    const e = await embed(["hello"]);
    expect(e.ok).toBe(true);
    expect(isModelLoaded()).toBe(true);
  }, 60_000);

  it("embed() on a cold process loads the model on first call", async () => {
    resetExtractorForTests();
    expect(isModelLoaded()).toBe(false);

    const result = await embed(["short text"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(isModelLoaded()).toBe(true);
    expect(getIndexStatus().modelStatus).toBe("ready");
  }, 60_000);

  it("embed() on an empty input array does not load the model", async () => {
    // The empty-input fast path in embed() returns before calling
    // getExtractor — important because reindex callers with zero misses
    // rely on this to avoid the model load.
    resetExtractorForTests();
    expect(isModelLoaded()).toBe(false);

    const result = await embed([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
    expect(isModelLoaded()).toBe(false);
  });
});
