// `series` — names the run of dated snapshots a document belongs to (#645).
// Optional like said_at: absent reads as null, and a document without one
// serializes byte-for-byte as before. A non-string flags.

import { describe, expect, it } from "vitest";
import { parseDocument } from "../../src/frontmatter/parser.js";
import { validateFrontmatter } from "../../src/frontmatter/schema.js";
import { BUILTIN_FRONTMATTER_FIELDS } from "../../src/frontmatter/types.js";
import { serializeDocument } from "../../src/tools/write.js";

function data(over: Record<string, unknown>): Record<string, unknown> {
  return {
    title: "T",
    domain: "accumulation",
    collection: "notes",
    status: "draft",
    confidence: "low",
    created: "2026-03-01",
    updated: "2026-03-01",
    updated_by: "agent:test",
    provenance: "synthesized",
    ...over,
  };
}

describe("series frontmatter field", () => {
  it("is a registered builtin field", () => {
    expect(BUILTIN_FRONTMATTER_FIELDS).toContain("series");
  });

  it("defaults to null when absent", () => {
    const r = validateFrontmatter(data({}));
    expect(r.frontmatter.series).toBeNull();
    expect(r.report.valid).toBe(true);
  });

  it("passes a string through verbatim", () => {
    const r = validateFrontmatter(data({ series: "weekly-review" }));
    expect(r.frontmatter.series).toBe("weekly-review");
    expect(r.report.valid).toBe(true);
  });

  it("flags a non-string value", () => {
    const r = validateFrontmatter(data({ series: 7 }));
    expect(r.frontmatter.series).toBeNull();
    expect(r.report.issues.map((i) => i.field)).toContain("series");
  });

  it("round-trips through serializeDocument when set", () => {
    const { frontmatter } = validateFrontmatter(data({ series: "weekly-review" }));
    const parsed = parseDocument(serializeDocument(frontmatter, "Body.\n"));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.frontmatter.series).toBe("weekly-review");
  });

  it("is omitted from the serialized document when unset", () => {
    const { frontmatter } = validateFrontmatter(data({}));
    expect(serializeDocument(frontmatter, "Body.\n")).not.toContain("series");
  });
});
