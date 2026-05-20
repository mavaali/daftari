import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getIndexStatus,
  indexingBusyMessage,
  markIndexError,
  markIndexing,
  markIndexReady,
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
});
