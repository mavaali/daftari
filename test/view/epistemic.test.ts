import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultWrite } from "../../src/tools/write.js";
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

describe("viewer P1 — epistemic surface", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("/api/doc returns the JSON DTO with report keys and raw markdown", async () => {
    await vaultWrite(vault, {
      path: "pricing/a.md",
      body: "# Alpha\n\nRaw body.\n",
      frontmatter: frontmatter({ title: "Alpha" }),
      agent: AGENT,
    });
    const res = await handleView(vault, { path: "/api/doc/pricing/a.md", host: HOST });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    const dto = JSON.parse(res.body);
    expect(dto.path).toBe("pricing/a.md");
    expect(dto.content).toContain("Raw body."); // data, not HTML
    expect(dto.content).not.toContain("<p>");
    expect(dto).toHaveProperty("decay");
    expect(dto).toHaveProperty("structural");
    expect(dto).toHaveProperty("backlinks");
  });

  it("/api/doc 404s a missing document as JSON", async () => {
    const res = await handleView(vault, { path: "/api/doc/pricing/nope.md", host: HOST });
    expect(res.status).toBe(404);
    expect(res.contentType).toContain("application/json");
  });

  it("the doc page surfaces the structural (orphan) banner for a lone document", async () => {
    await vaultWrite(vault, {
      path: "pricing/lonely.md",
      body: "# Lonely\n\nNothing links here.\n",
      frontmatter: frontmatter({ title: "Lonely" }),
      agent: AGENT,
    });
    const res = await handleView(vault, { path: "/doc/pricing/lonely.md", host: HOST });
    expect(res.status).toBe(200);
    expect(res.body).toContain("banner");
    expect(res.body.toLowerCase()).toContain("links here");
  });

  it("/api/doc is host-guarded", async () => {
    const res = await handleView(vault, { path: "/api/doc/pricing/a.md", host: "evil.com" });
    expect(res.status).toBe(403);
  });
});
