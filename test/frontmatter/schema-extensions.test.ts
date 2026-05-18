import { describe, expect, it } from "vitest";
import { validateFrontmatter } from "../../src/frontmatter/schema.js";
import type { SchemaExtension } from "../../src/utils/config.js";

// A complete, valid built-in frontmatter block. Extension fields are layered
// on top per-test so an extension issue is never masked by a built-in one.
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "ADR — Adopt SQLite",
    domain: "accumulation",
    collection: "decisions",
    status: "draft",
    confidence: "medium",
    created: "2026-05-01",
    updated: "2026-05-01",
    updated_by: "agent:claude-code",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: [],
    ...overrides,
  };
}

const ext = (over: Partial<SchemaExtension> & Pick<SchemaExtension, "field" | "type">) => ({
  required: false,
  ...over,
});

// Issues raised only for extension fields (built-in fields are valid in base()).
function extIssues(data: Record<string, unknown>, extensions: SchemaExtension[]) {
  return validateFrontmatter(data, extensions).report.issues;
}

describe("validateFrontmatter — schema extensions", () => {
  it("behaves identically to before when no extensions are supplied", () => {
    const { report } = validateFrontmatter(base());
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("accepts a valid value for every extension type", () => {
    const extensions: SchemaExtension[] = [
      ext({ field: "adr_id", type: "string" }),
      ext({ field: "decision_date", type: "date" }),
      ext({ field: "review_count", type: "number" }),
      ext({ field: "is_ratified", type: "boolean" }),
      ext({ field: "stakeholders", type: "array", items: "string" }),
      ext({ field: "severity", type: "enum", enum: ["low", "high"] }),
    ];
    const data = base({
      adr_id: "ADR-001",
      decision_date: "2026-04-10",
      review_count: 3,
      is_ratified: true,
      stakeholders: ["platform", "data"],
      severity: "high",
    });
    expect(extIssues(data, extensions)).toEqual([]);
  });

  describe("type mismatches raise an issue on the right field", () => {
    it("string given a number", () => {
      const issues = extIssues(base({ adr_id: 7 }), [ext({ field: "adr_id", type: "string" })]);
      expect(issues).toEqual([{ field: "adr_id", message: "expected string, got number" }]);
    });

    it("number given a string", () => {
      const issues = extIssues(base({ weight: "heavy" }), [
        ext({ field: "weight", type: "number" }),
      ]);
      expect(issues).toEqual([{ field: "weight", message: "expected number, got string" }]);
    });

    it("boolean given a string", () => {
      const issues = extIssues(base({ done: "true" }), [ext({ field: "done", type: "boolean" })]);
      expect(issues).toEqual([{ field: "done", message: "expected boolean, got string" }]);
    });

    it("date given a non-date string", () => {
      const issues = extIssues(base({ when: "last tuesday" }), [
        ext({ field: "when", type: "date" }),
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.field).toBe("when");
      expect(issues[0]?.message).toContain("YYYY-MM-DD");
    });

    it("date accepts a js-yaml Date object", () => {
      const issues = extIssues(base({ when: new Date("2026-04-10T00:00:00Z") }), [
        ext({ field: "when", type: "date" }),
      ]);
      expect(issues).toEqual([]);
    });

    it("array given a non-array", () => {
      const issues = extIssues(base({ owners: "platform" }), [
        ext({ field: "owners", type: "array", items: "string" }),
      ]);
      expect(issues).toEqual([{ field: "owners", message: "expected an array of strings" }]);
    });

    it("array given non-string elements", () => {
      const issues = extIssues(base({ owners: ["platform", 5] }), [
        ext({ field: "owners", type: "array", items: "string" }),
      ]);
      expect(issues).toEqual([{ field: "owners", message: "expected an array of strings" }]);
    });
  });

  describe("enum", () => {
    it("raises an issue for a value outside the declared set", () => {
      const issues = extIssues(base({ severity: "catastrophic" }), [
        ext({ field: "severity", type: "enum", enum: ["low", "high"] }),
      ]);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.field).toBe("severity");
      expect(issues[0]?.message).toContain("expected one of [low, high]");
    });

    it("accepts a value inside the declared set", () => {
      const issues = extIssues(base({ severity: "low" }), [
        ext({ field: "severity", type: "enum", enum: ["low", "high"] }),
      ]);
      expect(issues).toEqual([]);
    });
  });

  describe("pattern", () => {
    const adr = ext({ field: "adr_id", type: "string", pattern: "^ADR-[0-9]+$" });

    it("raises an issue when the value does not match", () => {
      const issues = extIssues(base({ adr_id: "DEC-1" }), [adr]);
      expect(issues).toEqual([
        { field: "adr_id", message: "does not match pattern /^ADR-[0-9]+$/" },
      ]);
    });

    it("accepts a value that matches", () => {
      expect(extIssues(base({ adr_id: "ADR-042" }), [adr])).toEqual([]);
    });
  });

  describe("required and default", () => {
    it("raises a missing-required issue when a required field is absent", () => {
      const issues = extIssues(base(), [ext({ field: "adr_id", type: "string", required: true })]);
      expect(issues).toEqual([{ field: "adr_id", message: "missing required field" }]);
    });

    it("does not raise an issue for a missing optional field", () => {
      expect(extIssues(base(), [ext({ field: "adr_id", type: "string" })])).toEqual([]);
    });

    it("does not raise an issue when a required field is missing but has a default", () => {
      const issues = extIssues(base(), [
        ext({ field: "status_tag", type: "string", required: true, default: "proposed" }),
      ]);
      expect(issues).toEqual([]);
    });
  });

  it("reports built-in and extension issues together", () => {
    const data = base({ title: "", adr_id: 9 });
    const { report } = validateFrontmatter(data, [ext({ field: "adr_id", type: "string" })]);
    expect(report.valid).toBe(false);
    expect(report.issues.map((i) => i.field).sort()).toEqual(["adr_id", "title"]);
  });
});
