import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SleepCycleResult } from "../../src/sleep/cycle.js";
import {
  appendRun,
  listRuns,
  type RunRecord,
  readRun,
  runLedgerPath,
  summarizeCircadian,
} from "../../src/sleep/run-ledger.js";

function cycle(overrides: Partial<SleepCycleResult> = {}): SleepCycleResult {
  return {
    staleness: { fresh: 10, aging: 2, stale: 1, total: 13 },
    compiledEdgeCoverage: {
      status: "partial",
      total_documents: 13,
      instrumented_documents: 5,
      uninstrumented_documents: 8,
      message: "compiled-edge data observed for 5 of 13 docs (8 uninstrumented)",
    },
    wake: [],
    decayedQuiet: [],
    generativeStale: 0,
    tensions: { open: 3, stale: [], docketTop: [] },
    ratification: {
      pending: 2,
      expiringSoon: [],
      history: { ratified: 5, rejected: 1, expired: 0 },
    },
    sweptExpired: ["a", "b"],
    ...overrides,
  };
}

function rec(id: string, kind = "circadian"): RunRecord {
  return { id, kind, ts: id, summary: { wake: 0 } };
}

describe("sleep run ledger (slice B)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-runs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends a record and lists it back", () => {
    appendRun(dir, rec("2026-08-14T00:00:00.000Z"));
    const runs = listRuns(dir);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe("2026-08-14T00:00:00.000Z");
  });

  it("lists most-recent first", () => {
    appendRun(dir, rec("2026-08-12T00:00:00.000Z"));
    appendRun(dir, rec("2026-08-13T00:00:00.000Z"));
    appendRun(dir, rec("2026-08-14T00:00:00.000Z"));
    expect(listRuns(dir).map((r) => r.id)).toEqual([
      "2026-08-14T00:00:00.000Z",
      "2026-08-13T00:00:00.000Z",
      "2026-08-12T00:00:00.000Z",
    ]);
  });

  it("self-prunes to the cap, keeping the newest", () => {
    for (let i = 0; i < 6; i++) {
      appendRun(dir, rec(`2026-08-${10 + i}T00:00:00.000Z`), 3);
    }
    const runs = listRuns(dir);
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.id)).toEqual([
      "2026-08-15T00:00:00.000Z",
      "2026-08-14T00:00:00.000Z",
      "2026-08-13T00:00:00.000Z",
    ]);
  });

  it("readRun finds by exact id and by prefix", () => {
    appendRun(dir, rec("2026-08-14T09:30:00.000Z"));
    expect(readRun(dir, "2026-08-14T09:30:00.000Z")?.id).toBe("2026-08-14T09:30:00.000Z");
    expect(readRun(dir, "2026-08-14")?.id).toBe("2026-08-14T09:30:00.000Z");
    expect(readRun(dir, "nope")).toBeNull();
  });

  it("skips malformed lines rather than throwing", () => {
    const path = runLedgerPath(dir);
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(path, `{ not json\n${JSON.stringify(rec("2026-08-14T00:00:00.000Z"))}\n`);
    const runs = listRuns(dir);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe("2026-08-14T00:00:00.000Z");
  });

  it("empty/absent ledger lists as empty, never throws", () => {
    expect(listRuns(dir)).toEqual([]);
    expect(readRun(dir, "anything")).toBeNull();
  });

  it("summarizeCircadian is content-light: counts only, no doc bodies", () => {
    const s = summarizeCircadian(cycle());
    expect(s).toMatchObject({
      staleness: { fresh: 10, aging: 2, stale: 1, total: 13 },
      compiledEdgeCoverage: {
        status: "partial",
        total_documents: 13,
        instrumented_documents: 5,
        uninstrumented_documents: 8,
      },
      wake: 0,
      tensionsOpen: 3,
      ratification: { pending: 2, ratified: 5, rejected: 1, expired: 0 },
      sweptExpired: 2,
    });
    // No arrays of documents leaked into the summary.
    expect(JSON.stringify(s)).not.toContain("path");
  });
});
