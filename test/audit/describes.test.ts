// test/audit/describes.test.ts
import { describe, expect, it } from "vitest";
import { classifyDescribesEdges, parseDescribesEntry } from "../../src/audit/describes.js";
import type { DocSnapshot, RepoSnapshot } from "../../src/audit/types.js";

function doc(relPath: string, describes: string[]): DocSnapshot {
  return {
    relPath,
    absPath: `/x/${relPath}`,
    mtime: "2026-01-01T00:00:00.000Z",
    mtimeSource: "git",
    headings: new Set(),
    links: [],
    describes,
  };
}

function repo(name: string, type: "docs" | "code", docs: DocSnapshot[]): RepoSnapshot {
  return {
    config: { name, path: `/${name}`, docsGlob: "**/*", urls: [], type },
    docs: new Map(docs.map((d) => [d.relPath, d])),
  };
}

describe("parseDescribesEntry", () => {
  it("parses repo:path into repo + path with no symbol", () => {
    expect(parseDescribesEntry("svc:src/login.ts", "docs")).toEqual({
      repo: "svc",
      path: "src/login.ts",
      symbol: null,
    });
  });

  it("parses repo:path::symbol, retaining the symbol", () => {
    expect(parseDescribesEntry("svc:src/login.ts::validateCredentials", "docs")).toEqual({
      repo: "svc",
      path: "src/login.ts",
      symbol: "validateCredentials",
    });
  });

  it("resolves a bare path against the source repo", () => {
    expect(parseDescribesEntry("src/login.ts", "self")).toEqual({
      repo: "self",
      path: "src/login.ts",
      symbol: null,
    });
  });

  it("resolves a bare path with a symbol against the source repo", () => {
    expect(parseDescribesEntry("src/login.ts::login", "self")).toEqual({
      repo: "self",
      path: "src/login.ts",
      symbol: "login",
    });
  });

  // --- pin suffix (JIT anchor grammar, U1) ---------------------------------

  it("parses a range pin #L<start>-<end>@<sha>", () => {
    expect(parseDescribesEntry("api:src/retry.ts#L40-58@9f3c2ab", "docs")).toEqual({
      repo: "api",
      path: "src/retry.ts",
      symbol: null,
      pin: { start: 40, end: 58, sha: "9f3c2ab" },
    });
  });

  it("parses a whole-file pin @<sha> (null range)", () => {
    expect(parseDescribesEntry("api:src/retry.ts@9f3c2ab", "docs")).toEqual({
      repo: "api",
      path: "src/retry.ts",
      symbol: null,
      pin: { start: null, end: null, sha: "9f3c2ab" },
    });
  });

  it("treats a bare #L<n> pin as the single line n (end defaults to start)", () => {
    expect(parseDescribesEntry("api:src/retry.ts#L40@9f3c2ab", "docs")).toEqual({
      repo: "api",
      path: "src/retry.ts",
      symbol: null,
      pin: { start: 40, end: 40, sha: "9f3c2ab" },
    });
  });

  it("carries a symbol alongside a pin", () => {
    expect(parseDescribesEntry("api:src/retry.ts::withRetry#L40-58@9f3c2ab", "docs")).toEqual({
      repo: "api",
      path: "src/retry.ts",
      symbol: "withRetry",
      pin: { start: 40, end: 58, sha: "9f3c2ab" },
    });
  });

  it("leaves a bare binding untouched — no pin field", () => {
    expect(parseDescribesEntry("api:src/retry.ts", "docs")).toEqual({
      repo: "api",
      path: "src/retry.ts",
      symbol: null,
    });
  });

  it("does not treat a non-hex @ tail as a pin (indistinguishable from a path)", () => {
    // 'notasha' is not 7-40 lowercase hex → the suffix is part of the path,
    // parsed byte-identically to a bare binding, and NOT flagged malformed.
    expect(parseDescribesEntry("api:src/build@notasha.ts", "docs")).toEqual({
      repo: "api",
      path: "src/build@notasha.ts",
      symbol: null,
    });
  });

  it("flags end<start as a malformed pin and degrades to a bare binding", () => {
    // Structurally a valid pin, semantically invalid (58..40). The pin is
    // dropped, the binding degrades to bare, and malformedPin is set for the
    // lint check (U6) — never a throw, never a rejected entry.
    expect(parseDescribesEntry("api:src/retry.ts#L58-40@9f3c2ab", "docs")).toEqual({
      repo: "api",
      path: "src/retry.ts",
      symbol: null,
      malformedPin: true,
    });
  });
});

describe("classifyDescribesEdges", () => {
  it("emits one edge per describes entry, resolving the target repo", () => {
    const snaps = [
      repo("docs", "docs", [doc("a.md", ["svc:src/login.ts", "guide.md"])]),
      repo("svc", "code", [doc("src/login.ts", [])]),
    ];
    const edges = classifyDescribesEdges(snaps);
    expect(edges).toEqual([
      {
        sourceRepo: "docs",
        sourcePath: "a.md",
        targetRepo: "svc",
        targetPath: "src/login.ts",
        symbol: null,
        raw: "svc:src/login.ts",
      },
      {
        sourceRepo: "docs",
        sourcePath: "a.md",
        targetRepo: "docs",
        targetPath: "guide.md",
        symbol: null,
        raw: "guide.md",
      },
    ]);
  });

  it("ignores code repos as edge sources", () => {
    // Code-repo stubs never carry describes, but guard against it anyway.
    const snaps = [repo("svc", "code", [doc("src/x.ts", ["other:y.ts"])])];
    expect(classifyDescribesEdges(snaps)).toEqual([]);
  });

  it("returns no edges when no doc declares describes", () => {
    const snaps = [repo("docs", "docs", [doc("a.md", [])])];
    expect(classifyDescribesEdges(snaps)).toEqual([]);
  });

  it("skips blank / whitespace-only describes entries", () => {
    const snaps = [repo("docs", "docs", [doc("a.md", ["", "   ", "svc:x.ts"])])];
    const edges = classifyDescribesEdges(snaps);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.targetPath).toBe("x.ts");
  });
});
