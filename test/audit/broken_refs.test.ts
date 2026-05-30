// test/audit/broken_refs.test.ts
import { describe, expect, it } from "vitest";
import { checkBrokenRefs } from "../../src/audit/checks/broken_refs.js";
import type { BrokenRefFinding, LinkEdge, RepoSnapshot } from "../../src/audit/types.js";

// Helper: build a minimal RepoSnapshot with named docs and optional headings.
function makeSnapshot(
  name: string,
  docs: Array<{ relPath: string; headings?: string[] }>,
): RepoSnapshot {
  const docsMap = new Map(
    docs.map(({ relPath, headings = [] }) => [
      relPath,
      {
        relPath,
        absPath: `/${name}/${relPath}`,
        mtime: "2026-01-01T00:00:00.000Z",
        mtimeSource: "git" as const,
        headings: new Set(headings),
        links: [],
      },
    ]),
  );
  return {
    config: { name, path: `/${name}`, docsGlob: "**/*.md", urls: [] },
    docs: docsMap,
  };
}

function edge(
  sourceRepo: string,
  sourcePath: string,
  targetRepo: string,
  targetPath: string,
  targetAnchor: string | null = null,
  rawHref = `${targetPath}${targetAnchor ? `#${targetAnchor}` : ""}`,
): LinkEdge {
  return { sourceRepo, sourcePath, targetRepo, targetPath, targetAnchor, rawHref };
}

describe("checkBrokenRefs", () => {
  it("returns empty array when all targets exist and anchors match", () => {
    const snapshots = [makeSnapshot("a", [{ relPath: "docs/api.md", headings: ["usage"] }])];
    const edges = [edge("a", "index.md", "a", "docs/api.md", "usage")];
    expect(checkBrokenRefs(snapshots, edges)).toEqual([]);
  });

  it("reports missing_file when target path is absent from snapshot", () => {
    const snapshots = [makeSnapshot("a", [])]; // empty vault
    const edges = [edge("a", "index.md", "a", "docs/missing.md")];
    const findings = checkBrokenRefs(snapshots, edges);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject<Partial<BrokenRefFinding>>({
      kind: "missing_file",
      source: { repo: "a", path: "index.md" },
      target: { repo: "a", path: "docs/missing.md", anchor: null },
    });
  });

  it("reports missing_anchor when file exists but anchor is absent from headings", () => {
    const snapshots = [makeSnapshot("a", [{ relPath: "docs/api.md", headings: ["overview"] }])];
    const edges = [edge("a", "index.md", "a", "docs/api.md", "nonexistent")];
    const findings = checkBrokenRefs(snapshots, edges);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject<Partial<BrokenRefFinding>>({
      kind: "missing_anchor",
      target: { repo: "a", path: "docs/api.md", anchor: "nonexistent" },
    });
  });

  it("resolves bare path by appending .md when the .md variant exists", () => {
    // edge targetPath has no .md extension; snapshot has "docs/api.md"
    const snapshots = [makeSnapshot("a", [{ relPath: "docs/api.md", headings: [] }])];
    const edges = [edge("a", "index.md", "a", "docs/api" /* no .md */)];
    const findings = checkBrokenRefs(snapshots, edges);
    expect(findings).toEqual([]); // resolved via .md fallback → no finding
  });
});
