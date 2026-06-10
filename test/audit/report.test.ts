// test/audit/report.test.ts
import { describe, expect, it } from "vitest";
import { renderJson, renderMarkdown } from "../../src/audit/report.js";
import type { AuditReport } from "../../src/audit/types.js";

const REPORT: AuditReport = {
  generatedAt: "2026-05-30T12:00:00.000Z",
  config: {
    repos: [{ name: "a", path: "/r/a", docsGlob: "**/*.md", urls: [], type: "docs" }],
    output: {},
    staleness: { thresholdDays: 540 },
    failOn: { brokenRefs: 1, transitiveStaleness: 100, brokenDescribes: 1 },
  },
  totals: {
    reposScanned: 1,
    docsScanned: 3,
    brokenRefs: 1,
    directlyStale: 1,
    transitivelyStale: 1,
    brokenDescribes: 1,
    semanticDrifted: 0,
  },
  brokenRefs: [
    {
      kind: "missing_file",
      source: { repo: "a", path: "x.md" },
      target: { repo: "a", path: "y.md", anchor: null },
      rawHref: "y.md",
    },
  ],
  staleness: [
    { kind: "direct", repo: "a", path: "old.md", mtime: "2024-01-01T00:00:00.000Z" },
    {
      kind: "transitive",
      repo: "a",
      path: "z.md",
      mtime: "2026-05-01T00:00:00.000Z",
      staleChain: [
        { repo: "a", path: "z.md", mtime: "2026-05-01T00:00:00.000Z" },
        { repo: "a", path: "old.md", mtime: "2024-01-01T00:00:00.000Z" },
      ],
    },
  ],
  describesRefs: [
    {
      source: { repo: "a", path: "auth.md" },
      target: { repo: "svc", path: "src/gone.ts", symbol: "validateCredentials" },
      raw: "svc:src/gone.ts::validateCredentials",
    },
  ],
  semantic: [],
};

describe("renderMarkdown", () => {
  it("renders headers, totals, and per-finding rows", () => {
    const md = renderMarkdown(REPORT);
    expect(md).toContain("# Coherence Audit Report");
    expect(md).toContain("docs scanned: **3**");
    expect(md).toContain("missing_file");
    expect(md).toContain("a/x.md");
    expect(md).toContain("a/y.md");
    expect(md).toContain("a/z.md → a/old.md");
    // doc-to-code binding section + row
    expect(md).toContain("broken doc-to-code bindings: **1**");
    expect(md).toContain("svc/src/gone.ts::validateCredentials");
  });

  it("shows the empty-state message when nothing to report", () => {
    const md = renderMarkdown({
      ...REPORT,
      totals: {
        ...REPORT.totals,
        brokenRefs: 0,
        directlyStale: 0,
        transitivelyStale: 0,
        brokenDescribes: 0,
      },
      brokenRefs: [],
      staleness: [],
      describesRefs: [],
    });
    expect(md).toContain("no findings");
  });
});

describe("renderJson", () => {
  it("emits round-trippable JSON of the AuditReport", () => {
    const json = renderJson(REPORT);
    const round = JSON.parse(json);
    expect(round.totals.brokenRefs).toBe(1);
    expect(round.staleness[1].staleChain[1].path).toBe("old.md");
  });
});
