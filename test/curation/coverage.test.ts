import { describe, expect, it } from "vitest";
import { coverageEquitySummary } from "../../src/curation/coverage.js";

const NOW = new Date("2026-06-19T00:00:00Z");

describe("coverageEquitySummary", () => {
  it("returns all-zero summary for an empty vault", () => {
    const r = coverageEquitySummary({
      docs: [],
      edges: [],
      shadowRecords: [],
      stagedActions: [],
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value;
    expect(s.strengthDrift.core.count).toBe(0);
    expect(s.strengthDrift.periphery.count).toBe(0);
    expect(s.strengthDrift.coreMinusPeripheryMedian).toBe(0);
    expect(s.strengthDrift.belowTriggerCount).toBe(0);
    expect(s.backstopOverdue.count).toBe(0);
    expect(s.actionMix.total).toBe(0);
    expect(s.actionMix.cheapLinkFraction).toBe(0);
    expect(s.directionResolution.directed).toBe(0);
    expect(s.directionResolution.symmetric).toBe(0);
    expect(s.directionResolution.unresolvedFraction).toBe(0);
  });
});
