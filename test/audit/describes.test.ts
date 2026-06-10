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
