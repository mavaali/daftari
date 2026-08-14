import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vaultReindex } from "../../src/tools/search.js";
import { vaultWrite } from "../../src/tools/write.js";
import { renderSearchPage } from "../../src/view/pages.js";
import { handleView } from "../../src/view/server.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const HOST = "127.0.0.1:8788";

describe("view search (slice C follow-up) — pure page", () => {
  it("empty query shows the prompt, not results", () => {
    const html = renderSearchPage("", []);
    expect(html).toContain("Type a query above.");
  });

  it("renders hits with title link, collection, and snippet", () => {
    const html = renderSearchPage("pricing", [
      { path: "pricing/a.md", title: "Alpha", collection: "pricing", snippet: "…pricing model…" },
    ]);
    expect(html).toContain(`href="/doc/pricing/a.md"`);
    expect(html).toContain("Alpha");
    expect(html).toContain("…pricing model…");
  });

  it("no-results state names the query, escaped", () => {
    const html = renderSearchPage("<x>", []);
    expect(html).toContain("No results");
    expect(html).not.toContain("<x>");
    expect(html).toContain("&lt;x&gt;");
  });
});

describe("view search — through the server", () => {
  let vault: string;
  beforeAll(async () => {
    vault = makeTempVault();
    await vaultWrite(vault, {
      path: "pricing/zebracorn.md",
      body: "# Zebracorn\n\nA highly distinctive zebracorn pricing note.\n",
      frontmatter: {
        title: "Zebracorn",
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
    const r = await vaultReindex(vault);
    if (!r.ok) throw r.error;
  }, 60_000);

  afterAll(() => {
    cleanupVault(vault);
  });

  it("empty query returns 200 with the prompt", async () => {
    const res = await handleView(vault, { path: "/search", query: "", host: HOST });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Type a query above.");
  });

  it("a query surfaces a matching document", async () => {
    const res = await handleView(vault, { path: "/search", query: "zebracorn", host: HOST });
    expect(res.status).toBe(200);
    expect(res.body).toContain(`href="/doc/pricing/zebracorn.md"`);
  });

  it("host guard still applies to /search", async () => {
    const res = await handleView(vault, { path: "/search", query: "x", host: "evil.com" });
    expect(res.status).toBe(403);
  });
});
