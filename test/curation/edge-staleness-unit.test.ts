import { describe, expect, it } from "vitest";
import { compiledUpstreamStaleness, summarizeUpstream, type UpstreamStaleness } from "../../src/curation/edge-staleness.js";
import type { ConsumesEdge } from "../../src/curation/consumes.js";

function row(staleness: UpstreamStaleness["staleness"]): UpstreamStaleness {
  return { unit: "u", edge_class: "compiled", staleness, baseline: null, changed_fields: [], reason: "" };
}

describe("summarizeUpstream — unverifiable", () => {
  it("counts unverifiable rows in their own bucket", () => {
    const s = summarizeUpstream([row("unverifiable"), row("unverifiable"), row("current")]);
    expect(s.unverifiable).toBe(2);
    expect(s.current).toBe(1);
    expect(s.pending_broken).toBe(0);
  });
});

function consumesEdge(unit: string, compile_ts: string): ConsumesEdge {
  return {
    artifact: "art.md",
    unit,
    edge_type: "whole-doc-read",
    fields: ["*"],
    run_id: "run-1",
    compile_ts,
  };
}

describe("classifyEdge — unverifiable predicate", () => {
  const consumes = [consumesEdge("gone.md", "2026-07-01T00:00:00Z")];

  it("marks an unverifiable unit unverifiable even with zero writes (pre-empts current)", () => {
    const rows = compiledUpstreamStaleness("art.md", consumes, [], () => false);
    expect(rows[0]?.staleness).toBe("unverifiable");
    expect(rows[0]?.reason).toBe("source not in your readable vault");
    expect(rows[0]?.reason).not.toContain("deleted");
  });

  it("without a predicate, an unchanged unit is still current (unchanged behavior)", () => {
    const rows = compiledUpstreamStaleness("art.md", consumes, []);
    expect(rows[0]?.staleness).toBe("current");
  });

  it("a verifiable unit classifies normally", () => {
    const rows = compiledUpstreamStaleness("art.md", consumes, [], () => true);
    expect(rows[0]?.staleness).toBe("current");
  });
});
