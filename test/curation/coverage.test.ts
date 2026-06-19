import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coverageEquitySummary } from "../../src/curation/coverage.js";
import type { DerivesFromEdge } from "../../src/curation/edges.js";
import type { ShadowActionRecord } from "../../src/curation/shadow.js";
import type { StagedAction } from "../../src/curation/staged-actions.js";
import type { LoadedDoc } from "../../src/curation/vault-docs.js";

const NOW = new Date("2026-06-19T00:00:00Z");

function edge(p: Partial<DerivesFromEdge> & { fromPath: string; toPath: string }): DerivesFromEdge {
  return {
    strength: 1,
    kSurvived: 1,
    firstObserved: "2026-01-01T00:00:00Z",
    lastRederived: "2026-06-19T00:00:00Z",
    status: "trigger-bearing",
    directionVerdict: "directed",
    observations: 1,
    contestedAt: null,
    contestReason: null,
    ...p,
  };
}
// A doc with a wikilink body so the reverse maps have downstream structure.
function doc(path: string, body = ""): LoadedDoc {
  // Minimal LoadedDoc — only path + content are read by the reverse-map builders.
  return { path, content: body, frontmatter: {} as any } as LoadedDoc;
}

// SHARED fixture doc set (also used by Task 6's alias test — keep them in sync,
// per the plan-reviewer's drift caution). CRITICAL: computeBlast EXCLUDES the
// seed endpoints from `downstream`. The monitor's blast drops the envelope's `+1`
// footprint, so an edge is "core" (downstream.length > 0) ONLY if some doc that is
// NOT one of its two endpoints links to / sources an endpoint. Hence `consumer.md`:
// it links [[hub]] and is not an endpoint of the core edge, so hub.md's downstream
// is non-empty. A 2-node fixture (only the endpoints) is ALWAYS periphery.
function blastDocs(): LoadedDoc[] {
  return [
    doc("consumer.md", "see [[hub]]"), // non-seed doc downstream of hub.md
    doc("hub.md"),
    doc("dependent.md"),
    doc("lonely.md"),
    doc("orphan.md"),
  ];
}

function shadowRow(action: string, decision?: "admitted" | "gated"): ShadowActionRecord {
  return {
    at: "2026-06-19T00:00:00Z",
    tool: "t",
    action,
    target_path: "x.md",
    agent: "a",
    i_base: 0,
    blast: 1,
    impact: 0,
    budget: 1,
    spent_before: 0,
    would_gate: false,
    commit_message: "m",
    ...(decision ? { decision } : {}),
  } as ShadowActionRecord;
}
function staged(actionType: string, status = "pending"): StagedAction {
  return {
    id: "1",
    actionType,
    targetPath: "x.md",
    proposedBy: "a",
    proposedAt: "",
    expiresAt: "",
    status,
    rationale: "",
    proposedDiff: null,
    ratifiedAt: null,
    ratifiedBy: null,
    ratificationReason: null,
    decidedByPrincipal: null,
  };
}

describe("coverageEquitySummary", () => {
  it("returns all-zero summary for an empty vault", () => {
    const r = coverageEquitySummary({
      docs: [],
      edges: [],
      shadowRecords: [],
      stagedActions: [],
      now: NOW,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value;
    expect(s.strengthDrift.core.count).toBe(0);
    expect(s.strengthDrift.periphery.count).toBe(0);
    // gap is null (undefined) when either group is empty — here both are
    expect(s.strengthDrift.coreMinusPeripheryMedian).toBeNull();
    expect(s.strengthDrift.belowTriggerCount).toBe(0);
    expect(s.backstopOverdue.count).toBe(0);
    expect(s.actionMix.total).toBe(0);
    expect(s.actionMix.cheapLinkFraction).toBe(0);
    expect(s.directionResolution.directed).toBe(0);
    expect(s.directionResolution.symmetric).toBe(0);
    expect(s.directionResolution.unresolvedFraction).toBe(0);
  });
});

describe("strength-distribution drift", () => {
  it("splits edges into core (blast>0) and periphery (blast==0)", () => {
    const docs = blastDocs();
    const edges = [
      // seeds {hub.md, dependent.md}; consumer.md (non-seed) links hub → downstream≥1 → CORE
      edge({ fromPath: "hub.md", toPath: "dependent.md", strength: 4 }),
      // lonely.md / orphan.md have no inbound links → downstream 0 → PERIPHERY
      edge({ fromPath: "lonely.md", toPath: "orphan.md", strength: 1 }),
    ];
    const r = coverageEquitySummary({
      docs,
      edges,
      shadowRecords: [],
      stagedActions: [],
      now: NOW,
    });
    expect(r.ok && r.value.strengthDrift.core.count).toBe(1);
    expect(r.ok && r.value.strengthDrift.periphery.count).toBe(1);
    expect(r.ok && r.value.strengthDrift.coreMinusPeripheryMedian).toBeCloseTo(3, 5);
    // cheap mis-bucketing regression guard: every live edge lands in exactly one group
    expect(r.ok && r.value.strengthDrift.core.count + r.value.strengthDrift.periphery.count).toBe(
      2,
    );
  });

  it("reports a null median gap when one group is empty (no false 'no drift')", () => {
    const docs = blastDocs();
    // only a periphery edge (no core) → gap undefined, must be null not 0
    const edges = [edge({ fromPath: "lonely.md", toPath: "orphan.md", strength: 0.3 })];
    const r = coverageEquitySummary({
      docs,
      edges,
      shadowRecords: [],
      stagedActions: [],
      now: NOW,
    });
    expect(r.ok && r.value.strengthDrift.core.count).toBe(0);
    expect(r.ok && r.value.strengthDrift.periphery.count).toBe(1);
    expect(r.ok && r.value.strengthDrift.coreMinusPeripheryMedian).toBeNull();
  });

  it("excludes revoked edges from the distribution", () => {
    const docs = [doc("a.md"), doc("b.md")];
    const edges = [edge({ fromPath: "a.md", toPath: "b.md", strength: 0, status: "revoked" })];
    const r = coverageEquitySummary({
      docs,
      edges,
      shadowRecords: [],
      stagedActions: [],
      now: NOW,
    });
    expect(r.ok && r.value.strengthDrift.core.count).toBe(0);
    expect(r.ok && r.value.strengthDrift.periphery.count).toBe(0);
  });

  it("counts edges decayed below EDGE_TRIGGER_STRENGTH", () => {
    const docs = [doc("a.md"), doc("b.md"), doc("c.md"), doc("d.md")];
    const edges = [
      edge({ fromPath: "a.md", toPath: "b.md", strength: 0.3 }), // below 0.5
      edge({ fromPath: "c.md", toPath: "d.md", strength: 0.9 }), // above
    ];
    const r = coverageEquitySummary({
      docs,
      edges,
      shadowRecords: [],
      stagedActions: [],
      now: NOW,
    });
    expect(r.ok && r.value.strengthDrift.belowTriggerCount).toBe(1);
  });
});

describe("backstop-overdue", () => {
  it("counts edges past the 90-day max interval; boundary is inclusive", () => {
    const docs = [doc("a.md"), doc("b.md"), doc("c.md"), doc("d.md")];
    const at89 = new Date(NOW.getTime() - 89 * 86_400_000).toISOString();
    const at90 = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
    const edges = [
      edge({ fromPath: "a.md", toPath: "b.md", lastRederived: at90 }), // overdue
      edge({ fromPath: "c.md", toPath: "d.md", lastRederived: at89 }), // not overdue
    ];
    const r = coverageEquitySummary({
      docs,
      edges,
      shadowRecords: [],
      stagedActions: [],
      now: NOW,
    });
    expect(r.ok && r.value.backstopOverdue.count).toBe(1);
    expect(r.ok && r.value.backstopOverdue.stalest[0]?.fromPath).toBe("a.md");
    expect(r.ok && r.value.backstopOverdue.stalest[0]?.daysOverdue).toBeGreaterThanOrEqual(0);
  });
});

describe("action-mix drift", () => {
  it("computes cheap-link fraction over edge-op + staged rows", () => {
    const shadowRecords = [
      shadowRow("edge-observe", "admitted"),
      shadowRow("edge-observe", "admitted"),
      shadowRow("edge-contest", "admitted"),
    ];
    const stagedActions = [staged("merge")]; // total = 4, edge-observe = 2
    const r = coverageEquitySummary({
      docs: [],
      edges: [],
      shadowRecords,
      stagedActions,
      now: NOW,
    });
    expect(r.ok && r.value.actionMix.total).toBe(4);
    expect(r.ok && r.value.actionMix.cheapLinkFraction).toBeCloseTo(0.5, 5);
    expect(r.ok && r.value.actionMix.counts["edge-observe"]).toBe(2);
    expect(r.ok && r.value.actionMix.counts["merge"]).toBe(1);
  });

  it("excludes doc-write calibration rows from the denominator", () => {
    const shadowRecords = [
      shadowRow("edge-observe", "admitted"),
      shadowRow("write"), // doc-write calibration row: no decision, non-edge action
      shadowRow("append"), // ditto
    ];
    const r = coverageEquitySummary({
      docs: [],
      edges: [],
      shadowRecords,
      stagedActions: [],
      now: NOW,
    });
    expect(r.ok && r.value.actionMix.total).toBe(1); // only the edge-observe
    expect(r.ok && r.value.actionMix.cheapLinkFraction).toBe(1);
    expect(r.ok && r.value.actionMix.counts["write"]).toBeUndefined();
  });

  it("excludes expired/rejected staged actions (counts only pending+ratified)", () => {
    const shadowRecords = [shadowRow("edge-observe", "admitted")];
    const stagedActions = [
      staged("merge", "ratified"), // enacted → counts
      staged("deprecate", "pending"), // live proposal → counts
      staged("merge", "expired"), // died → excluded
      staged("supersede", "rejected"), // died → excluded
    ];
    const r = coverageEquitySummary({
      docs: [],
      edges: [],
      shadowRecords,
      stagedActions,
      now: NOW,
    });
    // denominator = 1 edge-observe + 2 live staged (merge ratified, deprecate pending)
    expect(r.ok && r.value.actionMix.total).toBe(3);
    expect(r.ok && r.value.actionMix.counts["merge"]).toBe(1); // expired merge not counted
    expect(r.ok && r.value.actionMix.counts["deprecate"]).toBe(1);
    expect(r.ok && r.value.actionMix.counts["supersede"]).toBeUndefined();
    expect(r.ok && r.value.actionMix.cheapLinkFraction).toBeCloseTo(1 / 3, 5);
  });
});

describe("direction-resolution", () => {
  it("reports directed vs symmetric over non-revoked edges", () => {
    const edges = [
      edge({ fromPath: "a.md", toPath: "b.md", directionVerdict: "directed" }),
      edge({ fromPath: "c.md", toPath: "d.md", directionVerdict: "symmetric" }),
      edge({
        fromPath: "e.md",
        toPath: "f.md",
        directionVerdict: "symmetric",
        status: "revoked",
      }), // excluded
    ];
    const r = coverageEquitySummary({
      docs: [],
      edges,
      shadowRecords: [],
      stagedActions: [],
      now: NOW,
    });
    expect(r.ok && r.value.directionResolution.directed).toBe(1);
    expect(r.ok && r.value.directionResolution.symmetric).toBe(1);
    expect(r.ok && r.value.directionResolution.unresolvedFraction).toBeCloseTo(0.5, 5);
  });

  it("all-symmetric vault → unresolvedFraction 1, backstop-overdue 0", () => {
    const oldISO = new Date(NOW.getTime() - 200 * 86_400_000).toISOString();
    const edges = [
      edge({
        fromPath: "a.md",
        toPath: "b.md",
        directionVerdict: "symmetric",
        lastRederived: oldISO,
      }),
    ];
    const r = coverageEquitySummary({
      docs: [],
      edges,
      shadowRecords: [],
      stagedActions: [],
      now: NOW,
    });
    expect(r.ok && r.value.directionResolution.unresolvedFraction).toBe(1);
    expect(r.ok && r.value.backstopOverdue.count).toBe(0); // symmetric never becomes due
  });
});

describe("path-alias canonicalization", () => {
  it("canonicalizes aliased edge paths so blast isn't mis-bucketed", () => {
    // Reuse the shared blastDocs() set — consumer.md makes the PLAIN hub.md edge core.
    const docs = blastDocs();
    // Aliased form of hub.md — must canon() to "hub.md" (the reverse-map key).
    const edges = [edge({ fromPath: "sub/../hub.md", toPath: "dependent.md", strength: 2 })];
    const r = coverageEquitySummary({
      docs,
      edges,
      shadowRecords: [],
      stagedActions: [],
      now: NOW,
    });
    // With canon(): seeds {hub.md, dependent.md}, consumer.md downstream → CORE.
    // Without canon(): seed "sub/../hub.md" is not a reverse-map key → downstream 0
    // → periphery. So core.count===1 proves canon() routed the alias correctly.
    expect(r.ok && r.value.strengthDrift.core.count).toBe(1);
    expect(r.ok && r.value.strengthDrift.periphery.count).toBe(0);
  });
});

describe("monitor-never-target invariant", () => {
  it("no src/consolidate/ module imports the coverage monitor", () => {
    const dir = join(process.cwd(), "src", "consolidate");
    const offenders: string[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      if (/from\s+["'][^"']*curation\/coverage(\.js)?["']/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
