// test/audit/describes_refs.test.ts
import { describe, expect, it } from "vitest";
import { checkDescribesRefs } from "../../src/audit/checks/describes_refs.js";
import type { DescribesEdge, DocSnapshot, RepoSnapshot } from "../../src/audit/types.js";

function fileStub(relPath: string): DocSnapshot {
  return {
    relPath,
    absPath: `/x/${relPath}`,
    mtime: "1970-01-01T00:00:00.000Z",
    mtimeSource: "fs",
    headings: new Set(),
    links: [],
    describes: [],
  };
}

function codeRepo(name: string, paths: string[]): RepoSnapshot {
  return {
    config: { name, path: `/${name}`, docsGlob: "**/*", urls: [], type: "code" },
    docs: new Map(paths.map((p) => [p, fileStub(p)])),
  };
}

const edge = (over: Partial<DescribesEdge>): DescribesEdge => ({
  sourceRepo: "docs",
  sourcePath: "a.md",
  targetRepo: "svc",
  targetPath: "src/login.ts",
  symbol: null,
  raw: "svc:src/login.ts",
  ...over,
});

describe("checkDescribesRefs", () => {
  it("produces no finding when the described file exists", () => {
    const snaps = [codeRepo("svc", ["src/login.ts"])];
    expect(checkDescribesRefs(snaps, [edge({})])).toEqual([]);
  });

  it("flags a describes edge whose target file is missing", () => {
    const snaps = [codeRepo("svc", ["src/other.ts"])];
    const findings = checkDescribesRefs(snaps, [edge({})]);
    expect(findings).toEqual([
      {
        source: { repo: "docs", path: "a.md" },
        target: { repo: "svc", path: "src/login.ts", symbol: null },
        raw: "svc:src/login.ts",
      },
    ]);
  });

  it("flags a describes edge into an unknown repo", () => {
    const snaps = [codeRepo("svc", ["src/login.ts"])];
    const findings = checkDescribesRefs(snaps, [edge({ targetRepo: "ghost" })]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.target.repo).toBe("ghost");
  });

  it("ignores the symbol for file-level existence but carries it in the finding", () => {
    const snaps = [codeRepo("svc", ["src/login.ts"])];
    // Existing file, symbol present → still no finding (file-level resolution).
    expect(
      checkDescribesRefs(snaps, [
        edge({ symbol: "validateCredentials", raw: "svc:src/login.ts::validateCredentials" }),
      ]),
    ).toEqual([]);
    // Missing file, symbol present → finding carries the symbol.
    const missing = checkDescribesRefs(codeRepo("svc", []) ? [codeRepo("svc", [])] : [], [
      edge({ symbol: "gone", raw: "svc:src/login.ts::gone" }),
    ]);
    expect(missing[0]?.target.symbol).toBe("gone");
  });
});
