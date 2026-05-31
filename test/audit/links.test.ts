// test/audit/links.test.ts
import { describe, expect, it } from "vitest";
import { classifyEdges, extractLinksFromBody } from "../../src/audit/links.js";
import type { DocSnapshot, RepoSnapshot } from "../../src/audit/types.js";

const headings = new Set<string>();
function snap(repo: string, path: string, body: string): RepoSnapshot {
  const links = extractLinksFromBody(body);
  const docs = new Map<string, DocSnapshot>();
  docs.set(path, {
    relPath: path,
    absPath: `/${repo}/${path}`,
    mtime: "2026-01-01T00:00:00.000Z",
    mtimeSource: "git",
    headings,
    links,
  });
  return {
    config: { name: repo, path: `/${repo}`, docsGlob: "**/*.md", urls: [] },
    docs,
  };
}

describe("extractLinksFromBody", () => {
  it("extracts markdown links with hrefs", () => {
    const links = extractLinksFromBody("see [a](foo.md) and [b](bar/baz.md#sec)");
    expect(links.map((l) => l.href)).toEqual(["foo.md", "bar/baz.md"]);
    expect(links.map((l) => l.anchor)).toEqual([null, "sec"]);
  });

  it("flags URL vs relative", () => {
    const links = extractLinksFromBody("[u](https://x.com/y) [r](docs/x.md) [a](#sec)");
    expect(links.map((l) => ({ url: l.isUrl, rel: l.isRelative }))).toEqual([
      { url: true, rel: false },
      { url: false, rel: true },
      { url: false, rel: false },
    ]);
  });

  it("ignores mailto: and bare anchors", () => {
    const links = extractLinksFromBody("[m](mailto:a@b) [a](#x)");
    expect(links.every((l) => !l.isRelative)).toBe(true);
  });

  it("ignores wikilinks", () => {
    expect(extractLinksFromBody("see [[foo]]")).toEqual([]);
  });
});

describe("classifyEdges — URL match with boundary check", () => {
  it("matches an exact prefix with a path boundary", () => {
    const a = snap(
      "a",
      "x.md",
      "[doc](https://github.com/org/service-b/blob/main/docs/api.md#run)",
    );
    a.config.urls = [];
    const b: RepoSnapshot = {
      config: {
        name: "service-b",
        path: "/b",
        docsGlob: "**/*.md",
        urls: ["github.com/org/service-b"],
      },
      docs: new Map(),
    };
    const edges = classifyEdges([a, b]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceRepo: "a",
      targetRepo: "service-b",
      targetPath: "docs/api.md",
      targetAnchor: "run",
    });
  });

  it("rejects a similar-prefix non-match (the boundary case)", () => {
    const a = snap(
      "a",
      "x.md",
      "[doc](https://github.com/org/service-a-tools/blob/main/README.md)",
    );
    const b: RepoSnapshot = {
      config: {
        name: "service-a",
        path: "/b",
        docsGlob: "**/*.md",
        urls: ["github.com/org/service-a"],
      },
      docs: new Map(),
    };
    const edges = classifyEdges([a, b]);
    expect(edges.filter((e) => e.targetRepo === "service-a")).toHaveLength(0);
  });

  it("ignores URLs that match no configured repo", () => {
    const a = snap("a", "x.md", "[ext](https://example.com/whatever.md)");
    const edges = classifyEdges([a]);
    expect(edges).toEqual([]);
  });
});

describe("classifyEdges — relative-path escape", () => {
  it("classifies ../other-repo/foo.md as cross-repo", () => {
    const a = snap("a", "docs/x.md", "[other](../../b/docs/y.md)");
    a.config.path = "/repos/a";
    const b: RepoSnapshot = {
      config: { name: "b", path: "/repos/b", docsGlob: "**/*.md", urls: [] },
      docs: new Map(),
    };
    const edges = classifyEdges([a, b]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceRepo: "a",
      targetRepo: "b",
      targetPath: "docs/y.md",
    });
  });

  it("classifies foo.md (no escape) as in-repo edge", () => {
    const a = snap("a", "docs/x.md", "[in](./y.md)");
    a.config.path = "/repos/a";
    const edges = classifyEdges([a]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.sourceRepo).toBe("a");
    expect(edges[0]?.targetRepo).toBe("a");
    expect(edges[0]?.targetPath).toBe("docs/y.md");
  });
});
