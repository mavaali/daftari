import { describe, expect, it } from "vitest";
import { renderDocPage, renderIndexPage } from "../../src/view/pages.js";

describe("view pages (slice C)", () => {
  it("index groups docs by collection with links", () => {
    const html = renderIndexPage([
      { collection: "pricing", docs: [{ path: "pricing/a.md", title: "Alpha" }] },
    ]);
    expect(html).toContain("pricing");
    expect(html).toContain(`href="/doc/pricing/a.md"`);
    expect(html).toContain("Alpha");
  });

  it("empty index renders a friendly empty state, not a crash", () => {
    expect(renderIndexPage([])).toContain("No documents found.");
  });

  it("doc page shows frontmatter chips, sanitized body, and backlinks", () => {
    const html = renderDocPage({
      path: "pricing/a.md",
      frontmatter: {
        title: "Alpha",
        collection: "pricing",
        status: "canonical",
        confidence: "high",
        provenance: "direct",
        tier: null,
        tags: ["pricing", "core"],
      },
      bodyHtml: "<p>rendered body</p>",
      backlinks: [{ doc: "pricing/b.md", label: "source" }],
    });
    expect(html).toContain("Alpha");
    expect(html).toContain("canonical");
    expect(html).toContain("rendered body");
    expect(html).toContain(`href="/doc/pricing/b.md"`);
    expect(html).toContain("source");
  });

  it("doc page escapes a hostile title", () => {
    const html = renderDocPage({
      path: "x.md",
      frontmatter: {
        title: `<script>alert(1)</script>`,
        collection: "c",
        status: "draft",
        confidence: "low",
        provenance: "direct",
        tier: null,
        tags: [],
      },
      bodyHtml: "",
      backlinks: [],
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("doc page renders an empty-backlinks state", () => {
    const html = renderDocPage({
      path: "x.md",
      frontmatter: {
        title: "X",
        collection: "c",
        status: "draft",
        confidence: "low",
        provenance: "direct",
        tier: null,
        tags: [],
      },
      bodyHtml: "",
      backlinks: [],
    });
    expect(html).toContain("No documents reference this one.");
  });
});
