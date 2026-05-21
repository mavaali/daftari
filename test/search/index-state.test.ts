import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getIndexStatus,
  indexingBusyMessage,
  markIndexError,
  markIndexing,
  markIndexReady,
  markModelError,
  markModelReady,
  markModelWarming,
  resetIndexState,
  setIndexProgress,
} from "../../src/search/index-state.js";

describe("IndexState", () => {
  beforeEach(() => resetIndexState());
  afterEach(() => resetIndexState());

  it("defaults to ready with zero progress", () => {
    const snap = getIndexStatus();
    expect(snap.status).toBe("ready");
    expect(snap.done).toBe(0);
    expect(snap.total).toBe(0);
    expect(snap.error).toBeNull();
  });

  it("transitions ready -> indexing -> ready and tracks progress", () => {
    markIndexing();
    expect(getIndexStatus().status).toBe("indexing");

    setIndexProgress(40, 100);
    const mid = getIndexStatus();
    expect(mid.done).toBe(40);
    expect(mid.total).toBe(100);

    markIndexReady();
    expect(getIndexStatus().status).toBe("ready");
    expect(getIndexStatus().finishedAt).not.toBeNull();
  });

  it("captures an error transition with the message", () => {
    markIndexing();
    markIndexError("disk full");
    const snap = getIndexStatus();
    expect(snap.status).toBe("error");
    expect(snap.error).toBe("disk full");
  });

  it("ignores progress updates outside the indexing state", () => {
    // Status is "ready" by default — progress writes must not flip totals.
    setIndexProgress(7, 10);
    expect(getIndexStatus().done).toBe(0);
    expect(getIndexStatus().total).toBe(0);
  });

  it("formats the busy message with progress when available", () => {
    markIndexing();
    setIndexProgress(12, 100);
    expect(indexingBusyMessage(getIndexStatus())).toContain("12/100");
  });

  it("returns a snapshot, not a live reference", () => {
    markIndexing();
    const snap = getIndexStatus();
    setIndexProgress(5, 10);
    // External callers must see the snapshot they were handed, not a live view.
    expect(snap.done).toBe(0);
    expect(snap.total).toBe(0);
  });

  describe("model status (issue #38 PR 2)", () => {
    it("starts cold and is orthogonal to index status", () => {
      const snap = getIndexStatus();
      // A fresh process has not touched the model yet. Index status is
      // ready by default; the model is cold until something asks for it.
      expect(snap.modelStatus).toBe("cold");
      expect(snap.modelError).toBeNull();
      expect(snap.status).toBe("ready");
    });

    it("transitions cold → warming → ready", () => {
      markModelWarming();
      expect(getIndexStatus().modelStatus).toBe("warming");
      markModelReady();
      expect(getIndexStatus().modelStatus).toBe("ready");
      expect(getIndexStatus().modelError).toBeNull();
    });

    it("captures a model load failure with its message", () => {
      markModelWarming();
      markModelError("no network");
      const snap = getIndexStatus();
      expect(snap.modelStatus).toBe("error");
      expect(snap.modelError).toBe("no network");
    });

    it("model transitions do not touch index status", () => {
      // The two lifecycles run independently — a model warm-up must not
      // flip the index back to "indexing" or clear the index progress.
      markIndexing();
      setIndexProgress(5, 10);
      markModelWarming();
      const snap = getIndexStatus();
      expect(snap.status).toBe("indexing");
      expect(snap.done).toBe(5);
      expect(snap.total).toBe(10);
      expect(snap.modelStatus).toBe("warming");
    });

    it("indexingBusyMessage prefers indexing context when both are active", () => {
      // A simultaneous reindex + warm is the cold-start case; the user
      // cares about the longer-running operation, which is the indexing
      // progress.
      markIndexing();
      setIndexProgress(7, 100);
      markModelWarming();
      const msg = indexingBusyMessage(getIndexStatus());
      expect(msg).toContain("7/100");
      expect(msg).toContain("indexing");
    });

    it("indexingBusyMessage surfaces 'embedding model is warming' when only the warm-up is running", () => {
      // Index has settled (e.g. cache-hit reindex finished) but the model
      // is still loading. A client retrying a search needs to know the
      // slow operation is the model, not an indexing pass.
      markModelWarming();
      const msg = indexingBusyMessage(getIndexStatus());
      expect(msg).toContain("embedding model is warming");
    });
  });
});
