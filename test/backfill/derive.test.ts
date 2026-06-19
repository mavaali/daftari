import { describe, expect, it } from "vitest";
import {
  classifyDoc,
  deriveProposed,
  firstH1,
  mapIdentity,
  parseQuestionSection,
  slugify,
  titleFromFilename,
} from "../../src/backfill/derive.js";

describe("slugify", () => {
  it("kebab-cases names", () => {
    expect(slugify("Mihir Wagle")).toBe("mihir-wagle");
    expect(slugify("Data  Movement")).toBe("data-movement");
    expect(slugify("  Trim_me! ")).toBe("trim-me");
  });
});

describe("firstH1", () => {
  it("returns the first single-hash heading", () => {
    expect(firstH1("# Title\n\n## Sub\n")).toBe("Title");
  });
  it("ignores deeper headings and returns null when absent", () => {
    expect(firstH1("## Not a title\n\nbody")).toBeNull();
    expect(firstH1("no headings here")).toBeNull();
  });
});

describe("titleFromFilename", () => {
  it("strips .md, splits on -/_ and title-cases", () => {
    expect(titleFromFilename("specs/data-movement/foo-bar.md")).toBe("Foo Bar");
    expect(titleFromFilename("notes/quick_note.md")).toBe("Quick Note");
    expect(titleFromFilename("bar.md")).toBe("Bar");
  });
});

describe("parseQuestionSection", () => {
  const body = `# Doc

## Questions Answered
- How does it work?
- What does it cost?

## Questions Raised
- Does it scale?
- (none yet — placeholder)

## Other
- not a question
`;
  it("extracts bullets under the matching heading only", () => {
    expect(parseQuestionSection(body, "Questions Answered")).toEqual([
      "How does it work?",
      "What does it cost?",
    ]);
  });
  it("stops at the next heading and drops parenthetical placeholders", () => {
    expect(parseQuestionSection(body, "Questions Raised")).toEqual(["Does it scale?"]);
  });
  it("returns empty when the section is absent", () => {
    expect(parseQuestionSection(body, "Nonexistent")).toEqual([]);
  });
});

describe("mapIdentity", () => {
  const map = { "Mihir Wagle": "human:mihir", "github-actions[bot]": "agent:github-actions" };
  it("uses an explicit mapping when present", () => {
    expect(mapIdentity("Mihir Wagle", map)).toBe("human:mihir");
    expect(mapIdentity("github-actions[bot]", map)).toBe("agent:github-actions");
  });
  it("falls back to a slugified human: default", () => {
    expect(mapIdentity("Priya Patel", map)).toBe("human:priya-patel");
    expect(mapIdentity("Priya Patel", {})).toBe("human:priya-patel");
  });
});

describe("classifyDoc", () => {
  it("flags an empty frontmatter as missing", () => {
    expect(classifyDoc({})).toBe("missing");
  });
  it("flags an incomplete frontmatter as partial", () => {
    expect(classifyDoc({ title: "x" })).toBe("partial");
  });
  it("flags a complete frontmatter as conformant", () => {
    const full = {
      title: "x",
      domain: "accumulation",
      collection: "c",
      status: "canonical",
      confidence: "high",
      created: "2025-01-01",
      updated: "2025-01-01",
      updated_by: "human:mihir",
      provenance: "direct",
    };
    expect(classifyDoc(full)).toBe("conformant");
  });
});

describe("deriveProposed", () => {
  it("derives a full frontmatter from git + body + path defaults", () => {
    const { proposed, derivation } = deriveProposed({
      relPath: "specs/data-movement/foo.md",
      body: "# Foo Title\n\n## Questions Answered\n- Q1?\n",
      raw: {},
      git: { created: "2025-04-12", updated: "2025-05-01", author: "Mihir Wagle" },
      mtimeDate: "2026-06-07",
      identityMap: { "Mihir Wagle": "human:mihir" },
      invoker: "human:tester",
    });

    expect(proposed.title).toBe("Foo Title");
    expect(proposed.collection).toBe("specs");
    expect(proposed.status).toBe("canonical");
    expect(proposed.confidence).toBe("medium");
    expect(proposed.provenance).toBe("direct");
    expect(proposed.domain).toBe("accumulation");
    expect(proposed.created).toBe("2025-04-12");
    expect(proposed.updated).toBe("2025-05-01");
    expect(proposed.updated_by).toBe("human:mihir");
    expect(proposed.questions_answered).toEqual(["Q1?"]);
    expect(proposed.sources).toEqual([]);
    expect(proposed.ttl_days).toBeNull();
    expect(proposed.superseded_by).toBeNull();

    expect(derivation.created).toBe("git-first-commit");
    expect(derivation.updated).toBe("git-last-commit");
    expect(derivation.updated_by).toBe("git-author + identity-map");
    expect(derivation.collection).toBe("parent-folder");
    expect(derivation.status).toBe("default");
    expect(derivation.title).toBe("body-h1");
  });

  it("derives the title from the filename when there is no H1", () => {
    const { proposed, derivation } = deriveProposed({
      relPath: "specs/data-movement/bar.md",
      body: "no heading here",
      raw: {},
      git: { created: "2025-03-02", updated: "2025-03-02", author: "Priya Patel" },
      mtimeDate: "2026-06-07",
      identityMap: {},
      invoker: "human:tester",
    });
    expect(proposed.title).toBe("Bar");
    expect(derivation.title).toBe("filename");
    expect(proposed.updated_by).toBe("human:priya-patel");
  });

  it("falls back to file mtime and invoker when git has no history", () => {
    const { proposed, derivation } = deriveProposed({
      relPath: "notes/x.md",
      body: "# X",
      raw: {},
      git: { created: null, updated: null, author: null },
      mtimeDate: "2026-06-07",
      identityMap: {},
      invoker: "human:tester",
    });
    expect(proposed.created).toBe("2026-06-07");
    expect(proposed.updated).toBe("2026-06-07");
    expect(proposed.updated_by).toBe("human:tester");
    expect(derivation.created).toBe("file-mtime");
    expect(derivation.updated_by).toBe("invoker-fallback");
  });

  it("preserves present fields and fills only the missing ones", () => {
    const raw = { title: "Existing Baz Title", created: "2024-12-01" };
    const { proposed, derivation } = deriveProposed({
      relPath: "specs/pricing/baz.md",
      body: "# Baz body heading\n\nbody",
      raw,
      git: { created: "2025-02-10", updated: "2025-02-10", author: "Mihir Wagle" },
      mtimeDate: "2026-06-07",
      identityMap: { "Mihir Wagle": "human:mihir" },
      invoker: "human:tester",
    });

    // Present fields preserved verbatim, not overwritten by git/body.
    expect(proposed.title).toBe("Existing Baz Title");
    expect(proposed.created).toBe("2024-12-01");
    expect(derivation.title).toBe("preserved");
    expect(derivation.created).toBe("preserved");

    // Missing fields filled.
    expect(proposed.updated).toBe("2025-02-10");
    expect(proposed.collection).toBe("specs");
    expect(proposed.status).toBe("canonical");
    expect(derivation.updated).toBe("git-last-commit");
  });

  it("preserves an out-of-enum built-in value as raw and labels it a collision", () => {
    const raw = { status: "ACTIVE", confidence: "EXPLICIT", domain: "Architecture" };
    const { proposed, derivation } = deriveProposed({
      relPath: "decisions/dec-004.md",
      body: "# DEC-004",
      raw,
      git: { created: "2026-04-11", updated: "2026-04-11", author: "Mihir Wagle" },
      mtimeDate: "2026-06-09",
      identityMap: {},
      invoker: "human:tester",
    });
    expect(proposed.status).toBe("ACTIVE");
    expect(proposed.confidence).toBe("EXPLICIT");
    expect(proposed.domain).toBe("Architecture");
    expect(derivation.status).toBe("collision");
    expect(derivation.confidence).toBe("collision");
    expect(derivation.domain).toBe("collision");
  });

  it("normalizes a present YAML Date to a YYYY-MM-DD string", () => {
    const { proposed } = deriveProposed({
      relPath: "specs/x.md",
      body: "# X",
      raw: { created: new Date("2024-12-01T00:00:00Z") },
      git: { created: null, updated: null, author: null },
      mtimeDate: "2026-06-09",
      identityMap: {},
      invoker: "human:tester",
    });
    expect(proposed.created).toBe("2024-12-01");
  });

  it("does not let an invalid Date escape as an object", () => {
    const { proposed } = deriveProposed({
      relPath: "specs/x.md",
      body: "# X",
      raw: { created: new Date("not-a-date") },
      git: { created: null, updated: null, author: null },
      mtimeDate: "2026-06-09",
      identityMap: {},
      invoker: "human:tester",
    });
    expect(proposed.created).not.toBeInstanceOf(Date);
    expect(typeof proposed.created).toBe("string");
  });

  it("preserves a present malformed non-enum built-in as raw, not a coerced default (§4.4)", () => {
    const { proposed } = deriveProposed({
      relPath: "specs/x.md",
      body: "# X",
      raw: { tags: "foo" },
      git: { created: null, updated: null, author: null },
      mtimeDate: "2026-06-09",
      identityMap: {},
      invoker: "human:tester",
    });
    expect(proposed.tags).toBe("foo" as unknown as string[]);
  });
});

describe("deriveProposed — obsidian mode", () => {
  const base = {
    relPath: "notes/x.md",
    git: { created: null, updated: null, author: null },
    mtimeDate: "2026-06-19",
    identityMap: {},
    invoker: "human:tester",
  };

  it("unions inline #tags with frontmatter tags", () => {
    const { proposed, derivation } = deriveProposed({
      ...base,
      body: "body with #frombody and #shared",
      raw: { tags: ["fromfm", "shared"] },
      obsidian: true,
    });
    expect(proposed.tags).toEqual(["fromfm", "shared", "frombody"]);
    expect(derivation.tags).toBe("preserved");
  });

  it("harvests inline tags when frontmatter has none", () => {
    const { proposed, derivation } = deriveProposed({
      ...base,
      body: "see #alpha and #beta",
      raw: {},
      obsidian: true,
    });
    expect(proposed.tags).toEqual(["alpha", "beta"]);
    expect(derivation.tags).toBe("inline-tags");
  });

  it("maps Web Clipper source into sources[]", () => {
    const { proposed, derivation } = deriveProposed({
      ...base,
      body: "clip body",
      raw: { source: "https://example.com/post" },
      obsidian: true,
    });
    expect(proposed.sources).toEqual(["https://example.com/post"]);
    expect(derivation.sources).toBe("web-clipper-source");
  });

  it("is identical to default mode when obsidian is unset (no inline scan)", () => {
    const off = deriveProposed({ ...base, body: "#alpha", raw: {} });
    expect(off.proposed.tags).toEqual([]);
    expect(off.derivation.tags).toBe("empty");
  });
});
