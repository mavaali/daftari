// Independence-aware promotion — the `vault_lint` calibration section
// (2026-07-26 spec, Decision 4). PURE: callers pass in the already-collapsed
// view and the already-read shadow journal; this module does no I/O.
//
// Cross-layer posture mirrors src/curation/coverage.ts: this is a curation-
// layer module that only TYPE-imports from src/consolidate/independence.js
// (erased at runtime, no runtime coupling) — it does not import consolidate/
// code, and nothing in consolidate/ imports this module (guard test in
// test/curation/coverage.test.ts covers the sibling coverage.ts invariant;
// this module has no dormant-enact concern of its own to guard, but the
// type-only import keeps the layering the same shape).
//
// Counts and aggregates only — no paths (matches tensionHealth's posture
// under the 2026-07-14 edge-graph existence-disclosure rule).

// Type-only: erased at runtime.
import type { IndependenceShadowRow } from "../consolidate/independence.js";
import { EDGE_TRIGGER_STRENGTH, type EdgeIndependenceRow, FP_SENTINEL } from "./edges.js";

const ALL_SENTINEL_CLASS_KEY = `${FP_SENTINEL}\n${FP_SENTINEL}\n${FP_SENTINEL}`;

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
}

export interface IndependenceCalibrationSummary {
  kVsKEff: {
    edgesWithVotes: number;
    meanK: number;
    meanKEff: number;
    medianKEff: number;
    // Edges (with >=1 counted vote) whose kEff is strictly below kSurvived —
    // the discount actually bit.
    kEffBelowKCount: number;
  };
  wouldDropBelowTrigger: {
    // Edges currently trigger-bearing on raw strength whose strengthIndependent
    // would drop below EDGE_TRIGGER_STRENGTH.
    count: number;
    // The subset of `count` that is all-legacy (every counted vote
    // unfingerprinted) — the expected huge all-legacy compression, visibly
    // separated from signal (C5).
    legacyOnlyCount: number;
  };
  wouldNeedsReviewRate: {
    // would_needs_review rows / journal rows with a non-null wouldDecision.
    rate: number;
    needsReviewCount: number;
    decidedCount: number;
    // C5: the raw rate above is degenerate (~0) until legacy edges carry a
    // fingerprinted class, because a fingerprinted class key can never equal
    // the all-∅ sentinel — every legacy edge's first fingerprinted panel is
    // would_accrue by construction. An "informative" panel is a decided row
    // whose PRE-panel classes already include at least one non-∅ key — a
    // panel whose verdict could possibly have been would_needs_review.
    informativePanels: number;
    informativeNeedsReviewCount: number;
    rateInformative: number;
  };
  // Edges whose counted votes are ALL unfingerprinted, over edges with >=1
  // counted vote — how much of the graph is un-fingerprinted and therefore
  // single-class.
  legacyUnfingerprintedFraction: number;
  // C3: total operator-attested (non-loop-principal) counted votes across
  // the view — how much of the class structure is attested, not verified.
  nonLoopFingerprintedCountedVotes: number;
}

export function independenceCalibrationSummaryOf(
  view: EdgeIndependenceRow[],
  journal: IndependenceShadowRow[],
): IndependenceCalibrationSummary {
  const withVotes = view.filter((r) => r.countedVotes > 0);

  const kEffBelowKCount = withVotes.filter((r) => r.kEff < r.kSurvived).length;

  const wouldDropSet = view.filter(
    (r) => r.strengthIndependent < EDGE_TRIGGER_STRENGTH && r.strength >= EDGE_TRIGGER_STRENGTH,
  );
  const wouldDropLegacyOnly = wouldDropSet.filter(
    (r) => r.countedVotes > 0 && r.unfingerprintedCountedVotes === r.countedVotes,
  );

  const decided = journal.filter((r) => r.wouldDecision !== null);
  const needsReview = decided.filter((r) => r.wouldDecision === "would_needs_review");
  const informative = decided.filter((r) =>
    r.classes.some((c) => c.key !== ALL_SENTINEL_CLASS_KEY),
  );
  const informativeNeedsReview = informative.filter(
    (r) => r.wouldDecision === "would_needs_review",
  );

  const legacyOnlyEdges = withVotes.filter((r) => r.unfingerprintedCountedVotes === r.countedVotes);

  let nonLoopFingerprintedCountedVotes = 0;
  for (const r of view) nonLoopFingerprintedCountedVotes += r.nonLoopFingerprintedCountedVotes;

  return {
    kVsKEff: {
      edgesWithVotes: withVotes.length,
      meanK: mean(withVotes.map((r) => r.kSurvived)),
      meanKEff: mean(withVotes.map((r) => r.kEff)),
      medianKEff: median(withVotes.map((r) => r.kEff)),
      kEffBelowKCount,
    },
    wouldDropBelowTrigger: {
      count: wouldDropSet.length,
      legacyOnlyCount: wouldDropLegacyOnly.length,
    },
    wouldNeedsReviewRate: {
      rate: decided.length > 0 ? needsReview.length / decided.length : 0,
      needsReviewCount: needsReview.length,
      decidedCount: decided.length,
      informativePanels: informative.length,
      informativeNeedsReviewCount: informativeNeedsReview.length,
      rateInformative:
        informative.length > 0 ? informativeNeedsReview.length / informative.length : 0,
    },
    legacyUnfingerprintedFraction:
      withVotes.length > 0 ? legacyOnlyEdges.length / withVotes.length : 0,
    nonLoopFingerprintedCountedVotes,
  };
}

// Zero summary — for a fresh vault, or when either underlying read fails
// (lint stays advisory and never fails on a calibration read).
export function emptyIndependenceCalibrationSummary(): IndependenceCalibrationSummary {
  return {
    kVsKEff: { edgesWithVotes: 0, meanK: 0, meanKEff: 0, medianKEff: 0, kEffBelowKCount: 0 },
    wouldDropBelowTrigger: { count: 0, legacyOnlyCount: 0 },
    wouldNeedsReviewRate: {
      rate: 0,
      needsReviewCount: 0,
      decidedCount: 0,
      informativePanels: 0,
      informativeNeedsReviewCount: 0,
      rateInformative: 0,
    },
    legacyUnfingerprintedFraction: 0,
    nonLoopFingerprintedCountedVotes: 0,
  };
}
