import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultTensionLog } from "../../src/tools/curation.js";
import { vaultWrite } from "../../src/tools/write.js";
import { renderDocPage } from "../../src/view/pages.js";
import { handleView } from "../../src/view/server.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:test";
const HOST = "127.0.0.1:8788";

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Doc",
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
    ...overrides,
  };
}

describe("view tensions panel (slice C follow-up)", () => {
  it("pure: renders a Contested panel with counterpart link and both claims", () => {
    const html = renderDocPage({
      path: "pricing/a.md",
      frontmatter: {
        title: "A",
        collection: "pricing",
        status: "draft",
        confidence: "medium",
        provenance: "direct",
        tier: null,
        tags: [],
      },
      bodyHtml: "",
      backlinks: [],
      tensions: [
        {
          counterpart: "pricing/b.md",
          kind: "factual",
          claimSelf: "pooled is cheaper",
          claimOther: "consumption is cheaper",
          loggedAt: "2026-08-14",
        },
      ],
    });
    expect(html).toContain("Contested");
    expect(html).toContain(`href="/doc/pricing/b.md"`);
    expect(html).toContain("pooled is cheaper");
    expect(html).toContain("consumption is cheaper");
    expect(html).toContain("factual");
  });

  it("pure: no panel when there are no tensions", () => {
    const html = renderDocPage({
      path: "pricing/a.md",
      frontmatter: {
        title: "A",
        collection: "pricing",
        status: "draft",
        confidence: "medium",
        provenance: "direct",
        tier: null,
        tags: [],
      },
      bodyHtml: "",
      backlinks: [],
      tensions: [],
    });
    expect(html).not.toContain("Contested");
  });

  describe("end-to-end through the server (no index required)", () => {
    let vault: string;
    beforeEach(() => {
      vault = makeTempVault();
    });
    afterEach(() => {
      cleanupVault(vault);
    });

    it("a logged tension surfaces on the doc page", async () => {
      await vaultWrite(vault, {
        path: "pricing/a.md",
        body: "# A\n",
        frontmatter: frontmatter({ title: "A" }),
        agent: AGENT,
      });
      await vaultWrite(vault, {
        path: "pricing/b.md",
        body: "# B\n",
        frontmatter: frontmatter({ title: "B" }),
        agent: AGENT,
      });
      const logged = await vaultTensionLog(vault, {
        title: "Capacity model disagreement",
        sourceA: "pricing/a.md",
        claimA: "pooled is cheaper at scale",
        sourceB: "pricing/b.md",
        claimB: "consumption is cheaper at scale",
        agent: AGENT,
        kind: "factual",
      });
      expect(logged.ok).toBe(true);

      const res = await handleView(vault, { path: "/doc/pricing/a.md", host: HOST });
      expect(res.status).toBe(200);
      expect(res.body).toContain("Contested");
      expect(res.body).toContain(`href="/doc/pricing/b.md"`);
      expect(res.body).toContain("consumption is cheaper at scale");
    });
  });
});
