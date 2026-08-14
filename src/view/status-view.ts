// The dashboard DTO — the JSON data contract behind the home page (the same
// B-seam as doc-view): both the server-rendered dashboard and /api/status read
// this one shape. Pure reuse — it composes vault_status (metrics, staleness,
// validity, unresolved tensions), the sleep run ledger (the trend), and the
// tier-2 ratification queue. No knowledge state is recomputed here.

import { ok, type Result } from "../frontmatter/types.js";
import { listRuns } from "../sleep/run-ledger.js";
import { vaultStatus } from "../tools/read.js";
import { vaultTier2Queue } from "../tools/tier2.js";

export interface StatusRun {
  id: string;
  kind: string;
  ts: string;
}

export interface StatusView {
  vault: string;
  fileCount: number;
  collections: { collection: string; count: number }[];
  staleness: { fresh: number; aging: number; stale: number; total: number };
  validity: { authored: number; unknown: number; total: number };
  unresolvedTensions: number;
  ratificationQueue: number;
  recentRuns: StatusRun[];
  invalidCount: number;
  generatedAt: string;
}

// How many recent sleep runs the trend shows.
const RUN_TREND_LIMIT = 12;

export async function buildStatusView(vaultRoot: string): Promise<Result<StatusView, Error>> {
  const status = await vaultStatus(vaultRoot);
  if (!status.ok) return status;
  const s = status.value;

  // The ratification queue and run ledger are best-effort surfaces: a failure
  // to read them degrades that tile to zero/empty, never fails the dashboard.
  const tier2 = await vaultTier2Queue(vaultRoot, {});
  const ratificationQueue = tier2.ok ? tier2.value.total : 0;
  const recentRuns = listRuns(vaultRoot, RUN_TREND_LIMIT).map((r) => ({
    id: r.id,
    kind: r.kind,
    ts: r.ts,
  }));

  return ok({
    vault: s.vault,
    fileCount: s.fileCount,
    collections: s.collections,
    staleness: s.stalenessDistribution,
    validity: s.validityCoverage,
    unresolvedTensions: s.unresolvedTensions.count,
    ratificationQueue,
    recentRuns,
    invalidCount: s.invalidCount,
    generatedAt: s.generatedAt,
  });
}
