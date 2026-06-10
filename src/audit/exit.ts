import type { AuditReport } from "./types.js";

export function computeExitCode(
  report: AuditReport,
  failOn: { brokenRefs: number; transitiveStaleness: number; brokenDescribes: number },
): 0 | 1 {
  if (report.totals.brokenRefs >= failOn.brokenRefs) return 1;
  if (report.totals.transitivelyStale >= failOn.transitiveStaleness) return 1;
  if (report.totals.brokenDescribes >= failOn.brokenDescribes) return 1;
  return 0;
}
