import { describe, expect, it } from "vitest";
import { validateFrontmatter } from "../../src/frontmatter/schema.js";

// Complete valid base; tests override only the fields under test.
function data(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Retry storms claim",
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "high",
    created: "2026-08-01",
    updated: "2026-08-01",
    updated_by: "agent:test",
    provenance: "direct",
    ...over,
  };
}

const alicePos = {
  id: "pos-001",
  principal: "alice",
  stance: "assert",
  statement: "Retry storms are caused by the 250ms floor",
  confidence: "high",
  provenance: "direct",
  valid_from: "2026-08-01",
  superseded_by: null,
  created: "2026-08-01",
  sources: ["experiments/retry-floor.md"],
};

const bobPos = {
  id: "pos-002",
  principal: "bob",
  stance: "dispute",
  statement: null,
  confidence: "medium",
  provenance: "direct",
  valid_from: null,
  superseded_by: null,
  created: "2026-08-02",
  sources: [],
};

describe("positions frontmatter validation (U-1)", () => {
  it("legacy doc: positions/org_position/contested are null, report unchanged", () => {
    const r = validateFrontmatter(data());
    expect(r.frontmatter.positions).toBeNull();
    expect(r.frontmatter.org_position).toBeNull();
    expect(r.frontmatter.contested).toBeNull();
    expect(r.report.valid).toBe(true);
  });

  it("parses two well-formed positions with all fields typed", () => {
    const r = validateFrontmatter(data({ positions: [alicePos, bobPos], contested: true }));
    expect(r.report.valid).toBe(true);
    expect(r.frontmatter.positions).toHaveLength(2);
    expect(r.frontmatter.positions?.[0]).toEqual(alicePos);
    expect(r.frontmatter.positions?.[1]).toEqual(bobPos);
    expect(r.frontmatter.contested).toBe(true);
  });

  it("drops an element missing 'stance' with an issue; the other survives", () => {
    const { stance: _stance, ...noStance } = alicePos;
    const r = validateFrontmatter(data({ positions: [noStance, bobPos] }));
    expect(r.report.issues.filter((i) => i.field === "positions")).toHaveLength(1);
    expect(r.frontmatter.positions).toHaveLength(1);
    expect(r.frontmatter.positions?.[0]?.id).toBe("pos-002");
  });

  it("flags a non-array positions value and types it null", () => {
    const r = validateFrontmatter(data({ positions: "yes" }));
    expect(r.frontmatter.positions).toBeNull();
    expect(
      r.report.issues.some((i) => i.field === "positions" && i.message.includes("expected array")),
    ).toBe(true);
  });

  it("dangling superseded_by is NOT a validation issue (semantic → lint)", () => {
    const r = validateFrontmatter(data({ positions: [{ ...alicePos, superseded_by: "pos-999" }] }));
    expect(r.report.issues.filter((i) => i.field === "positions")).toEqual([]);
    expect(r.frontmatter.positions?.[0]?.superseded_by).toBe("pos-999");
  });

  it("flags a non-boolean contested and types it null", () => {
    const r = validateFrontmatter(data({ contested: "maybe" }));
    expect(r.frontmatter.contested).toBeNull();
    expect(r.report.issues.some((i) => i.field === "contested")).toBe(true);
  });

  it("defaults element provenance to 'direct' when absent, flags when invalid", () => {
    const { provenance: _p, ...noProv } = alicePos;
    const ok = validateFrontmatter(data({ positions: [noProv] }));
    expect(ok.frontmatter.positions?.[0]?.provenance).toBe("direct");
    expect(ok.report.issues.filter((i) => i.field === "positions")).toEqual([]);
    const bad = validateFrontmatter(data({ positions: [{ ...alicePos, provenance: "psychic" }] }));
    expect(bad.frontmatter.positions?.[0]?.provenance).toBe("direct");
    expect(bad.report.issues.filter((i) => i.field === "positions")).toHaveLength(1);
  });
});
