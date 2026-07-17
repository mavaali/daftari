import { describe, expect, it } from "vitest";
import {
  type ReviewThroughputSummary,
  reviewThroughputSummary,
} from "../../src/curation/review-throughput.js";
import type { StagedAction } from "../../src/curation/staged-actions.js";

// Fixed clock for deterministic window math.
const NOW = new Date("2026-07-01T00:00:00Z");

// Days-ago helper relative to NOW, second-resolution ISO like the log uses.
function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function action(overrides: Partial<StagedAction>): StagedAction {
  return {
    id: "sa-x",
    actionType: "promote",
    targetPath: "a.md",
    proposedBy: "agent:writer",
    proposedAt: daysAgo(1),
    expiresAt: daysAgo(-13),
    status: "pending",
    rationale: "r",
    proposedDiff: null,
    ratifiedAt: null,
    ratifiedBy: null,
    ratificationReason: null,
    decidedByPrincipal: null,
    ...overrides,
  };
}

describe("reviewThroughputSummary", () => {
  it("returns zeros and nulls for an empty log", () => {
    const s: ReviewThroughputSummary = reviewThroughputSummary([], NOW);
    expect(s.lifetime).toEqual({
      proposals: 0,
      ratified: 0,
      rejected: 0,
      expired: 0,
      pending: 0,
    });
    expect(s.last7d).toEqual({ arrivals: 0, decisions: 0, expiries: 0 });
    expect(s.last30d).toEqual({ arrivals: 0, decisions: 0, expiries: 0 });
    expect(s.timeToDecisionDays).toEqual({ p50: null, p90: null });
    expect(s.oldestPendingDays).toBeNull();
  });

  it("splits arrivals, decisions, and expiries into trailing windows", () => {
    const actions = [
      // Decided long ago: lifetime only, in no window.
      action({ id: "a", proposedAt: daysAgo(40), status: "ratified", ratifiedAt: daysAgo(35) }),
      // Arrived and rejected inside 30d, decision outside 7d.
      action({ id: "b", proposedAt: daysAgo(20), status: "rejected", ratifiedAt: daysAgo(10) }),
      // Arrived and ratified inside 7d.
      action({ id: "c", proposedAt: daysAgo(5), status: "ratified", ratifiedAt: daysAgo(2) }),
      // Timed out undecided: an expiry, never a decision.
      action({ id: "d", proposedAt: daysAgo(6), status: "expired", ratifiedAt: daysAgo(1) }),
      // Still waiting.
      action({ id: "e", proposedAt: daysAgo(3), status: "pending" }),
      action({ id: "f", proposedAt: daysAgo(10), status: "pending" }),
    ];
    const s = reviewThroughputSummary(actions, NOW);

    expect(s.lifetime).toEqual({
      proposals: 6,
      ratified: 2,
      rejected: 1,
      expired: 1,
      pending: 2,
    });
    expect(s.last7d).toEqual({ arrivals: 3, decisions: 1, expiries: 1 });
    expect(s.last30d).toEqual({ arrivals: 5, decisions: 2, expiries: 1 });
    // Time-to-decision over decided proposals only: 5d (a), 10d (b), 3d (c).
    expect(s.timeToDecisionDays.p50).toBeCloseTo(5, 5);
    expect(s.timeToDecisionDays.p90).toBeCloseTo(10, 5);
    expect(s.oldestPendingDays).toBeCloseTo(10, 5);
  });

  it("counts ratified-pending-tool as ratified and as a decision", () => {
    const s = reviewThroughputSummary(
      [
        action({
          id: "g",
          proposedAt: daysAgo(4),
          status: "ratified-pending-tool",
          ratifiedAt: daysAgo(1),
        }),
      ],
      NOW,
    );
    expect(s.lifetime.ratified).toBe(1);
    expect(s.last7d.decisions).toBe(1);
    expect(s.timeToDecisionDays.p50).toBeCloseTo(3, 5);
  });

  it("tolerates an expired record with no sweep timestamp (lifetime only)", () => {
    const s = reviewThroughputSummary(
      [action({ id: "h", proposedAt: daysAgo(20), status: "expired", ratifiedAt: null })],
      NOW,
    );
    expect(s.lifetime.expired).toBe(1);
    expect(s.last7d.expiries).toBe(0);
    expect(s.last30d.expiries).toBe(0);
    expect(s.timeToDecisionDays.p50).toBeNull();
  });
});
