// Coverage projection for `daftari backfill` (#116). For a set of plan entries,
// count how many would catalog cleanly on --apply versus be blocked, splitting
// blocked into collision vs. other. Uses the EXACT predicate the apply guard
// uses (validateFrontmatter(proposed).report.valid, extension-less, matching
// apply.ts renderEntry) so projection cannot diverge from what apply writes.

import { validateFrontmatter } from "../frontmatter/schema.js";
import type { PlanEntry, ScopeCoverage } from "./types.js";

export function projectCoverage(entries: PlanEntry[]): ScopeCoverage {
  const coverage: ScopeCoverage = {
    planned: entries.length,
    willCatalog: 0,
    blockedByCollision: 0,
    blockedByOther: 0,
  };
  for (const entry of entries) {
    const { report } = validateFrontmatter(entry.proposed as unknown as Record<string, unknown>);
    if (report.valid) coverage.willCatalog += 1;
    else if (entry.collisions.length > 0) coverage.blockedByCollision += 1;
    else coverage.blockedByOther += 1;
  }
  return coverage;
}
