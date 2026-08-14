import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultWrite } from "../../src/tools/write.js";
import { renderGraphPage } from "../../src/view/pages.js";
import { handleView } from "../../src/view/server.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const HOST = "127.0.0.1:8788";

describe("viewer P2 — graph page + routes (R6/R7/R8)", () => {
  it("renderGraphPage carries the canvas, lazy-loaded lib, filters, and legend", () => {
    const html = renderGraphPage({ scope: "all" });
    expect(html).toContain(`id="cy"`);
    expect(html).toContain(`<script src="/assets/cytoscape.min.js">`);
    expect(html).toContain(`id="fstatus"`);
    expect(html).toContain(`id="fcollection"`);
    expect(html).toContain("legend");
    expect(html).toContain("contested");
  });

  it("an ego page names its root and offers a whole-vault toggle", () => {
    const html = renderGraphPage({ scope: "ego", root: "projects/a.md", depth: 2 });
    expect(html).toContain("/doc/projects/a.md");
    expect(html).toContain(`href="/graph"`); // whole-vault escape hatch
  });

  describe("routes", () => {
    let vault: string;
    beforeEach(() => {
      vault = makeTempVault();
    });
    afterEach(() => {
      cleanupVault(vault);
    });

    it("GET /graph serves the shell HTML", async () => {
      const res = await handleView(vault, { path: "/graph", host: HOST });
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("text/html");
      expect(res.body).toContain(`id="cy"`);
    });

    it("GET /assets/cytoscape.min.js serves the vendored library as JS", async () => {
      const res = await handleView(vault, { path: "/assets/cytoscape.min.js", host: HOST });
      expect(res.status).toBe(200);
      expect(res.contentType).toContain("application/javascript");
      expect(res.body.length).toBeGreaterThan(100000); // the real minified bundle
    });

    it("a doc page links to its ego-graph (R7)", async () => {
      await vaultWrite(vault, {
        path: "pricing/a.md",
        body: "# Alpha\n",
        frontmatter: {
          title: "Alpha",
          domain: "accumulation",
          collection: "pricing",
          status: "draft",
          confidence: "medium",
          created: "2026-07-01",
          provenance: "direct",
          sources: [],
          superseded_by: null,
          ttl_days: null,
          tags: [],
        },
        agent: "agent:test",
      });
      const res = await handleView(vault, { path: "/doc/pricing/a.md", host: HOST });
      expect(res.body).toContain("/graph?scope=ego&root=pricing/a.md");
    });

    it("the graph routes honor the loopback Host guard", async () => {
      for (const path of ["/graph", "/assets/cytoscape.min.js"]) {
        const res = await handleView(vault, { path, host: "evil.example.com" });
        expect(res.status).toBe(403);
      }
    });
  });
});
