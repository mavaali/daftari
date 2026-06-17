import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consolidateStatePath,
  docContentHash,
  readConsolidateState,
  writeConsolidateState,
} from "../../src/consolidate/state.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daftari-state-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("consolidate state", () => {
  it("returns an empty default when absent", () => {
    const s = readConsolidateState(dir);
    expect(s.lastConsolidationCommit).toBeNull();
    expect(s.birthProcessed).toEqual({});
  });

  it("round-trips", () => {
    writeConsolidateState(dir, {
      lastConsolidationCommit: "abc",
      birthProcessed: { "a.md": "h1" },
    });
    const s = readConsolidateState(dir);
    expect(s.lastConsolidationCommit).toBe("abc");
    expect(s.birthProcessed["a.md"]).toBe("h1");
  });

  it("treats a corrupt file as the empty default (rebuildable)", () => {
    writeConsolidateState(dir, { lastConsolidationCommit: "abc", birthProcessed: {} });
    // overwrite with garbage
    writeFileSync(consolidateStatePath(dir), "{ not json");
    expect(readConsolidateState(dir).lastConsolidationCommit).toBeNull();
  });

  it("content hash is stable and content-sensitive", () => {
    expect(docContentHash("x")).toBe(docContentHash("x"));
    expect(docContentHash("x")).not.toBe(docContentHash("y"));
  });
});
