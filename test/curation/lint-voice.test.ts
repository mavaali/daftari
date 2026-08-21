import { describe, expect, it } from "vitest";
import { LINT_CHECKS, type LintCheckName, type LintFinding } from "../../src/curation/lint.js";
import { renderLedgerKeeper } from "../../src/curation/lint-voice.js";
import type { VaultLintResult } from "../../src/tools/curation.js";

// Builds a complete-enough VaultLintResult for the renderer. The renderer is a
// pure function of a fixed set of fields; unrelated nested summaries are stubbed
// to zero and cast, keeping fixtures readable.
function makeReport(overrides: {
  checks?: Partial<Record<LintCheckName, LintFinding[]>>;
  generatedAt?: string;
  tension?: Partial<{
    total: number;
    resolvedLifetime: number;
    stableAcknowledged: number;
    fresh: number;
    aging: number;
    stale: number;
    clusters: number;
    large: number;
    aged: number;
    blast: number;
  }>;
  staged?: number;
  expired?: number;
  shadowTotal?: number;
  shadowGated?: number;
  backstop?: number;
}): VaultLintResult {
  const checks = overrides.checks ?? {};
  const totalFindings = Object.values(checks).reduce((n, f) => n + (f?.length ?? 0), 0);
  const t = overrides.tension ?? {};
  return {
    generatedAt: overrides.generatedAt ?? "2026-07-30T00:00:00.000Z",
    filter: null,
    checks,
    totalFindings,
    tensionHealth: {
      total: t.total ?? 0,
      resolvedLifetime: t.resolvedLifetime ?? 0,
      stableAcknowledged: t.stableAcknowledged ?? 0,
      aging: { fresh: t.fresh ?? 0, aging: t.aging ?? 0, stale: t.stale ?? 0 },
      clusters: { count: t.clusters ?? 0, large: t.large ?? 0, aged: t.aged ?? 0 },
      blastRadiusOfStaleTensions: t.blast ?? 0,
    },
    stagedActions: Array.from({ length: overrides.staged ?? 0 }),
    shadowActions: { total: overrides.shadowTotal ?? 0, gated: overrides.shadowGated ?? 0 },
    coverageEquity: { backstopOverdue: { count: overrides.backstop ?? 0 } },
    compiledEdgeCoverage: {
      status: "no-data",
      total_documents: 0,
      instrumented_documents: 0,
      uninstrumented_documents: 0,
      message: "no compiled-edge data (0 docs uninstrumented)",
    },
    reviewThroughput: { lifetime: { expired: overrides.expired ?? 0 } },
  } as unknown as VaultLintResult;
}

describe("renderLedgerKeeper", () => {
  it("renders a minimal single-finding report exactly", () => {
    const report = makeReport({
      checks: {
        orphanFiles: [
          { path: "notes/lonely.md", detail: "no inbound links from any vault document" },
        ],
      },
    });
    const expected = [
      "The daftari has read the ledger. 1 matter noted — 0 beyond dispute, 1 left to your judgment. [2026-07-30T00:00:00.000Z]",
      "By my account: orphanFiles 1.",
      "Of disputes: 0 entered, 0 settled, 0 left standing by your leave; 0 fresh, 0 aging, 0 past patience; 0 knots (0 large, 0 aged); 0 entries shadowed by a stale dispute.",
      "Awaiting your ruling: 0 staged, 0 lapsed unread; 0 write(s) watched in shadow, 0 the budget would have stayed; 0 edge(s) overdue for backstop; compiled-edge coverage: no compiled-edge data (0 docs uninstrumented).",
      "The 1 entry most wanting your eye, of 1:",
      "  Entry notes/lonely.md speaks to no one, and no one to it. (no inbound links from any vault document)",
    ].join("\n");
    expect(renderLedgerKeeper(report)).toBe(expected);
  });

  it("renders a clean report with no findings", () => {
    const out = renderLedgerKeeper(makeReport({}));
    expect(out).toContain("By my account: the books balance.");
    expect(out).toContain("Nothing demands correction today.");
    expect(out).not.toContain("Entry ");
  });

  it("has a distinct ledger-keeper clause for every check", () => {
    for (const check of LINT_CHECKS) {
      const report = makeReport({ checks: { [check]: [{ path: "x/y.md", detail: "d" }] } });
      const out = renderLedgerKeeper(report);
      // The finding line names the entry and carries a check-specific clause.
      expect(out).toContain("Entry x/y.md ");
      // No finding renders with an empty clause (would appear as "Entry x/y.md .").
      expect(out).not.toContain("Entry x/y.md . ");
    }
  });

  it("caps the surfaced findings and lists tier-0 (certain) findings first", () => {
    // Two tier-0 (schemaInvalid) + six advisory (orphanFiles) = 8 findings; the
    // content channel surfaces the top 6, tier-0 first.
    const report = makeReport({
      checks: {
        schemaInvalid: [
          { path: "a.md", detail: "schema" },
          { path: "b.md", detail: "schema" },
        ],
        orphanFiles: Array.from({ length: 6 }, (_, i) => ({ path: `o${i}.md`, detail: "orphan" })),
      },
    });
    const out = renderLedgerKeeper(report);
    const entryLines = out.split("\n").filter((l) => l.startsWith("  Entry "));
    expect(entryLines).toHaveLength(6);
    expect(out).toContain("The 6 entries most wanting your eye, of 8:");
    // Both tier-0 findings are surfaced (they sort ahead of the advisory ones).
    expect(entryLines.some((l) => l.includes("a.md"))).toBe(true);
    expect(entryLines.some((l) => l.includes("b.md"))).toBe(true);
    // The first two surfaced entries are the tier-0 ones.
    expect(entryLines[0]).toContain("will not keep to the ledger's schema");
    expect(entryLines[1]).toContain("will not keep to the ledger's schema");
  });

  it("does not invent or drop paths: surfaced set is a subset of the input paths", () => {
    const report = makeReport({
      checks: {
        orphanFiles: [{ path: "one.md", detail: "d" }],
        oldDrafts: [{ path: "two.md", detail: "d" }],
      },
    });
    const out = renderLedgerKeeper(report);
    expect(out).toContain("Entry one.md ");
    expect(out).toContain("Entry two.md ");
  });
});
