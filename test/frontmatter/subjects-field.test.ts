import { describe, expect, it } from "vitest";
import { validateFrontmatter } from "../../src/frontmatter/schema.js";

// Complete valid base; tests override only the fields under test.
function data(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Claim doc",
    domain: "accumulation",
    collection: "notes",
    status: "canonical",
    confidence: "medium",
    created: "2026-08-12",
    updated: "2026-08-12",
    updated_by: "agent:test",
    provenance: "direct",
    ...over,
  };
}

// U16: subjects[] is a reserved built-in optional field for the deferred
// subject-keyed erasure subsystem. Default []; not populated by distill.
describe("subjects built-in field (U16)", () => {
  it("doc without subjects: validates cleanly and defaults to []", () => {
    const r = validateFrontmatter(data());
    expect(r.report.valid).toBe(true);
    expect(r.frontmatter.subjects).toEqual([]);
  });

  it("doc with subjects: ['person:alice'] validates and preserves the value", () => {
    const r = validateFrontmatter(data({ subjects: ["person:alice"] }));
    expect(r.report.valid).toBe(true);
    expect(r.frontmatter.subjects).toEqual(["person:alice"]);
  });

  it("doc with multiple subjects validates and preserves all entries", () => {
    const r = validateFrontmatter(data({ subjects: ["person:alice", "topic:x"] }));
    expect(r.report.valid).toBe(true);
    expect(r.frontmatter.subjects).toEqual(["person:alice", "topic:x"]);
  });

  // optionalStringArray: wrong type (non-array) flags an issue AND coerces to [].
  // This matches the behavior of tags/describes/questions_raised (same helper).
  it("subjects of wrong type (string) files an issue and coerces to []", () => {
    const r = validateFrontmatter(data({ subjects: "person:alice" }));
    const subjectIssues = r.report.issues.filter((i) => i.field === "subjects");
    expect(subjectIssues).toHaveLength(1);
    expect(subjectIssues[0].message).toMatch(/expected array/);
    // Coerced away — downstream never receives a non-array value.
    expect(r.frontmatter.subjects).toEqual([]);
  });

  it("subjects with a non-string element flags that element but keeps valid strings", () => {
    const r = validateFrontmatter(data({ subjects: ["person:alice", 42] }));
    const subjectIssues = r.report.issues.filter((i) => i.field === "subjects");
    expect(subjectIssues).toHaveLength(1);
    expect(subjectIssues[0].message).toMatch(/element 1 is not a string/);
    // Valid string element is retained; bad element is dropped.
    expect(r.frontmatter.subjects).toEqual(["person:alice"]);
  });
});
