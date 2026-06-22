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

describe("requireDate normalization", () => {
  it("passes a canonical YYYY-MM-DD through unchanged with no issue", () => {
    const r = validateFrontmatter(data({ created: "2026-03-01" }));
    expect(r.frontmatter.created).toBe("2026-03-01");
    expect(r.report.issues.filter((i) => i.field === "created")).toEqual([]);
  });

  it("normalizes a non-padded date and flags it as non-canonical", () => {
    const r = validateFrontmatter(data({ created: "2026-3-1" }));
    expect(r.frontmatter.created).toBe("2026-03-01");
    const flagged = r.report.issues.filter((i) => i.field === "created");
    expect(flagged).toHaveLength(1);
    expect(flagged[0].message).toMatch(/non-canonical/);
  });

  it("stores empty string and flags a slash-separated date", () => {
    const r = validateFrontmatter(data({ created: "2026/03/01" }));
    expect(r.frontmatter.created).toBe("");
    expect(issuesFor("created", { created: "2026/03/01" })).toHaveLength(1);
  });

  it("stores empty string and flags a textual date", () => {
    const r = validateFrontmatter(data({ created: "March 2026" }));
    expect(r.frontmatter.created).toBe("");
    expect(issuesFor("created", { created: "March 2026" })).toHaveLength(1);
  });

  it("stores empty string and flags an out-of-range date (regression: was unflagged)", () => {
    const r = validateFrontmatter(data({ created: "2026-13-45" }));
    expect(r.frontmatter.created).toBe("");
    expect(issuesFor("created", { created: "2026-13-45" })).toHaveLength(1);
  });

  it("stores empty string for a rollover date (2026-02-30, not a real day)", () => {
    const r = validateFrontmatter(data({ created: "2026-02-30" }));
    expect(r.frontmatter.created).toBe("");
    expect(issuesFor("created", { created: "2026-02-30" })).toHaveLength(1);
  });

  it("stores empty string for a non-leap-year Feb 29 (2026-02-29)", () => {
    const r = validateFrontmatter(data({ created: "2026-02-29" }));
    expect(r.frontmatter.created).toBe("");
  });

  it("keeps a valid leap-year date (2024-02-29)", () => {
    const r = validateFrontmatter(data({ created: "2024-02-29" }));
    expect(r.frontmatter.created).toBe("2024-02-29");
    expect(issuesFor("created", { created: "2024-02-29" })).toEqual([]);
  });

  it("normalizes a valid js-yaml Date object with no issue", () => {
    const r = validateFrontmatter(data({ created: new Date("2026-03-01T00:00:00Z") }));
    expect(r.frontmatter.created).toBe("2026-03-01");
    expect(issuesFor("created", { created: new Date("2026-03-01T00:00:00Z") })).toEqual([]);
  });

  it("stores empty string for an Invalid Date object", () => {
    const r = validateFrontmatter(data({ created: new Date("nonsense") }));
    expect(r.frontmatter.created).toBe("");
  });

  it("applies the same normalization to the updated field", () => {
    const r = validateFrontmatter(data({ updated: "2026-7-9" }));
    expect(r.frontmatter.updated).toBe("2026-07-09");
    expect(issuesFor("updated", { updated: "2026-7-9" })).toHaveLength(1);
  });
});
