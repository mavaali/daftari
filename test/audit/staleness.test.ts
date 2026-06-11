// test/audit/staleness.test.ts
import { describe, expect, it } from "vitest";
import { checkStaleness } from "../../src/audit/checks/staleness.js";
import type { DocSnapshot, LinkEdge, RepoSnapshot } from "../../src/audit/types.js";

const NOW = new Date("2026-05-30T00:00:00.000Z");

function doc(relPath: string, ageDays: number): DocSnapshot {
  const mtime = new Date(NOW.getTime() - ageDays * 86_400_000).toISOString();
  return {
    relPath,
    absPath: `/x/${relPath}`,
    mtime,
    mtimeSource: "git",
    headings: new Set(),
    links: [],
  };
}

function repo(name: string, docs: DocSnapshot[]): RepoSnapshot {
  return {
    config: { name, path: `/${name}`, docsGlob: "**/*.md", urls: [], type: "docs" },
    docs: new Map(docs.map((d) => [d.relPath, d])),
  };
}

function codeRepo(name: string, docs: DocSnapshot[]): RepoSnapshot {
  return {
    config: { name, path: `/${name}`, docsGlob: "**/*", urls: [], type: "code" },
    docs: new Map(docs.map((d) => [d.relPath, d])),
  };
}

const e = (s: string, t: string): LinkEdge => ({
  sourceRepo: "r",
  sourcePath: s,
  targetRepo: "r",
  targetPath: t,
  targetAnchor: null,
  rawHref: t,
});

describe("checkStaleness", () => {
  it("flags directly stale docs past the threshold", () => {
    const snaps = [repo("r", [doc("a.md", 10), doc("b.md", 600)])];
    const findings = checkStaleness(snaps, [], 540, NOW);
    expect(findings.map((f) => ({ k: f.kind, p: f.path }))).toEqual([{ k: "direct", p: "b.md" }]);
  });

  it("flags transitively stale via a chain", () => {
    const snaps = [repo("r", [doc("a.md", 1), doc("b.md", 1), doc("c.md", 700)])];
    const edges = [e("a.md", "b.md"), e("b.md", "c.md")];
    const findings = checkStaleness(snaps, edges, 540, NOW);
    const transitive = findings.find((f) => f.kind === "transitive" && f.path === "a.md");
    expect(transitive).toBeDefined();
    expect(transitive?.staleChain).toEqual([
      { repo: "r", path: "a.md", mtime: expect.any(String) },
      { repo: "r", path: "b.md", mtime: expect.any(String) },
      { repo: "r", path: "c.md", mtime: expect.any(String) },
    ]);
  });

  it("does not infinite-loop on cycles", () => {
    const snaps = [repo("r", [doc("a.md", 1), doc("b.md", 1)])];
    const edges = [e("a.md", "b.md"), e("b.md", "a.md")];
    const findings = checkStaleness(snaps, edges, 540, NOW);
    expect(findings).toEqual([]);
  });

  it("picks the shortest chain when branching", () => {
    const snaps = [
      repo("r", [
        doc("a.md", 1),
        doc("b.md", 1),
        doc("c.md", 1),
        doc("d.md", 1),
        doc("stale.md", 1000),
      ]),
    ];
    const edges = [
      e("a.md", "b.md"),
      e("b.md", "c.md"),
      e("c.md", "stale.md"),
      e("a.md", "d.md"),
      e("d.md", "stale.md"),
    ];
    const findings = checkStaleness(snaps, edges, 540, NOW);
    const a = findings.find((f) => f.path === "a.md" && f.kind === "transitive");
    expect(a?.staleChain?.length).toBe(3); // a -> d -> stale
  });

  it("classifies each node at most once across multiple roots", () => {
    // Two fresh roots a.md and b.md both link to c.md, which links to stale.
    const snaps = [
      repo("r", [doc("a.md", 1), doc("b.md", 1), doc("c.md", 1), doc("stale.md", 1000)]),
    ];
    const edges = [e("a.md", "c.md"), e("b.md", "c.md"), e("c.md", "stale.md")];
    const findings = checkStaleness(snaps, edges, 540, NOW);
    const paths = findings.map((f) => `${f.kind}:${f.path}`);
    const uniquePaths = [...new Set(paths)];
    expect(paths).toEqual(uniquePaths); // no duplicates
    // And c.md is transitively stale; a.md and b.md too; stale.md is direct.
    expect(findings.map((f) => f.path).sort()).toEqual(["a.md", "b.md", "c.md", "stale.md"].sort());
  });

  it("never flags a code repo's files as stale (#118)", () => {
    // A code repo file with an ancient mtime must not appear as directly stale —
    // code repos are reference targets, not managed documents.
    const snaps = [codeRepo("svc", [doc("src/login.ts", 5000)])];
    const findings = checkStaleness(snaps, [], 540, NOW);
    expect(findings).toEqual([]);
  });
});
