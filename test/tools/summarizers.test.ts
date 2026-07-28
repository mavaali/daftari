// Degenerate-value coverage for every tool's `summarize`/`docLinks` (spec
// 2026-07-26, Decision 3, PR 1 gap closure, jugalbandi challenge C5).
//
// C5's finding: every summarizer is an unchecked cast, and the shipped test
// plan only exercised happy paths — a summarizer that indexes into an empty
// array, or reads a field only present in the non-degenerate branch, throws
// on a legal-but-sparse result and (pre-hardening) would have turned a
// successful tool call into an error response. These tests build the
// smallest legal value each tool's Result type allows — zero counts, empty
// arrays, null banners, coarsened "none"/"many" buckets — and assert the
// summarizer neither throws nor sharpens a coarsened disclosure, and that
// docLinks (where present) never re-derives a path absent from the value.
//
// Values are hand-built to the TypeScript result shape (not run through a
// live vault), so most also validate against the tool's own outputSchema —
// asserted here too, which additionally catches schema/shape drift.

import { describe, expect, it } from "vitest";
import { allRegisteredTools } from "../../src/server.js";
import type { ToolDefinition } from "../../src/tools/read.js";
import { expectMatchesOutputSchema } from "../helpers/output-schema.js";

function tool(name: string): ToolDefinition {
  const t = allRegisteredTools().find((x) => x.name === name);
  if (!t) throw new Error(`no such registered tool: ${name}`);
  return t;
}

// Runs `summarize`/`docLinks` against a value and asserts neither throws,
// summarize returns a non-empty string, and docLinks (if present) returns an
// array of strings. Optionally also pins the value against outputSchema.
function expectSummarizesCleanly(
  name: string,
  value: unknown,
  opts: { checkSchema?: boolean } = {},
): void {
  const t = tool(name);
  if (opts.checkSchema !== false) expectMatchesOutputSchema(t, value);
  expect(t.summarize, `${name} has no summarize`).toBeTruthy();
  let summary = "";
  expect(() => {
    summary = (t.summarize as (v: unknown) => string)(value);
  }, `${name}.summarize threw on a degenerate value`).not.toThrow();
  expect(typeof summary).toBe("string");
  expect(summary.length).toBeGreaterThan(0);
  if (t.docLinks) {
    let links: string[] = [];
    expect(() => {
      links = (t.docLinks as (v: unknown) => string[])(value);
    }, `${name}.docLinks threw on a degenerate value`).not.toThrow();
    expect(Array.isArray(links)).toBe(true);
    for (const l of links) expect(typeof l).toBe("string");
  }
}

const validation = { valid: true, issues: [] };

describe("read.ts summarizers — degenerate values", () => {
  it("vault_read: no decay/validity/upstream/structural, no contested", () => {
    expectSummarizesCleanly("vault_read", {
      path: "a.md",
      content: "",
      frontmatter: {
        title: "t",
        domain: "accumulation",
        collection: "c",
        status: "draft",
        confidence: "low",
        created: "2026-01-01",
        updated: "2026-01-01",
        updated_by: "agent:x",
        provenance: "direct",
        tier: null,
        sources: [],
        superseded_by: null,
        ttl_days: null,
        tags: [],
        describes: [],
        questions_answered: [],
        questions_raised: [],
      },
      raw: {},
      validation,
      hasFrontmatter: true,
      decay: null,
      validity: null,
      upstream_staleness: null,
      structural: null,
      anchors: null,
      version: "abc123",
    });
  });

  it("vault_index: zero entries", () => {
    expectSummarizesCleanly("vault_index", { count: 0, entries: [] });
  });

  it("vault_status: an empty vault", () => {
    expectSummarizesCleanly("vault_status", {
      vault: "/v",
      fileCount: 0,
      collections: [],
      invalidCount: 0,
      generatedAt: "2026-01-01T00:00:00Z",
      stalenessDistribution: { fresh: 0, aging: 0, stale: 0, total: 0 },
      validityCoverage: { authored: 0, unknown: 0, total: 0 },
      unresolvedTensions: { count: 0, recent: [] },
      recentWrites: { count: 0, entries: [] },
      embeddingDimMismatches: 0,
    });
  });
});

describe("search.ts summarizers — degenerate values", () => {
  it("vault_reindex: an empty vault, no warnings", () => {
    expectSummarizesCleanly("vault_reindex", {
      vault: "/v",
      documentCount: 0,
      chunkCount: 0,
      vectorEnabled: false,
      skipped: [],
      invalidFrontmatter: [],
      indexedAt: "2026-01-01T00:00:00Z",
      embeddedCount: 0,
      cacheHits: 0,
      orphansRemoved: 0,
    });
  });
});

describe("write.ts summarizers — degenerate values", () => {
  const base = {
    path: "a.md",
    commit: null,
    committed: false,
    status: "draft",
    updated: "2026-01-01",
    validation,
    indexUpdated: false,
  };

  it("vault_write: a plain applied write, no advisory fields", () => {
    expectSummarizesCleanly("vault_write", { ...base, action: "update" });
  });

  it("vault_write: a staged proposal, uncontested", () => {
    expectSummarizesCleanly("vault_write", {
      ...base,
      action: "staged",
      status: "pending",
      staged_id: "stage-1",
      expires_at: "2026-01-08T00:00:00Z",
      conflicts_with: [],
      tension_id: null,
    });
  });

  it("vault_write: a staged proposal, contested", () => {
    expectSummarizesCleanly("vault_write", {
      ...base,
      action: "staged",
      status: "pending",
      staged_id: "stage-1",
      expires_at: "2026-01-08T00:00:00Z",
      conflicts_with: ["stage-2", "stage-3"],
      tension_id: "tension-1",
    });
  });

  it("vault_append: a shadow-mode write", () => {
    expectSummarizesCleanly("vault_append", { ...base, action: "append", shadow: true });
  });

  it("vault_merge: sources present — docLinks names both", () => {
    const value = { ...base, action: "merge", sources: ["a.md", "b.md"] };
    expectSummarizesCleanly("vault_merge", value);
    expect(tool("vault_merge").docLinks?.(value)).toEqual(["a.md", "a.md", "b.md"]);
  });
});

describe("staged-actions.ts summarizers — degenerate values", () => {
  it("vault_stage_action: uncontested, no tension", () => {
    expectSummarizesCleanly("vault_stage_action", {
      id: "stage-1",
      expires_at: "2026-01-08T00:00:00Z",
      conflicts_with: [],
      tension_id: null,
    });
  });

  it("vault_ratify: rejected", () => {
    expectSummarizesCleanly("vault_ratify", {
      action_id: "stage-1",
      decision: "reject",
      applied: false,
    });
  });

  it("vault_ratify: shadow-applied", () => {
    expectSummarizesCleanly("vault_ratify", {
      action_id: "stage-1",
      decision: "approve",
      applied: false,
      shadow: true,
    });
  });
});

describe("curation.ts summarizers — degenerate values", () => {
  it("vault_tension_log: a legacy entry with no id", () => {
    const value = {
      date: "2026-01-01",
      title: "t",
      kind: "factual",
      sourceA: "a.md",
      claimA: "x",
      sourceB: "b.md",
      claimB: "y",
      status: "unresolved",
      loggedBy: "agent:x",
      resolved: false,
    };
    expectSummarizesCleanly("vault_tension_log", value, { checkSchema: false });
    expect(tool("vault_tension_log").docLinks?.(value)).toEqual(["a.md", "b.md"]);
  });

  it("vault_tension_resolve: a resolved entry with an id", () => {
    expectSummarizesCleanly(
      "vault_tension_resolve",
      {
        id: "tension-1",
        date: "2026-01-01",
        title: "t",
        kind: "factual",
        sourceA: "a.md",
        claimA: "x",
        sourceB: "b.md",
        claimB: "y",
        status: "resolved",
        loggedBy: "agent:x",
        resolved: true,
      },
      { checkSchema: false },
    );
  });

  it("vault_tension_clusters: zero clusters", () => {
    expectSummarizesCleanly("vault_tension_clusters", { cluster_count: 0, clusters: [] });
  });

  it("vault_tension_blast: no downstream, hidden bucket 'none'", () => {
    expectSummarizesCleanly("vault_tension_blast", {
      contested_document: "a.md",
      cluster_id: null,
      cluster_documents: [],
      downstream: [],
      primary_blast: 0,
      advisory_blast: 0,
      max_depth: 0,
      hidden_downstream: "none",
    });
  });

  it("vault_tension_blast: all-hidden — 'many' bucket, still zero visible downstream", () => {
    const value = {
      contested_document: "a.md",
      cluster_id: null,
      cluster_documents: [],
      downstream: [],
      primary_blast: 0,
      advisory_blast: 0,
      max_depth: 0,
      hidden_downstream: "many",
    };
    expectSummarizesCleanly("vault_tension_blast", value);
    const summary = tool("vault_tension_blast").summarize?.(value) ?? "";
    // The coarsened bucket must appear VERBATIM, never sharpened to a number.
    expect(summary).toContain("hidden: many");
  });

  it("vault_provenance: no history", () => {
    expectSummarizesCleanly("vault_provenance", { path: "a.md", count: 0, history: [] });
  });
});

describe("edges.ts summarizers — degenerate values", () => {
  const edge = {
    fromPath: "a.md",
    toPath: "b.md",
    strength: 0,
    kSurvived: 0,
    kEff: 0,
    strengthIndependent: 0,
    firstObserved: "2026-01-01T00:00:00Z",
    lastRederived: "2026-01-01T00:00:00Z",
    status: "candidate",
    directionVerdict: "directed",
    observations: 0,
    contestedAt: null,
    contestReason: null,
  };

  it("vault_edge_observe: a freshly seeded zero-strength edge", () => {
    expectSummarizesCleanly("vault_edge_observe", edge);
  });

  it("vault_edge_contest: no tension_id (reused legacy entry with none)", () => {
    expectSummarizesCleanly(
      "vault_edge_contest",
      { edge: { ...edge, status: "revoked" }, tension_id: undefined },
      { checkSchema: false },
    );
  });

  it("vault_edges: zero edges", () => {
    expectSummarizesCleanly("vault_edges", { edges: [], total: 0 });
  });
});

describe("consumes.ts summarizers — degenerate values", () => {
  it("vault_consumes: zero edges", () => {
    expectSummarizesCleanly("vault_consumes", {
      direction: "forward",
      anchor: "a.md",
      edges: [],
      total: 0,
      include_history: false,
    });
  });
});

describe("themes.ts summarizers — degenerate values", () => {
  it("vault_themes: zero themes", () => {
    expectSummarizesCleanly("vault_themes", {
      themes: [],
      docMemberships: {},
      totalDocuments: 0,
      totalChunks: 0,
      skippedDocuments: 0,
      selectedK: 10,
      droppedClusters: 0,
      clusteredAt: "2026-01-01T00:00:00Z",
    });
  });

  it("vault_themes: a theme with no retained primary member (all visitors) — no exemplar", () => {
    const value = {
      themes: [
        {
          id: 0,
          label: "x",
          documentCount: 1,
          primaryDocumentCount: 0,
          coherence: null,
          representativeDocs: [],
          secondaryDocs: ["a.md"],
          relatedTags: [],
        },
      ],
      docMemberships: {},
      totalDocuments: 1,
      totalChunks: 1,
      skippedDocuments: 0,
      selectedK: 10,
      droppedClusters: 0,
      clusteredAt: "2026-01-01T00:00:00Z",
    };
    expectSummarizesCleanly("vault_themes", value);
    expect(tool("vault_themes").docLinks?.(value)).toEqual([]);
  });
});

describe("witness.ts summarizers — degenerate values", () => {
  it("vault_witness: full report, nobody has written anything", () => {
    expectSummarizesCleanly("vault_witness", {
      principals: [],
      unattributedDocs: 0,
      concentration: { topPrincipal: null, topShare: 0 },
      flatCurveWarning: false,
    });
  });

  it("vault_witness: single-principal shape", () => {
    expectSummarizesCleanly(
      "vault_witness",
      {
        principal: {
          principal: "agent:x",
          writes: 0,
          firstWriteAt: null,
          lastWriteAt: null,
          docsAuthored: 0,
          liveClaims: 0,
          openExposure: 0,
          contestedOpen: 0,
          stakeAtRisk: 0,
          lost: 0,
          burnedStake: 0,
          survived: 0,
          creditEarned: 0,
          balance: 0,
          proposals: { total: 0, ratified: 0, rejected: 0, expired: 0, pending: 0 },
          tensionsLogged: 0,
        },
        concentration: { topPrincipal: null, topShare: 0 },
        flatCurveWarning: false,
      },
      { checkSchema: false },
    );
  });
});

describe("receipt.ts summarizers — degenerate values", () => {
  it("vault_receipt: an empty summary, no flags", () => {
    expectSummarizesCleanly("vault_receipt", {
      claim: null,
      sources: [],
      summary: {
        sourceCount: 0,
        byStatus: {},
        openTensions: 0,
        oldestUpdated: null,
        newestUpdated: null,
        flags: [],
      },
      vaultHead: null,
      generatedAt: "2026-01-01T00:00:00Z",
      receiptHash: "h",
    });
  });
});

describe("tier1.ts summarizers — degenerate values", () => {
  it("vault_tier1: no dependents, resolved at tier 1", () => {
    expectSummarizesCleanly("vault_tier1", {
      unit: "a.md",
      changed_fields: [],
      change_source: "explicit",
      verdicts: [],
      summary: {
        unaffected: 0,
        affected: 0,
        possibly_affected: 0,
        semantic_review: 0,
        resolved_at_tier1: true,
      },
    });
  });
});

describe("tier2.ts summarizers — degenerate values", () => {
  it("vault_tier2_queue: an empty queue", () => {
    expectSummarizesCleanly("vault_tier2_queue", { items: [], total: 0 });
  });

  it("vault_tier2_verdict: still-valid, no tension", () => {
    expectSummarizesCleanly("vault_tier2_verdict", {
      recorded: {
        timestamp: "2026-01-01T00:00:00Z",
        artifact: "a.md",
        unit: "b.md",
        edge_class: "declared",
        judged_change_ts: "2026-01-01T00:00:00Z",
        verdict: "still-valid",
        reasoning: "r",
        agent: "agent:x",
      },
      tension_id: null,
    });
  });
});

describe("edge-staleness.ts summarizers — degenerate values", () => {
  it("vault_staleness: artifact mode, nothing upstream", () => {
    expectSummarizesCleanly("vault_staleness", {
      mode: "artifact",
      artifact: "a.md",
      edges: [],
      hidden_pending: "none",
      summary: { current: 0, pending_unchecked: 0, pending_compatible: 0, pending_broken: 0 },
    });
  });

  it("vault_staleness: artifact mode, all-hidden bucket 'many'", () => {
    const value = {
      mode: "artifact",
      artifact: "a.md",
      edges: [],
      hidden_pending: "many",
      summary: { current: 0, pending_unchecked: 0, pending_compatible: 0, pending_broken: 0 },
    };
    expectSummarizesCleanly("vault_staleness", value);
    expect(tool("vault_staleness").summarize?.(value)).toContain("hidden_pending: many");
  });

  it("vault_staleness: broken-read report mode, nothing instrumented", () => {
    const value = {
      mode: "report",
      window_days: 30,
      serves: 0,
      broken_serves: 0,
      broken_read_rate: null,
      by_tool: {},
      uninstrumented: 0,
    };
    expectSummarizesCleanly("vault_staleness", value);
    expect(tool("vault_staleness").docLinks?.(value)).toEqual([]);
  });
});
