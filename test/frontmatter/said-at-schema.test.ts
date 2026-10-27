// `said_at` — when the source message a distilled claim came from was said.
//
// A fact about the SOURCE, not world-validity: it never feeds valid_from
// (PR #305: valid time is authored, never inferred). Optional like
// valid_from/valid_until — a malformed string is preserved and never blocks a
// write; only a type error flags.

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

describe("said_at frontmatter field", () => {
  it("is a registered builtin field", () => {
    expect(BUILTIN_FRONTMATTER_FIELDS).toContain("said_at");
  });

  it("defaults to null when absent", () => {
    const r = validateFrontmatter(data({}));
    expect(r.frontmatter.said_at).toBeNull();
    expect(r.report.valid).toBe(true);
  });

  it("passes an ISO datetime and an ISO date through verbatim", () => {
    expect(validateFrontmatter(data({ said_at: "2026-05-01T10:02:00" })).frontmatter.said_at).toBe(
      "2026-05-01T10:02:00",
    );
    expect(validateFrontmatter(data({ said_at: "2026-05-01" })).frontmatter.said_at).toBe(
      "2026-05-01",
    );
  });

  it("preserves a malformed string and never blocks a write", () => {
    const r = validateFrontmatter(data({ said_at: "last Tuesday" }));
    expect(r.frontmatter.said_at).toBe("last Tuesday");
    expect(r.report.valid).toBe(true);
  });

  it("flags a non-string, non-date value", () => {
    const r = validateFrontmatter(data({ said_at: 42 }));
    expect(r.frontmatter.said_at).toBeNull();
    expect(r.report.issues.map((i) => i.field)).toContain("said_at");
  });

  it("coerces a js-yaml Date: date-only at UTC midnight, else an ISO datetime", () => {
    expect(
      validateFrontmatter(data({ said_at: new Date("2026-05-01T00:00:00Z") })).frontmatter.said_at,
    ).toBe("2026-05-01");
    expect(
      validateFrontmatter(data({ said_at: new Date("2026-05-01T10:02:00Z") })).frontmatter.said_at,
    ).toBe("2026-05-01T10:02:00Z");
  });

  it("serializes when set and round-trips as the same string", () => {
    const { frontmatter } = validateFrontmatter(data({ said_at: "2026-05-01T10:02:00" }));
    const text = serializeDocument(frontmatter, "Body.\n");
    const parsed = parseDocument(text);
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.frontmatter.said_at).toBe("2026-05-01T10:02:00");
    expect(parsed.value.frontmatter.valid_from).toBeNull();
  });

  it("is not emitted when null, so existing documents stay byte-stable", () => {
    const { frontmatter } = validateFrontmatter(data({}));
    expect(serializeDocument(frontmatter, "Body.\n")).not.toContain("said_at");
  });
});
