import { describe, expect, it } from "vitest";
import { parseDocument } from "../../src/frontmatter/parser.js";

const VALID = `---
title: "Test Document"
domain: accumulation
collection: competitive-intel
status: canonical
confidence: high
created: 2026-03-12
updated: 2026-05-14
updated_by: agent:claude-code
provenance: synthesized
sources:
  - source-one
  - source-two
superseded_by: null
ttl_days: 90
tags: [alpha, beta]
questions_answered:
  - "What does this document settle?"
questions_raised:
  - "What is still open?"
---

# Body heading

Body text.
`;

describe("parseDocument", () => {
  it("parses valid frontmatter and reports it valid", () => {
    const result = parseDocument(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.valid).toBe(true);
    expect(result.value.validation.issues).toEqual([]);
    expect(result.value.hasFrontmatter).toBe(true);
  });

  it("strips the frontmatter block from the body content", () => {
    const result = parseDocument(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toContain("# Body heading");
    expect(result.value.content).not.toContain("title:");
  });

  it("coerces YAML Date values into YYYY-MM-DD strings", () => {
    const result = parseDocument(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.created).toBe("2026-03-12");
    expect(result.value.frontmatter.updated).toBe("2026-05-14");
  });

  it("preserves typed fields", () => {
    const result = parseDocument(VALID);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const fm = result.value.frontmatter;
    expect(fm.title).toBe("Test Document");
    expect(fm.domain).toBe("accumulation");
    expect(fm.ttl_days).toBe(90);
    expect(fm.superseded_by).toBeNull();
    expect(fm.sources).toEqual(["source-one", "source-two"]);
    expect(fm.tags).toEqual(["alpha", "beta"]);
    expect(fm.questions_answered).toEqual(["What does this document settle?"]);
    expect(fm.questions_raised).toEqual(["What is still open?"]);
  });

  it("defaults the questions fields to [] when absent", () => {
    const noQuestions = VALID.replace(
      'questions_answered:\n  - "What does this document settle?"\n' +
        'questions_raised:\n  - "What is still open?"\n',
      "",
    );
    const result = parseDocument(noQuestions);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.valid).toBe(true);
    expect(result.value.frontmatter.questions_answered).toEqual([]);
    expect(result.value.frontmatter.questions_raised).toEqual([]);
  });

  it("flags an invalid enum value but still returns content", () => {
    const bad = VALID.replace("domain: accumulation", "domain: speculative");
    const result = parseDocument(bad);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.valid).toBe(false);
    const fields = result.value.validation.issues.map((i) => i.field);
    expect(fields).toContain("domain");
    // coerced to the fallback so downstream readers do not crash
    expect(result.value.frontmatter.domain).toBe("accumulation");
    expect(result.value.content).toContain("# Body heading");
  });

  it("flags missing required fields", () => {
    const result = parseDocument(`---
title: "Only a title"
---

Body.
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.valid).toBe(false);
    const fields = result.value.validation.issues.map((i) => i.field);
    expect(fields).toContain("domain");
    expect(fields).toContain("status");
    expect(fields).toContain("created");
  });

  it("returns hasFrontmatter false when there is no frontmatter block", () => {
    const result = parseDocument("# Just a heading\n\nNo metadata.\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hasFrontmatter).toBe(false);
    expect(result.value.validation.valid).toBe(false);
  });

  it("rejects a pathologically large source before parsing (size guard)", () => {
    // A multi-megabyte doc — reachable via `daftari import` — must not be fed
    // to gray-matter's synchronous parse (OOM / event-loop-block risk). The
    // guard returns an err Result rather than parsing.
    const huge = `---\ntitle: "x"\n---\n${"a".repeat(6 * 1024 * 1024)}`;
    const result = parseDocument(huge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("too large");
  });

  it("parses a document just under the size cap normally", () => {
    // A large-but-tolerable body (well under the cap) parses as usual — the
    // guard must not reject ordinary docs.
    const big = `${VALID}\n${"word ".repeat(50_000)}`;
    const result = parseDocument(big);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hasFrontmatter).toBe(true);
  });

  it("returns an error for malformed YAML frontmatter", () => {
    const result = parseDocument(`---
title: "unterminated
tags: [a, b
---

Body.
`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("malformed YAML");
  });
});

describe("parseDocument — describes field (#117)", () => {
  const withDescribes = (entries: string) => `---
title: "Doc"
domain: accumulation
collection: c
status: draft
confidence: low
created: 2026-06-10
updated: 2026-06-10
updated_by: agent:claude-code
provenance: direct
describes:
${entries}
---

Body.
`;

  it("reads a well-formed describes array as a typed string[]", () => {
    const result = parseDocument(
      withDescribes(
        "  - auth-service/src/login.ts\n  - auth-service/src/login.ts::validateCredentials",
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.valid).toBe(true);
    expect(result.value.frontmatter.describes).toEqual([
      "auth-service/src/login.ts",
      "auth-service/src/login.ts::validateCredentials",
    ]);
  });

  it("defaults describes to [] when absent", () => {
    const result = parseDocument(`---
title: "Doc"
domain: accumulation
collection: c
status: draft
confidence: low
created: 2026-06-10
updated: 2026-06-10
updated_by: agent:claude-code
provenance: direct
---

Body.
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.describes).toEqual([]);
  });

  it("flags a non-array describes value but still returns content", () => {
    const result = parseDocument(
      `---
title: "Doc"
domain: accumulation
collection: c
status: draft
confidence: low
created: 2026-06-10
updated: 2026-06-10
updated_by: agent:claude-code
provenance: direct
describes: "auth-service/src/login.ts"
---

Body.
`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.valid).toBe(false);
    expect(result.value.validation.issues.map((i) => i.field)).toContain("describes");
    expect(result.value.frontmatter.describes).toEqual([]);
  });

  it("flags a non-string element inside describes", () => {
    const result = parseDocument(withDescribes("  - auth-service/src/login.ts\n  - 42"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.valid).toBe(false);
    expect(result.value.validation.issues.map((i) => i.field)).toContain("describes");
    // the valid element is still retained
    expect(result.value.frontmatter.describes).toEqual(["auth-service/src/login.ts"]);
  });
});
