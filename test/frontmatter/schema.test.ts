import { describe, expect, it } from "vitest";
import { validateFrontmatter } from "../../src/frontmatter/schema.js";

// A complete, valid data object; tests override only the date field under test
// so the only "interesting" issues are for created/updated.
function data(over: Record<string, unknown>): Record<string, unknown> {
  return {
    title: "T",
    domain: "accumulation",
    collection: "notes",
    status: "canonical",
    confidence: "high",
    created: "2026-03-01",
    updated: "2026-03-01",
    updated_by: "agent:test",
    provenance: "direct",
    ...over,
  };
}

function issuesFor(field: string, over: Record<string, unknown>) {
  return validateFrontmatter(data(over)).report.issues.filter((i) => i.field === field);
}

// requireDate is non-destructive on the source value: it preserves the author's
// raw string verbatim (serializeDocument writes it back to disk, #113) and only
// FLAGS anything that isn't a canonical, real-calendar YYYY-MM-DD. The
// normalize-or-empty for the index happens later, in insertDocument.
describe("requireDate validation (preserves raw, flags malformed)", () => {
  it("passes a canonical YYYY-MM-DD through unchanged with no issue", () => {
    const r = validateFrontmatter(data({ created: "2026-03-01" }));
    expect(r.frontmatter.created).toBe("2026-03-01");
    expect(r.report.issues.filter((i) => i.field === "created")).toEqual([]);
  });

  it("preserves a non-padded date verbatim but flags it", () => {
    const r = validateFrontmatter(data({ created: "2026-3-1" }));
    expect(r.frontmatter.created).toBe("2026-3-1"); // raw, NOT rewritten
    expect(issuesFor("created", { created: "2026-3-1" })).toHaveLength(1);
  });

  it("preserves a slash-separated date verbatim but flags it", () => {
    const r = validateFrontmatter(data({ created: "2026/03/01" }));
    expect(r.frontmatter.created).toBe("2026/03/01");
    expect(issuesFor("created", { created: "2026/03/01" })).toHaveLength(1);
  });

  it("preserves a textual date verbatim but flags it", () => {
    const r = validateFrontmatter(data({ created: "March 2026" }));
    expect(r.frontmatter.created).toBe("March 2026");
    expect(issuesFor("created", { created: "March 2026" })).toHaveLength(1);
  });

  it("flags an out-of-range date (regression: was unflagged before)", () => {
    const r = validateFrontmatter(data({ created: "2026-13-45" }));
    expect(r.frontmatter.created).toBe("2026-13-45"); // preserved raw
    expect(issuesFor("created", { created: "2026-13-45" })).toHaveLength(1);
  });

  it("flags a rollover non-day (2026-02-30)", () => {
    expect(issuesFor("created", { created: "2026-02-30" })).toHaveLength(1);
  });

  it("flags a non-leap-year Feb 29 (2026-02-29) but accepts a real leap day", () => {
    expect(issuesFor("created", { created: "2026-02-29" })).toHaveLength(1);
    const ok = validateFrontmatter(data({ created: "2024-02-29" }));
    expect(ok.frontmatter.created).toBe("2024-02-29");
    expect(issuesFor("created", { created: "2024-02-29" })).toEqual([]);
  });

  it("normalizes a valid js-yaml Date object with no issue", () => {
    const r = validateFrontmatter(data({ created: new Date("2026-03-01T00:00:00Z") }));
    expect(r.frontmatter.created).toBe("2026-03-01");
    expect(issuesFor("created", { created: new Date("2026-03-01T00:00:00Z") })).toEqual([]);
  });

  it("falls back to empty string for an Invalid Date object", () => {
    const r = validateFrontmatter(data({ created: new Date("nonsense") }));
    expect(r.frontmatter.created).toBe("");
  });

  it("applies the same flagging to the updated field", () => {
    const r = validateFrontmatter(data({ updated: "2026-7-9" }));
    expect(r.frontmatter.updated).toBe("2026-7-9");
    expect(issuesFor("updated", { updated: "2026-7-9" })).toHaveLength(1);
  });
});

// The tier field (#141): optional, opt-in per document. Unlike the required
// enums (domain/status/...), a missing tier must stay null — never coerced to
// a default — because null means "no enforcement" in the write-path guards.
describe("tier validation (optional enum, defaults to null)", () => {
  it("accepts each valid tier", () => {
    for (const tier of ["source", "compiled", "manual"]) {
      const r = validateFrontmatter(data({ tier }));
      expect(r.frontmatter.tier).toBe(tier);
      expect(r.report.issues.filter((i) => i.field === "tier")).toEqual([]);
    }
  });

  it("defaults a missing tier to null with no issue", () => {
    const r = validateFrontmatter(data({}));
    expect(r.frontmatter.tier).toBeNull();
    expect(r.report.issues.filter((i) => i.field === "tier")).toEqual([]);
  });

  it("treats an explicit null tier as unset with no issue", () => {
    const r = validateFrontmatter(data({ tier: null }));
    expect(r.frontmatter.tier).toBeNull();
    expect(r.report.issues.filter((i) => i.field === "tier")).toEqual([]);
  });

  it("flags an invalid tier value and falls back to null", () => {
    const r = validateFrontmatter(data({ tier: "raw" }));
    expect(r.frontmatter.tier).toBeNull();
    expect(issuesFor("tier", { tier: "raw" })).toHaveLength(1);
  });
});
