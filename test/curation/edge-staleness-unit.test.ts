import { describe, expect, it } from "vitest";
import { summarizeUpstream, type UpstreamStaleness } from "../../src/curation/edge-staleness.js";

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
