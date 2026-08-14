// `valid_from` / `valid_until` parsing.
//
// The governing constraint is that these two fields are OPTIONAL and must
// never be able to make a document unwritable. `ValidationReport` has no
// severity tier — `report.valid === false` is a hard blocker in vault_write,
// vault_promote, vault_merge, consolidate/admit.ts, and curation/tier0.ts —
// so a malformed or inverted interval produces NO issue here. Both concerns
// belong to vault_lint, which is where the advisory contract lives.
//
// The only thing that still flags is a TYPE error (a number, an array, a
// mapping), matching optionalString/optionalNumber: a non-string value cannot
// be preserved verbatim anyway.

import { describe, expect, it } from "vitest";
import { parseDocument } from "../../src/frontmatter/parser.js";
import { validateFrontmatter } from "../../src/frontmatter/schema.js";
import type { Frontmatter } from "../../src/frontmatter/types.js";
import { serializeDocument } from "../../src/tools/write.js";

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

describe("validity field parsing", () => {
  it("defaults both fields to null when absent", () => {
    const r = validateFrontmatter(data({}));
    expect(r.frontmatter.valid_from).toBeNull();
    expect(r.frontmatter.valid_until).toBeNull();
    expect(r.report.valid).toBe(true);
  });

  it("passes a canonical YYYY-MM-DD through unchanged with no issue", () => {
    const r = validateFrontmatter(data({ valid_from: "2026-01-01", valid_until: "2026-03-31" }));
    expect(r.frontmatter.valid_from).toBe("2026-01-01");
    expect(r.frontmatter.valid_until).toBe("2026-03-31");
    expect(issuesFor("valid_from", { valid_from: "2026-01-01" })).toEqual([]);
  });

  it("treats an explicit null as absent", () => {
    const r = validateFrontmatter(data({ valid_from: null, valid_until: null }));
    expect(r.frontmatter.valid_from).toBeNull();
    expect(r.report.valid).toBe(true);
  });

  it("coerces a js-yaml Date to YYYY-MM-DD", () => {
    // An unquoted ISO date in YAML parses to a Date, exactly as requireDate handles.
    const r = validateFrontmatter(data({ valid_from: new Date("2026-01-01T00:00:00Z") }));
    expect(r.frontmatter.valid_from).toBe("2026-01-01");
    expect(issuesFor("valid_from", { valid_from: new Date("2026-01-01T00:00:00Z") })).toEqual([]);
  });
});

// If any of these start failing with report.valid === false, an optional field
// has become a write blocker across five subsystems (write.ts:943/:1176/:1678,
// consolidate/admit.ts, curation/tier0.ts). Design record, Decision 1 —
// deliberately divergent from the original proposal, which specified flagging.
describe("validity never blocks a write", () => {
  it("preserves a malformed date string verbatim and reports no issue", () => {
    const r = validateFrontmatter(data({ valid_from: "January 2026" }));
    expect(r.frontmatter.valid_from).toBe("January 2026");
    expect(issuesFor("valid_from", { valid_from: "January 2026" })).toEqual([]);
    expect(r.report.valid).toBe(true);
  });

  it("preserves an out-of-range date verbatim and reports no issue", () => {
    const r = validateFrontmatter(data({ valid_until: "2026-13-45" }));
    expect(r.frontmatter.valid_until).toBe("2026-13-45");
    expect(r.report.valid).toBe(true);
  });

  it("does not flag an inverted interval — that is a lint finding, not a schema issue", () => {
    const r = validateFrontmatter(data({ valid_from: "2026-06-01", valid_until: "2026-01-01" }));
    expect(r.frontmatter.valid_from).toBe("2026-06-01");
    expect(r.frontmatter.valid_until).toBe("2026-01-01");
    expect(r.report.valid).toBe(true);
    expect(r.report.issues).toEqual([]);
  });
});

describe("validity type errors", () => {
  it("flags a non-string, non-Date value", () => {
    const issues = issuesFor("valid_from", { valid_from: 2026 });
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/expected date string or null/);
  });

  it("flags an array", () => {
    expect(issuesFor("valid_until", { valid_until: ["2026-01-01"] })).toHaveLength(1);
  });
});

describe("validity round-trips through serializeDocument", () => {
  function fm(over: Partial<Frontmatter> = {}): Frontmatter {
    return {
      title: "Plan Pro pricing",
      domain: "accumulation",
      collection: "pricing",
      status: "canonical",
      confidence: "high",
      created: "2026-01-01",
      updated: "2026-01-01",
      updated_by: "agent:test",
      provenance: "direct",
      tier: null,
      sources: [],
      superseded_by: null,
      ttl_days: null,
      valid_from: null,
      valid_until: null,
      tags: [],
      describes: [],
      questions_answered: [],
      questions_raised: [],
      subjects: [],
      ...over,
    };
  }

  it("writes both fields and reads them back identically", () => {
    const text = serializeDocument(fm({ valid_from: "2026-01-01", valid_until: "2026-03-31" }), "");
    const parsed = parseDocument(text);
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.frontmatter.valid_from).toBe("2026-01-01");
    expect(parsed.value.frontmatter.valid_until).toBe("2026-03-31");
  });

  it("writes explicit nulls rather than omitting the keys", () => {
    const text = serializeDocument(fm(), "");
    expect(text).toMatch(/^valid_from: null$/m);
    expect(text).toMatch(/^valid_until: null$/m);
  });

  it("preserves a malformed authored value through a write (#113)", () => {
    const text = serializeDocument(fm({ valid_from: "January 2026" }), "");
    const parsed = parseDocument(text);
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.frontmatter.valid_from).toBe("January 2026");
  });
});
