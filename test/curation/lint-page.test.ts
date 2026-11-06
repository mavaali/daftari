import { describe, expect, it } from "vitest";
import {
  LINT_CHECKS,
  LINT_SUMMARY_DETAIL_CHARS,
  type LintCheckName,
  type LintFinding,
  TIER0_LINT_CHECKS,
} from "../../src/curation/lint.js";
import {
  LINT_PREVIEW_CHARS,
  LINT_PREVIEW_PER_CHECK,
  pageChecks,
  parseLintPaging,
  previewChecks,
} from "../../src/curation/lint-page.js";

function findings(n: number, prefix = "doc"): LintFinding[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `${prefix}-${i}.md`,
    detail: `detail ${i}`,
  }));
}

function allChecks(n: number): Record<LintCheckName, LintFinding[]> {
  return Object.fromEntries(LINT_CHECKS.map((c) => [c, findings(n, c)])) as Record<
    LintCheckName,
    LintFinding[]
  >;
}

describe("parseLintPaging", () => {
  it("is null when neither limit nor offset is given", () => {
    expect(parseLintPaging({})).toEqual({ ok: true, value: null });
    expect(parseLintPaging({ limit: null, offset: null })).toEqual({ ok: true, value: null });
  });

  it("defaults whichever of limit and offset is missing", () => {
    expect(parseLintPaging({ limit: 5 })).toEqual({ ok: true, value: { limit: 5, offset: 0 } });
    const fromOffset = parseLintPaging({ offset: 7 });
    expect(fromOffset.ok && fromOffset.value?.offset).toBe(7);
    expect(fromOffset.ok && fromOffset.value?.limit).toBeGreaterThan(0);
  });

  it.each([
    [{ limit: -1 }, "limit"],
    [{ limit: 1.5 }, "limit"],
    [{ limit: "10" }, "limit"],
    [{ offset: -1 }, "offset"],
    [{ offset: "2" }, "offset"],
  ])("rejects %j", (args, field) => {
    const result = parseLintPaging(args);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain(`'${field}'`);
  });
});

describe("pageChecks", () => {
  it("slices every reported check and reports where each one resumes", () => {
    const view = pageChecks(
      { staleFiles: findings(5), oldDrafts: findings(2) },
      { limit: 2, offset: 1 },
    );
    expect(view.checks.staleFiles?.map((f) => f.path)).toEqual(["doc-1.md", "doc-2.md"]);
    expect(view.checks.oldDrafts?.map((f) => f.path)).toEqual(["doc-1.md"]);
    expect(view.counts).toEqual({ staleFiles: 5, oldDrafts: 2 });
    // oldDrafts is exhausted, so it has no resume point.
    expect(view.nextOffset).toEqual({ staleFiles: 3 });
  });

  it("returns findings verbatim, unclipped", () => {
    const long = "x".repeat(LINT_SUMMARY_DETAIL_CHARS * 3);
    const view = pageChecks(
      { staleFiles: [{ path: "a.md", detail: long }] },
      { limit: 1, offset: 0 },
    );
    expect(view.checks.staleFiles?.[0]?.detail).toBe(long);
  });

  it("limit 0 is counts only", () => {
    const view = pageChecks({ staleFiles: findings(5) }, { limit: 0, offset: 0 });
    expect(view.checks.staleFiles).toEqual([]);
    expect(view.counts.staleFiles).toBe(5);
  });

  it("an offset past the end is an empty page, not an error", () => {
    const view = pageChecks({ staleFiles: findings(5) }, { limit: 2, offset: 99 });
    expect(view.checks.staleFiles).toEqual([]);
    expect(view.counts.staleFiles).toBe(5);
    expect(view.nextOffset).toEqual({});
  });
});

describe("previewChecks", () => {
  it("keeps every check, counts it in full, and shows its first few", () => {
    const view = previewChecks({
      ...allChecks(0),
      staleFiles: findings(10),
      oldDrafts: findings(1),
    });
    expect(Object.keys(view.checks).sort()).toEqual([...LINT_CHECKS].sort());
    expect(view.counts.staleFiles).toBe(10);
    expect(view.checks.staleFiles).toHaveLength(LINT_PREVIEW_PER_CHECK);
    expect(view.checks.oldDrafts).toHaveLength(1);
    expect(view.checks.orphanFiles).toEqual([]);
    expect(view.nextOffset).toEqual({ staleFiles: LINT_PREVIEW_PER_CHECK });
  });

  it("clips details to the content-channel width", () => {
    const view = previewChecks({
      ...allChecks(0),
      staleFiles: [{ path: "a.md", detail: "x".repeat(5000) }],
    });
    expect(view.checks.staleFiles?.[0]?.detail).toHaveLength(LINT_SUMMARY_DETAIL_CHARS);
  });

  it("stays inside the character budget however long the paths are", () => {
    const longPath = `${"very-long-collection-name/".repeat(4)}doc.md`;
    const checks = Object.fromEntries(
      LINT_CHECKS.map((c) => [
        c,
        Array.from({ length: 200 }, () => ({ path: longPath, detail: "y".repeat(500) })),
      ]),
    ) as Record<LintCheckName, LintFinding[]>;
    const view = previewChecks(checks);
    const size = Object.values(view.checks)
      .flat()
      .reduce((n, f) => n + JSON.stringify(f).length + 1, 0);
    expect(size).toBeLessThanOrEqual(LINT_PREVIEW_CHARS);
    // Counts survive the budget even when the previews do not.
    for (const c of LINT_CHECKS) expect(view.counts[c]).toBe(200);
  });

  it("a check the budget left out resumes from zero, and tier-0 checks are served first", () => {
    const longPath = `${"very-long-collection-name/".repeat(4)}doc.md`;
    const checks = Object.fromEntries(
      LINT_CHECKS.map((c) => [
        c,
        Array.from({ length: 5 }, () => ({ path: longPath, detail: "y".repeat(500) })),
      ]),
    ) as Record<LintCheckName, LintFinding[]>;
    const view = previewChecks(checks);
    for (const c of TIER0_LINT_CHECKS) expect(view.checks[c]?.length).toBeGreaterThan(0);
    for (const c of LINT_CHECKS) {
      expect(view.nextOffset[c]).toBe(view.checks[c]?.length);
    }
  });
});
