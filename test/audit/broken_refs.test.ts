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

describe("checkBrokenRefs with a disk oracle (#132/#133)", () => {
  const snapshots = [makeSnapshot("a", [{ relPath: "docs/api.md" }])];

  it("a reference to an on-disk asset outside the doc index is not a finding (#132)", () => {
    const edges = [edge("a", "docs/api.md", "a", "assets/dag.png")];
    const exists = (abs: string) => abs === "/a/assets/dag.png";
    expect(checkBrokenRefs(snapshots, edges, exists)).toEqual([]);
    // Absent asset stays a real miss.
    expect(checkBrokenRefs(snapshots, edges, () => false)).toHaveLength(1);
    // No oracle: index-only behavior, as before.
    expect(checkBrokenRefs(snapshots, edges)).toHaveLength(1);
  });

  it("an out-of-scope ref that exists on disk is out_of_scope_target, absent is missing_file (#133)", () => {
    const outEdge: LinkEdge = {
      sourceRepo: "a",
      sourcePath: "docs/api.md",
      targetRepo: "a",
      targetPath: "../../guides/foo.md",
      targetAnchor: null,
      rawHref: "../../guides/foo.md",
      outOfScope: true,
      resolvedAbs: "/guides/foo.md",
    };
    const present = checkBrokenRefs(snapshots, [outEdge], (abs) => abs === "/guides/foo.md");
    expect(present).toHaveLength(1);
    expect(present[0]?.kind).toBe("out_of_scope_target");

    const absent = checkBrokenRefs(snapshots, [outEdge], () => false);
    expect(absent[0]?.kind).toBe("missing_file");
    // No oracle: conservative missing_file, never a silent pass.
    expect(checkBrokenRefs(snapshots, [outEdge])[0]?.kind).toBe("missing_file");
  });

  it("an out-of-scope existing target never silently passes even when it would resolve as an asset", () => {
    const outEdge: LinkEdge = {
      sourceRepo: "a",
      sourcePath: "docs/api.md",
      targetRepo: "a",
      targetPath: "../elsewhere/pic.png",
      targetAnchor: null,
      rawHref: "../elsewhere/pic.png",
      outOfScope: true,
      resolvedAbs: "/elsewhere/pic.png",
    };
    const findings = checkBrokenRefs(snapshots, [outEdge], () => true);
    expect(findings.map((f) => f.kind)).toEqual(["out_of_scope_target"]);
  });
});
