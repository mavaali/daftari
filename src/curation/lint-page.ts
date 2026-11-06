// How much of a lint report reaches the caller (#644). runLint stays complete —
// the board and every other internal consumer need all of it — so paging lives
// here, applied to a finished report. It runs after pathVisible has already
// shaped that report, which is why it cannot change what a caller may see: a
// count is the length of the list the caller could already receive, and no
// offset reaches past it.

import { err, ok, type Result } from "../frontmatter/types.js";
import {
  clip,
  LINT_CHECKS,
  LINT_SUMMARY_DETAIL_CHARS,
  type LintCheckName,
  type LintFinding,
  type StagedActionLintItem,
  TIER0_LINT_CHECKS,
} from "./lint.js";
import type { ShadowLintSummary } from "./shadow.js";

// A default vault_lint must fit an MCP client's result limit on a real vault
// (88K observed at 295 documents). Previews are spent against a character
// budget, not only a per-check cap: details and paths have no length limit, so
// a count alone could not hold the bound.
export const LINT_PREVIEW_PER_CHECK = 3;
export const LINT_PREVIEW_CHARS = 3_500;
// The staged and shadow lists preview the same way, at the same detail width.
export const LINT_PREVIEW_LIST_ITEMS = 2;
export const LINT_PAGE_DEFAULT_LIMIT = 50;

export interface LintPaging {
  limit: number;
  offset: number;
}

export interface LintChecksView {
  checks: Partial<Record<LintCheckName, LintFinding[]>>;
  // Findings the caller can see per check, before any slicing.
  counts: Partial<Record<LintCheckName, number>>;
  // Where each check resumes. A check with nothing left has no entry.
  nextOffset: Partial<Record<LintCheckName, number>>;
}

function parseCount(raw: unknown, name: string): Result<number | null, Error> {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    return err(new Error(`vault_lint '${name}' must be a non-negative integer`));
  }
  return ok(raw);
}

// Null when the caller asked for neither, leaving the mode to the caller.
export function parseLintPaging(args: Record<string, unknown>): Result<LintPaging | null, Error> {
  const limit = parseCount(args.limit, "limit");
  if (!limit.ok) return limit;
  const offset = parseCount(args.offset, "offset");
  if (!offset.ok) return offset;
  if (limit.value === null && offset.value === null) return ok(null);
  return ok({ limit: limit.value ?? LINT_PAGE_DEFAULT_LIMIT, offset: offset.value ?? 0 });
}

// One page of every reported check, findings verbatim.
export function pageChecks(
  reported: Partial<Record<LintCheckName, LintFinding[]>>,
  { limit, offset }: LintPaging,
): LintChecksView {
  const view: LintChecksView = { checks: {}, counts: {}, nextOffset: {} };
  for (const check of LINT_CHECKS) {
    const findings = reported[check];
    if (!findings) continue;
    view.checks[check] = findings.slice(offset, offset + limit);
    view.counts[check] = findings.length;
    if (offset + limit < findings.length) view.nextOffset[check] = offset + limit;
  }
  return view;
}

// The first few findings of every check, details clipped. Filled round-robin,
// tier-0 first, so a tight budget thins every check rather than starving the
// last ones, and certain failures are the last to go.
export function previewChecks(reported: Record<LintCheckName, LintFinding[]>): LintChecksView {
  const view = pageChecks(reported, { limit: 0, offset: 0 });

  const order = [
    ...TIER0_LINT_CHECKS,
    ...LINT_CHECKS.filter((check) => !TIER0_LINT_CHECKS.includes(check)),
  ];
  let budget = LINT_PREVIEW_CHARS;
  for (let round = 0; round < LINT_PREVIEW_PER_CHECK && budget > 0; round++) {
    for (const check of order) {
      const finding = reported[check][round];
      if (!finding) continue;
      const clipped = {
        path: finding.path,
        detail: clip(finding.detail, LINT_SUMMARY_DETAIL_CHARS),
      };
      budget -= JSON.stringify(clipped).length + 1;
      if (budget < 0) break;
      view.checks[check]?.push(clipped);
    }
  }

  view.nextOffset = {};
  for (const check of LINT_CHECKS) {
    const shown = view.checks[check]?.length ?? 0;
    if (shown < reported[check].length) view.nextOffset[check] = shown;
  }
  return view;
}

export function previewStagedActions(items: StagedActionLintItem[]): StagedActionLintItem[] {
  return items
    .slice(0, LINT_PREVIEW_LIST_ITEMS)
    .map((item) => ({ ...item, rationale: clip(item.rationale, LINT_SUMMARY_DETAIL_CHARS) }));
}

export function previewShadowActions(summary: ShadowLintSummary): ShadowLintSummary {
  return {
    ...summary,
    recentGated: summary.recentGated.slice(0, LINT_PREVIEW_LIST_ITEMS),
    gatedSurfaced: summary.gatedSurfaced.slice(0, LINT_PREVIEW_LIST_ITEMS),
  };
}
