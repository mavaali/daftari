import { describe, expect, it } from "vitest";
import { computeExitCode } from "../../src/audit/exit.js";
import type { AuditReport } from "../../src/audit/types.js";

const base: AuditReport = {
  generatedAt: "x",
  config: {} as never,
  totals: {
    reposScanned: 1,
    docsScanned: 1,
    brokenRefs: 0,
    directlyStale: 0,
    transitivelyStale: 0,
  },
  brokenRefs: [],
  staleness: [],
};

describe("computeExitCode", () => {
  it("returns 0 when all counts under thresholds", () => {
    expect(computeExitCode(base, { brokenRefs: 1, transitiveStaleness: 1 })).toBe(0);
  });
  it("returns 1 when broken refs at threshold", () => {
    const r = { ...base, totals: { ...base.totals, brokenRefs: 1 } };
    expect(computeExitCode(r, { brokenRefs: 1, transitiveStaleness: 100 })).toBe(1);
  });
  it("returns 1 when transitive staleness at threshold", () => {
    const r = { ...base, totals: { ...base.totals, transitivelyStale: 5 } };
    expect(computeExitCode(r, { brokenRefs: 100, transitiveStaleness: 5 })).toBe(1);
  });
  it("ignores directly stale even when high", () => {
    const r = { ...base, totals: { ...base.totals, directlyStale: 999 } };
    expect(computeExitCode(r, { brokenRefs: 1, transitiveStaleness: 1 })).toBe(0);
  });
});
