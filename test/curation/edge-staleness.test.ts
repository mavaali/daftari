import { describe, expect, it } from "vitest";
import type { ConsumesEdge } from "../../src/curation/consumes.js";
import {
  changedFieldsSince,
  compiledUpstreamStaleness,
  summarizeUpstream,
  upstreamStaleness,
} from "../../src/curation/edge-staleness.js";
import type { ProvenanceEntry } from "../../src/curation/provenance.js";

function entry(over: Partial<ProvenanceEntry>): ProvenanceEntry {
  return {
    timestamp: "2026-07-10T00:00:00.000Z",
    tool: "vault_write",
    file: "a/unit.md",
    agent: "agent:x",
    action: "update",
    body_changed: false,
    ...over,
  };
}

function edge(over: Partial<ConsumesEdge> = {}): ConsumesEdge {
  return {
    artifact: "a/artifact.md",
    unit: "a/unit.md",
    edge_type: "whole-doc-read",
    fields: ["*"],
    run_id: "run-1",
    compile_ts: "2026-07-05T00:00:00.000Z",
    ...over,
  };
}

describe("edge staleness (#234)", () => {
  it("changedFieldsSince folds only strictly-later landed writes", () => {
    const prov = [
      entry({ timestamp: "2026-07-04T00:00:00.000Z", body_changed: true }), // before baseline
      entry({ timestamp: "2026-07-05T00:00:00.000Z", body_changed: true }), // AT baseline — excluded
      entry({
        timestamp: "2026-07-06T00:00:00.000Z",
        frontmatter_diff: { tags: { before: [], after: ["x"] } },
      }),
      entry({
        timestamp: "2026-07-07T00:00:00.000Z",
        action: "rejected_stale",
        body_changed: true,
      }),
      entry({
        timestamp: "2026-07-08T00:00:00.000Z",
        frontmatter_diff: { updated: { before: "a", after: "b" } },
      }),
      entry({ timestamp: "2026-07-09T00:00:00.000Z", file: "a/other.md", body_changed: true }),
    ];
    const { changed, writes } = changedFieldsSince(prov, "a/unit.md", "2026-07-05T00:00:00.000Z");
    expect(writes).toBe(2); // the tags write and the bookkeeping write
    expect(changed).toEqual(["tags"]); // bookkeeping stripped, rejected/foreign/early excluded
  });

  it("classifies current / pending-compatible / pending-broken on compiled edges", () => {
    const consumes = [edge()];
    // No writes after the compile: current.
    expect(compiledUpstreamStaleness("a/artifact.md", consumes, [])[0]?.staleness).toBe("current");

    // Bookkeeping-only churn after the compile: pending-compatible.
    const bookkeeping = [
      entry({
        timestamp: "2026-07-06T00:00:00.000Z",
        frontmatter_diff: { updated: { before: "a", after: "b" } },
      }),
    ];
    const compatible = compiledUpstreamStaleness("a/artifact.md", consumes, bookkeeping)[0];
    expect(compatible?.staleness).toBe("pending-compatible");
    expect(compatible?.changed_fields).toEqual([]);

    // A content change against a whole-doc edge: pending-broken.
    const content = [entry({ timestamp: "2026-07-06T00:00:00.000Z", body_changed: true })];
    const broken = compiledUpstreamStaleness("a/artifact.md", consumes, content)[0];
    expect(broken?.staleness).toBe("pending-broken");
    expect(broken?.changed_fields).toEqual(["body"]);
    expect(broken?.baseline).toBe("2026-07-05T00:00:00.000Z");
  });

  it("a field-scoped compiled edge misses a change to other fields", () => {
    const consumes = [edge({ fields: ["formula"] })];
    const prov = [
      entry({
        timestamp: "2026-07-06T00:00:00.000Z",
        frontmatter_diff: { description: { before: "a", after: "b" } },
      }),
    ];
    const row = compiledUpstreamStaleness("a/artifact.md", consumes, prov)[0];
    expect(row?.staleness).toBe("pending-compatible");
    expect(row?.changed_fields).toEqual(["description"]);
  });

  it("only the newest compile group counts, and self-edges are excluded", () => {
    const consumes = [
      edge({ compile_ts: "2026-07-01T00:00:00.000Z", unit: "a/old-unit.md" }),
      edge({ compile_ts: "2026-07-05T00:00:00.000Z" }),
      edge({ compile_ts: "2026-07-05T00:00:00.000Z", unit: "a/artifact.md" }), // self
    ];
    const rows = compiledUpstreamStaleness("a/artifact.md", consumes, []);
    expect(rows.map((r) => r.unit)).toEqual(["a/unit.md"]);
  });

  it("declared and earned changes park in pending-unchecked — the class ceiling", () => {
    const prov = [
      // The artifact's own write fixes the declared baseline.
      entry({ timestamp: "2026-07-05T00:00:00.000Z", file: "a/artifact.md", body_changed: true }),
      // The cited unit changes afterwards.
      entry({ timestamp: "2026-07-06T00:00:00.000Z", body_changed: true }),
    ];
    const rows = upstreamStaleness({
      artifact: "a/artifact.md",
      consumes: [],
      provenance: prov,
      declaredUnits: ["a/unit.md"],
      earned: [{ unit: "a/unit.md", lastRederived: "2026-07-05T12:00:00.000Z" }],
    });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.staleness === "pending-unchecked")).toBe(true);
    expect(rows.map((r) => r.edge_class).sort()).toEqual(["declared", "earned"]);

    // An earned edge re-derived AFTER the unit's last change is current.
    const fresh = upstreamStaleness({
      artifact: "a/artifact.md",
      consumes: [],
      provenance: prov,
      declaredUnits: [],
      earned: [{ unit: "a/unit.md", lastRederived: "2026-07-07T00:00:00.000Z" }],
    });
    expect(fresh[0]?.staleness).toBe("current");
  });

  it("a declared edge with no artifact provenance has no baseline — never checked", () => {
    const rows = upstreamStaleness({
      artifact: "a/artifact.md",
      consumes: [],
      provenance: [entry({ timestamp: "2026-07-06T00:00:00.000Z", body_changed: true })],
      declaredUnits: ["a/unit.md"],
      earned: [],
    });
    expect(rows[0]?.staleness).toBe("pending-unchecked");
    expect(rows[0]?.baseline).toBeNull();
    expect(rows[0]?.reason).toContain("no baseline");
  });

  it("a covering tier-2 verdict resolves the residual; a stale one does not", () => {
    const prov = [
      entry({ timestamp: "2026-07-05T00:00:00.000Z", file: "a/artifact.md", body_changed: true }),
      entry({ timestamp: "2026-07-06T00:00:00.000Z", body_changed: true }),
    ];
    const base = {
      artifact: "a/artifact.md",
      consumes: [],
      provenance: prov,
      declaredUnits: ["a/unit.md"],
      earned: [],
    };
    const verdict = {
      timestamp: "2026-07-07T00:00:00.000Z",
      artifact: "a/artifact.md",
      unit: "a/unit.md",
      edge_class: "declared" as const,
      judged_change_ts: "2026-07-06T00:00:00.000Z",
      verdict: "still-valid" as const,
      reasoning: "holds",
      agent: "agent:judge",
    };

    const covered = upstreamStaleness({ ...base, verdicts: [verdict] });
    expect(covered[0]?.staleness).toBe("pending-compatible");
    expect(covered[0]?.reason).toContain("tier-2");

    const broken = upstreamStaleness({
      ...base,
      verdicts: [{ ...verdict, verdict: "broken" as const, tension_id: "t-007" }],
    });
    expect(broken[0]?.staleness).toBe("pending-broken");
    expect(broken[0]?.reason).toContain("t-007");

    // Judged before the unit's latest write: covers nothing, still queued.
    const stale = upstreamStaleness({
      ...base,
      verdicts: [{ ...verdict, judged_change_ts: "2026-07-05T12:00:00.000Z" }],
    });
    expect(stale[0]?.staleness).toBe("pending-unchecked");
  });

  it("summarizeUpstream counts by class", () => {
    const prov = [entry({ timestamp: "2026-07-06T00:00:00.000Z", body_changed: true })];
    const rows = upstreamStaleness({
      artifact: "a/artifact.md",
      consumes: [edge()],
      provenance: prov,
      declaredUnits: ["a/unit.md"],
      earned: [{ unit: "a/unit.md", lastRederived: "2026-07-07T00:00:00.000Z" }],
    });
    expect(summarizeUpstream(rows)).toEqual({
      current: 1,
      pending_unchecked: 1,
      pending_compatible: 0,
      pending_broken: 1,
    });
  });
});
