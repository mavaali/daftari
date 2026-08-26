// Config parsing for the `search` retrieval-tuning block (MAV-156 / MAV-159).
//
// `search.coverage` re-enables the retired date-window coverage pass;
// `search.vec_knn_k` sets the vector-arm KNN fan-out. Absent block = the
// defaults (coverage off, fan-out 256). Malformed values are hard config
// errors, matching the rest of the loader's trust model.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../../src/utils/config.js";

describe("loadConfig — search tuning block", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-search-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
  }

  it("defaults to coverage off / fan-out 256 when no config file exists", () => {
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.search).toEqual({
      coverage: false,
      weights: { bm25: 0.8, vector: 0.2 },
      vecKnnK: 256,
      suppressSuperseded: false,
      graphExpand: { enabled: false, cap: 10, tau: 0.3, subset: "trigger" },
    });
  });

  it("defaults when the search block is omitted", () => {
    writeConfig("auto_commit: true\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.search).toEqual({
      coverage: false,
      weights: { bm25: 0.8, vector: 0.2 },
      vecKnnK: 256,
      suppressSuperseded: false,
      graphExpand: { enabled: false, cap: 10, tau: 0.3, subset: "trigger" },
    });
  });

  it("parses an explicit opt-in and fan-out", () => {
    writeConfig("search:\n  coverage: true\n  vec_knn_k: 256\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.search).toEqual({
      coverage: true,
      weights: { bm25: 0.8, vector: 0.2 },
      vecKnnK: 256,
      suppressSuperseded: false,
      graphExpand: { enabled: false, cap: 10, tau: 0.3, subset: "trigger" },
    });
  });

  it("accepts a partial block, defaulting the other knob", () => {
    writeConfig("search:\n  vec_knn_k: 128\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.search).toEqual({
      coverage: false,
      weights: { bm25: 0.8, vector: 0.2 },
      vecKnnK: 128,
      suppressSuperseded: false,
      graphExpand: { enabled: false, cap: 10, tau: 0.3, subset: "trigger" },
    });
  });

  it("parses explicit fusion weights", () => {
    writeConfig("search:\n  weights:\n    bm25: 0.6\n    vector: 0.4\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.search.weights).toEqual({ bm25: 0.6, vector: 0.4 });
  });

  it.each([
    ["search:\n  weights: even\n", "'search.weights' must be a mapping"],
    [
      "search:\n  weights:\n    bm25: 1\n    vektor: 0\n",
      "'search.weights.vektor' is not a recognised setting",
    ],
    ["search:\n  weights:\n    bm25: 0\n    vector: 0\n", "summing above zero"],
    ["search:\n  weights:\n    bm25: -1\n    vector: 2\n", "non-negative"],
    ["search:\n  weights:\n    bm25: 0.5\n", "numeric non-negative"],
  ])("rejects malformed weights: %s", (yaml, msg) => {
    writeConfig(yaml);
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain(msg);
  });

  it("rejects a non-mapping search block", () => {
    writeConfig("search: fast\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("'search' must be a mapping");
  });

  it("rejects a typo'd key instead of silently defaulting", () => {
    // The exact trap rejectUnknownKeys exists for: an operator opting the
    // retired pass back in with a misspelled key must get an error, not a
    // silent coverage=false.
    writeConfig("search:\n  vec_knn_k: 256\n  coverge: true\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("'search.coverge' is not a recognised setting");
  });

  it("parses the suppression opt-in", () => {
    writeConfig("search:\n  suppress_superseded: true\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.search.suppressSuperseded).toBe(true);
  });

  it("rejects a non-boolean suppress_superseded", () => {
    writeConfig("search:\n  suppress_superseded: maybe\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("'search.suppress_superseded' must be true or false");
  });

  it("rejects a non-boolean coverage", () => {
    writeConfig("search:\n  coverage: sometimes\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("'search.coverage' must be true or false");
  });

  it.each([["0"], ["-4"], ["1.5"], ["8192"], ['"64"']])("rejects vec_knn_k = %s", (bad) => {
    writeConfig(`search:\n  vec_knn_k: ${bad}\n`);
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("'search.vec_knn_k' must be an integer");
  });
});
