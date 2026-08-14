import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultWrite } from "../../src/tools/write.js";
import { renderDocBody } from "../../src/view/render.js";
import { handleView } from "../../src/view/server.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const HOST = "127.0.0.1:8788";

function fm(overrides: Record<string, unknown> = {}) {
  return {
    title: "Doc",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-07-01",
    provenance: "direct",
    sources: [] as string[],
    superseded_by: null,
    ttl_days: null,
    tags: [],
    ...overrides,
  };
}

describe("renderDocBody (P4 / R11)", () => {
  it("slugs h1–h3 into a TOC and gives headings matching ids", () => {
    const { html, toc } = renderDocBody("# Title\n\n## First Section\n\n### Sub A\n\ntext");
    expect(toc).toEqual([
      { depth: 1, text: "Title", id: "title" },
      { depth: 2, text: "First Section", id: "first-section" },
      { depth: 3, text: "Sub A", id: "sub-a" },
    ]);
    expect(html).toContain('id="first-section"');
  });

  it("de-duplicates repeated heading slugs", () => {
    const { toc } = renderDocBody("## Notes\n\n## Notes\n");
    expect(toc.map((t) => t.id)).toEqual(["notes", "notes-2"]);
  });

  it("rewrites an in-vault relative link to /doc via the resolver, leaving others", () => {
    const resolveLink = (raw: string) => (raw === "other.md" ? "projects/other.md" : null);
    const { html } = renderDocBody("[in](other.md) and [ext](https://x.com) and [miss](nope.md)", {
      resolveLink,
    });
    expect(html).toContain('href="/doc/projects/other.md"');
    expect(html).toContain('href="https://x.com"'); // external untouched
    expect(html).toContain('href="nope.md"'); // unresolved left as-is
  });

  it("stays sanitized — no script survives", () => {
    const { html } = renderDocBody("<script>alert(1)</script>\n\n# Ok");
    expect(html).not.toContain("<script>");
  });
});

describe("doc page render integration (P4)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("resolves a relative in-vault link on the rendered doc page", async () => {
    await vaultWrite(vault, {
      path: "pricing/target.md",
      body: "# Target\n",
      frontmatter: fm({ title: "Target" }),
      agent: "agent:test",
    });
    await vaultWrite(vault, {
      path: "pricing/source.md",
      body: "See [the target](target.md).\n",
      frontmatter: fm({ title: "Source" }),
      agent: "agent:test",
    });
    const res = await handleView(vault, { path: "/doc/pricing/source.md", host: HOST });
    expect(res.status).toBe(200);
    expect(res.body).toContain('href="/doc/pricing/target.md"');
  });

  it("renders a table of contents when the body has enough headings", async () => {
    await vaultWrite(vault, {
      path: "pricing/big.md",
      body: "# One\n\n## Two\n\n## Three\n\nbody\n",
      frontmatter: fm({ title: "Big" }),
      agent: "agent:test",
    });
    const res = await handleView(vault, { path: "/doc/pricing/big.md", host: HOST });
    expect(res.body).toContain(`class="toc"`);
    expect(res.body).toContain("On this page");
    expect(res.body).toContain('href="#two"');
  });
});
