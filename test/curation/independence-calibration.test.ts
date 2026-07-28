// Independence-aware promotion — the vault_lint calibration section
// (2026-07-26 spec, Decision 4, PR-3).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IndependenceShadowRow } from "../../src/consolidate/independence.js";
import { appendIndependenceShadow } from "../../src/consolidate/independence.js";
import type { EdgeIndependenceRow } from "../../src/curation/edges.js";
import { observeEdge } from "../../src/curation/edges.js";
import {
  emptyIndependenceCalibrationSummary,
  independenceCalibrationSummaryOf,
} from "../../src/curation/independence-calibration.js";
import { runLint } from "../../src/curation/lint.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

function row(overrides: Partial<EdgeIndependenceRow> = {}): EdgeIndependenceRow {
  return {
    fromPath: "a.md",
    toPath: "b.md",
    kSurvived: 0,
    kEff: 0,
    strength: 0,
    strengthIndependent: 0,
    classCount: 0,
    countedVotes: 0,
    unfingerprintedCountedVotes: 0,
    nonLoopFingerprintedCountedVotes: 0,
    status: "candidate",
    ...overrides,
  };
}

function shadowRow(overrides: Partial<IndependenceShadowRow> = {}): IndependenceShadowRow {
  return {
    at: "2026-07-27T00:00:00Z",
    fromPath: "a.md",
    toPath: "b.md",
    kSurvived: 0,
    kEff: 0,
    strength: 0,
    strengthIndependent: 0,
    classes: [],
    panelClassKeys: [],
    marginalGain: 0,
    wouldDecision: null,
    ...overrides,
  };
}

describe("independenceCalibrationSummaryOf — pure aggregation", () => {
  it("zeroes on empty inputs", () => {
    const summary = independenceCalibrationSummaryOf([], []);
    expect(summary).toEqual(emptyIndependenceCalibrationSummary());
  });

  it("k vs k_eff distribution: scoped to edges WITH counted votes; edges with none are excluded", () => {
    const view = [
      row({ kSurvived: 3, kEff: 1.9375, countedVotes: 3, unfingerprintedCountedVotes: 3 }),
      row({ fromPath: "x.md", toPath: "y.md", kSurvived: 0, kEff: 0, countedVotes: 0 }), // no votes
    ];
    const summary = independenceCalibrationSummaryOf(view, []);
    expect(summary.kVsKEff.edgesWithVotes).toBe(1);
    expect(summary.kVsKEff.meanK).toBeCloseTo(3, 6);
    expect(summary.kVsKEff.meanKEff).toBeCloseTo(1.9375, 6);
    expect(summary.kVsKEff.medianKEff).toBeCloseTo(1.9375, 6);
    expect(summary.kVsKEff.kEffBelowKCount).toBe(1); // 1.9375 < 3
  });

  it("wouldDropBelowTrigger: counts trigger-bearing-on-strength edges that drop under strengthIndependent, splitting legacy-only", () => {
    const view = [
      // All-legacy: every counted vote unfingerprinted → legacy-only.
      row({
        fromPath: "a.md",
        toPath: "b.md",
        strength: 0.6,
        strengthIndependent: 0.3,
        countedVotes: 3,
        unfingerprintedCountedVotes: 3,
      }),
      // Partially fingerprinted: drops too, but NOT legacy-only.
      row({
        fromPath: "c.md",
        toPath: "d.md",
        strength: 0.7,
        strengthIndependent: 0.2,
        countedVotes: 3,
        unfingerprintedCountedVotes: 1,
      }),
      // Stays trigger-bearing under strengthIndependent too — not counted.
      row({
        fromPath: "e.md",
        toPath: "f.md",
        strength: 2,
        strengthIndependent: 1,
        countedVotes: 2,
        unfingerprintedCountedVotes: 0,
      }),
      // Was never trigger-bearing on raw strength — not counted even though
      // strengthIndependent is also below the floor.
      row({
        fromPath: "g.md",
        toPath: "h.md",
        strength: 0.2,
        strengthIndependent: 0.1,
        countedVotes: 1,
        unfingerprintedCountedVotes: 1,
      }),
    ];
    const summary = independenceCalibrationSummaryOf(view, []);
    expect(summary.wouldDropBelowTrigger.count).toBe(2);
    expect(summary.wouldDropBelowTrigger.legacyOnlyCount).toBe(1);
  });

  it("wouldNeedsReviewRate: raw rate over decided rows; informative rate excludes rows whose pre-panel classes are all-∅ (C5)", () => {
    const journal: IndependenceShadowRow[] = [
      // A legacy edge's FIRST fingerprinted panel: pre-panel classes are
      // all-∅ (never fingerprinted before) — not informative, even though
      // decided would_accrue (a fresh class always accrues).
      shadowRow({
        classes: [{ key: "∅\n∅\n∅", count: 3 }],
        wouldDecision: "would_accrue",
      }),
      // An edge with a genuinely fingerprinted pre-panel class → informative.
      shadowRow({
        fromPath: "c.md",
        toPath: "d.md",
        classes: [{ key: "hash123\nagent:curation-loop\nclaude-haiku", count: 2 }],
        wouldDecision: "would_needs_review",
      }),
      // Not decided (tie/gated) — excluded from both denominators.
      shadowRow({ fromPath: "e.md", toPath: "f.md", classes: [], wouldDecision: null }),
    ];
    const summary = independenceCalibrationSummaryOf([], journal);
    expect(summary.wouldNeedsReviewRate.decidedCount).toBe(2);
    expect(summary.wouldNeedsReviewRate.needsReviewCount).toBe(1);
    expect(summary.wouldNeedsReviewRate.rate).toBeCloseTo(0.5, 6);
    // Informative excludes the all-∅ row: denominator 1, not 2.
    expect(summary.wouldNeedsReviewRate.informativePanels).toBe(1);
    expect(summary.wouldNeedsReviewRate.informativeNeedsReviewCount).toBe(1);
    expect(summary.wouldNeedsReviewRate.rateInformative).toBeCloseTo(1, 6);
  });

  it("legacyUnfingerprintedFraction: edges with all-unfingerprinted counted votes / edges with any counted votes", () => {
    const view = [
      row({ fromPath: "a.md", toPath: "b.md", countedVotes: 3, unfingerprintedCountedVotes: 3 }),
      row({ fromPath: "c.md", toPath: "d.md", countedVotes: 2, unfingerprintedCountedVotes: 0 }),
      row({ fromPath: "e.md", toPath: "f.md", countedVotes: 0, unfingerprintedCountedVotes: 0 }),
    ];
    const summary = independenceCalibrationSummaryOf(view, []);
    expect(summary.legacyUnfingerprintedFraction).toBeCloseTo(0.5, 6); // 1 of 2 edges-with-votes
  });

  it("nonLoopFingerprintedCountedVotes sums across the view", () => {
    const view = [
      row({ nonLoopFingerprintedCountedVotes: 2 }),
      row({ fromPath: "c.md", toPath: "d.md", nonLoopFingerprintedCountedVotes: 3 }),
    ];
    const summary = independenceCalibrationSummaryOf(view, []);
    expect(summary.nonLoopFingerprintedCountedVotes).toBe(5);
  });
});

describe("vault_lint independenceCalibration section — wiring", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("is present and zeroed on a fresh vault", async () => {
    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.independenceCalibration).toEqual(emptyIndependenceCalibrationSummary());
  });

  it("reflects a real fixture trail: edges.jsonl + independence-shadow.jsonl feed the same summary the pure function computes", async () => {
    // A due edge whose one counted vote is unfingerprinted (legacy).
    await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: "agent:curation-loop",
      blind: false,
    });
    await observeEdge(vault, {
      fromPath: "a.md",
      toPath: "b.md",
      observedBy: "agent:curation-loop",
      blind: true,
      axis: "prompt",
    });
    // One journaled panel row: an informative, decided would_needs_review.
    await appendIndependenceShadow(
      vault,
      shadowRow({
        fromPath: "a.md",
        toPath: "b.md",
        classes: [{ key: "hash\nagent:curation-loop\nclaude-haiku", count: 2 }],
        wouldDecision: "would_needs_review",
      }),
    );

    const report = await runLint(vault);
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const ic = report.value.independenceCalibration;
    expect(ic.kVsKEff.edgesWithVotes).toBe(1);
    expect(ic.legacyUnfingerprintedFraction).toBeCloseTo(1, 6); // the one edge is all-legacy
    expect(ic.wouldNeedsReviewRate.decidedCount).toBe(1);
    expect(ic.wouldNeedsReviewRate.informativePanels).toBe(1);
    expect(ic.wouldNeedsReviewRate.rateInformative).toBeCloseTo(1, 6);
  });
});
