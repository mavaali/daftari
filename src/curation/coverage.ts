// Stage 4 — coverage/equity instrumentation (spec §6.2). PURE: callers inject
// docs/edges/journal rows; this module reads no disk. B is a MONITOR, NEVER a
// TARGET — nothing in src/consolidate/ may import this (guard test in coverage.test).
import { posix } from "node:path";
import { decayBackstopDue } from "../consolidate/clocks.js";
import { CONSOLIDATE_MAX_INTERVAL_DAYS } from "../consolidate/constants.js";
// Type-only (erased at runtime — no runtime coupling): pins the edge-op action
// names below to the envelope's source-of-truth type, so a rename there breaks
// THIS build instead of silently drifting the monitor.
import type { EnvelopeActionType } from "../consolidate/envelope.js";
import { ok, type Result } from "../frontmatter/types.js";
import { type DerivesFromEdge, EDGE_TRIGGER_STRENGTH } from "./edges.js";
import type { ShadowActionRecord } from "./shadow.js";
import type { StagedAction } from "./staged-actions.js";
import { buildReverseLinkMap, buildReverseSourceMap, computeBlast } from "./tension-blast.js";
import type { LoadedDoc } from "./vault-docs.js";

// Same canon() the consolidate modules use (path-aliasing bug class): an alias
// like `x/../x/a.md` must resolve to the loader's canonical relPath key.
function canon(p: string): string {
  return posix.normalize(p).replace(/^\.\//, "");
}

export interface StrengthGroupStats {
  count: number;
  mean: number;
  median: number;
  p10: number;
  p90: number;
  variance: number;
}

export interface CoverageEquitySummary {
  generatedAt: string;
  strengthDrift: {
    core: StrengthGroupStats; // blast > 0
    periphery: StrengthGroupStats; // blast == 0
    // The drift signal — null when either group is empty (the gap is undefined
    // without both sides; a sentinel 0 would read as "no drift" in exactly the
    // lopsided/early-vault regime this monitor watches). Compare group counts.
    coreMinusPeripheryMedian: number | null;
    belowTriggerCount: number; // aged strength < EDGE_TRIGGER_STRENGTH (0.5)
  };
  backstopOverdue: {
    count: number;
    stalest: Array<{ fromPath: string; toPath: string; daysOverdue: number }>;
  };
  actionMix: {
    counts: Record<string, number>;
    cheapLinkFraction: number; // edge-observe / total
    total: number;
  };
  directionResolution: {
    directed: number;
    symmetric: number;
    unresolvedFraction: number; // symmetric / non-revoked
  };
}

export interface CoverageInput {
  docs: LoadedDoc[];
  edges: DerivesFromEdge[];
  shadowRecords: ShadowActionRecord[];
  stagedActions: StagedAction[];
  now: Date;
}

// --- pure stats over a number[] -------------------------------------------
const EMPTY_STATS: StrengthGroupStats = {
  count: 0,
  mean: 0,
  median: 0,
  p10: 0,
  p90: 0,
  variance: 0,
};

// Nearest-rank percentile on the sorted array; p in [0,1]. Deterministic and
// dependency-free (we don't need interpolation precision for a monitor).
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(p * (sortedAsc.length - 1))));
  return sortedAsc[idx] as number;
}

function stats(values: number[]): StrengthGroupStats {
  if (values.length === 0) return { ...EMPTY_STATS };
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / n; // population variance
  return {
    count: n,
    mean,
    median: percentile(sorted, 0.5),
    p10: percentile(sorted, 0.1),
    p90: percentile(sorted, 0.9),
    variance,
  };
}

export function coverageEquitySummary(input: CoverageInput): Result<CoverageEquitySummary, Error> {
  const { now } = input;

  // --- strength-distribution drift -----------------------------------------
  const reverseSource = buildReverseSourceMap(input.docs);
  const reverseLink = buildReverseLinkMap(input.docs);

  const live = input.edges.filter((e) => e.status !== "revoked");
  const coreStrengths: number[] = [];
  const periStrengths: number[] = [];
  let belowTriggerCount = 0;
  for (const e of live) {
    const blast = computeBlast({
      seeds: [canon(e.fromPath), canon(e.toPath)],
      reverseSource,
      reverseLink,
    }).downstream.length;
    (blast > 0 ? coreStrengths : periStrengths).push(e.strength);
    if (e.strength < EDGE_TRIGGER_STRENGTH) belowTriggerCount += 1;
  }
  const core = stats(coreStrengths);
  const periphery = stats(periStrengths);
  // Null unless BOTH groups have edges — the median gap is undefined otherwise,
  // and a sentinel 0 would falsely read as "no drift" on a one-sided vault.
  const medianGap = core.count > 0 && periphery.count > 0 ? core.median - periphery.median : null;
  const strengthDrift = {
    core,
    periphery,
    coreMinusPeripheryMedian: medianGap,
    belowTriggerCount,
  };

  // --- backstop-overdue -----------------------------------------------------
  const overdue = decayBackstopDue(input.edges, now).filter((d) => d.reason === "backstop");
  const daysSince = (iso: string) =>
    Math.max(0, (now.getTime() - new Date(iso).getTime()) / 86_400_000);
  // daysOverdue = days past the max interval. We need lastRederived per overdue
  // edge; look it up from the source edges by (from,to). Keyed identically to
  // decayBackstopDue's own (from,to) dedup (clocks.ts), so each overdue edge has
  // exactly one source row; the data model has no parallel (from,to) edges. If
  // that ever changes, the last writer wins here — acceptable for a monitor.
  const lastByKey = new Map(
    input.edges.map((e) => [`${e.fromPath}\n${e.toPath}`, e.lastRederived]),
  );
  const overdueDetailed = overdue
    .map((d) => {
      const last = lastByKey.get(`${d.fromPath}\n${d.toPath}`) ?? now.toISOString();
      return {
        fromPath: d.fromPath,
        toPath: d.toPath,
        daysOverdue: Math.max(0, daysSince(last) - CONSOLIDATE_MAX_INTERVAL_DAYS),
      };
    })
    .sort((a, b) => b.daysOverdue - a.daysOverdue);
  const backstopOverdue = {
    count: overdueDetailed.length,
    stalest: overdueDetailed.slice(0, 5),
  };

  // --- action-mix drift -----------------------------------------------------
  // Pinned to EnvelopeActionType: if the envelope renames an action, this array
  // literal fails to compile rather than the monitor silently miscounting.
  const EDGE_OP_ACTION_NAMES: readonly EnvelopeActionType[] = ["edge-observe", "edge-contest"];
  const CHEAP_LINK_ACTION: EnvelopeActionType = "edge-observe";
  const EDGE_OP_ACTIONS = new Set<string>(EDGE_OP_ACTION_NAMES);
  const counts: Record<string, number> = {};
  for (const rec of input.shadowRecords) {
    if (!EDGE_OP_ACTIONS.has(rec.action)) continue; // exclude doc-write calibration rows
    counts[rec.action] = (counts[rec.action] ?? 0) + 1;
  }
  // Count only staged actions the loop actually enacted ("ratified") or is still
  // actively proposing ("pending"). "expired"/"rejected" died without effect —
  // counting them inflates the heavyweight side and DEFLATES cheapLinkFraction,
  // i.e. under-reports the cheap-link-creep ratchet this metric exists to detect.
  const LIVE_STAGED_STATUSES = new Set(["pending", "ratified"]);
  for (const sa of input.stagedActions) {
    if (!LIVE_STAGED_STATUSES.has(sa.status)) continue;
    counts[sa.actionType] = (counts[sa.actionType] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  const cheapLink = counts[CHEAP_LINK_ACTION] ?? 0;
  const actionMix = {
    counts,
    total,
    cheapLinkFraction: total > 0 ? cheapLink / total : 0,
  };

  // --- direction-resolution coverage ----------------------------------------
  const nonRevoked = input.edges.filter((e) => e.status !== "revoked");
  const directed = nonRevoked.filter((e) => e.directionVerdict === "directed").length;
  const symmetric = nonRevoked.filter((e) => e.directionVerdict === "symmetric").length;
  const directionResolution = {
    directed,
    symmetric,
    unresolvedFraction: nonRevoked.length > 0 ? symmetric / nonRevoked.length : 0,
  };

  return ok({
    generatedAt: now.toISOString(),
    strengthDrift,
    backstopOverdue,
    actionMix,
    directionResolution,
  });
}
