// Review-throughput aggregate — #235's headline measurement, quick win 2 of
// #236: proposal arrival rate vs. review throughput, computed at read time
// over the staged-actions log. Pure aggregation; the instrument ships before
// the multi-agent write feature so the dataset predates it.
//
// Vault-global counts only (no paths, no principals) — same posture as
// tensionHealth (#217 decision C): aggregates stay unfiltered by design.
//
// Vocabulary, pinned:
//   - arrival:  a proposal was staged (proposedAt).
//   - decision: a human ruled on it — ratified, ratified-pending-tool, or
//     rejected (ratifiedAt is the decision instant).
//   - expiry:   the 14-day TTL sweep killed it undecided (ratifiedAt is the
//     sweep instant). An expiry is NOT a decision — it is the review-capacity
//     wall showing up in the data, and the reason this aggregate exists.

import type { StagedAction } from "./staged-actions.js";

export interface ReviewThroughputWindow {
  arrivals: number;
  decisions: number;
  expiries: number;
}

export interface ReviewThroughputSummary {
  // Lifetime totals over the whole log. `pending` is the backlog right now.
  lifetime: {
    proposals: number;
    ratified: number;
    rejected: number;
    expired: number;
    pending: number;
  };
  last7d: ReviewThroughputWindow;
  last30d: ReviewThroughputWindow;
  // Nearest-rank percentiles of proposedAt→ratifiedAt in fractional days,
  // over decided proposals only (expiries excluded). Null when nothing has
  // been decided yet.
  timeToDecisionDays: { p50: number | null; p90: number | null };
  // Age of the oldest still-pending proposal, fractional days. Null when the
  // backlog is empty.
  oldestPendingDays: number | null;
}

const DAY_MS = 86_400_000;

// A decision is a human ruling; the sweep's `expired` stamp is not one.
function isDecided(status: string): boolean {
  return status === "ratified" || status === "ratified-pending-tool" || status === "rejected";
}

// Fractional days from `iso` to `now`; null when the timestamp is missing or
// unparseable (the log is append-only and best-effort — a corrupt stamp drops
// the record from window math, never crashes the aggregate).
function ageDays(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / DAY_MS;
}

// Nearest-rank percentile over a sorted-ascending sample.
function nearestRank(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

export function reviewThroughputSummary(
  actions: StagedAction[],
  now: Date,
): ReviewThroughputSummary {
  const lifetime = { proposals: 0, ratified: 0, rejected: 0, expired: 0, pending: 0 };
  const last7d: ReviewThroughputWindow = { arrivals: 0, decisions: 0, expiries: 0 };
  const last30d: ReviewThroughputWindow = { arrivals: 0, decisions: 0, expiries: 0 };
  const decisionDays: number[] = [];
  let oldestPendingDays: number | null = null;

  for (const a of actions) {
    lifetime.proposals += 1;
    if (a.status === "ratified" || a.status === "ratified-pending-tool") lifetime.ratified += 1;
    else if (a.status === "rejected") lifetime.rejected += 1;
    else if (a.status === "expired") lifetime.expired += 1;
    else lifetime.pending += 1;

    const arrivalAge = ageDays(a.proposedAt, now);
    if (arrivalAge !== null && arrivalAge >= 0) {
      if (arrivalAge <= 7) last7d.arrivals += 1;
      if (arrivalAge <= 30) last30d.arrivals += 1;
    }

    // ratifiedAt is the decision instant for decided records and the sweep
    // instant for expired ones — the same field, two event kinds.
    const eventAge = ageDays(a.ratifiedAt, now);
    if (eventAge !== null && eventAge >= 0) {
      if (isDecided(a.status)) {
        if (eventAge <= 7) last7d.decisions += 1;
        if (eventAge <= 30) last30d.decisions += 1;
      } else if (a.status === "expired") {
        if (eventAge <= 7) last7d.expiries += 1;
        if (eventAge <= 30) last30d.expiries += 1;
      }
    }

    if (isDecided(a.status) && arrivalAge !== null && eventAge !== null) {
      const days = arrivalAge - eventAge; // proposedAt → ratifiedAt
      if (days >= 0) decisionDays.push(days);
    }

    if (a.status === "pending" && arrivalAge !== null) {
      if (oldestPendingDays === null || arrivalAge > oldestPendingDays) {
        oldestPendingDays = arrivalAge;
      }
    }
  }

  decisionDays.sort((x, y) => x - y);
  return {
    lifetime,
    last7d,
    last30d,
    timeToDecisionDays: {
      p50: nearestRank(decisionDays, 0.5),
      p90: nearestRank(decisionDays, 0.9),
    },
    oldestPendingDays,
  };
}
