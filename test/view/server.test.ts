import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultWrite } from "../../src/tools/write.js";
import { handleView, isAllowedHost } from "../../src/view/server.js";
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

describe("view server (slice C)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("host guard: loopback allowed, foreign host rejected", () => {
    expect(isAllowedHost("localhost:8788")).toBe(true);
    expect(isAllowedHost("127.0.0.1")).toBe(true);
    expect(isAllowedHost("evil.example.com")).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
  });

  it("rejects a non-loopback Host with 403", async () => {
    const res = await handleView(vault, { path: "/", host: "evil.example.com" });
    expect(res.status).toBe(403);
  });

  it("is read-only: a POST is refused with 405", async () => {
    const res = await handleView(vault, { method: "POST", path: "/", host: HOST });
    expect(res.status).toBe(405);
  });

  it("index lists a written doc under its collection", async () => {
    await vaultWrite(vault, {
      path: "pricing/alpha.md",
      body: "# Alpha\n",
      frontmatter: frontmatter({ title: "Alpha" }),
      agent: AGENT,
    });
    const res = await handleView(vault, { path: "/", host: HOST });
    expect(res.status).toBe(200);
    expect(res.body).toContain("Alpha");
    expect(res.body).toContain(`href="/doc/pricing/alpha.md"`);
  });

  it("doc page renders the body and its backlinks", async () => {
    await vaultWrite(vault, {
      path: "pricing/target.md",
      body: "# Target\n\nHello **world**.\n",
      frontmatter: frontmatter({ title: "Target" }),
      agent: AGENT,
    });
    await vaultWrite(vault, {
      path: "pricing/citer.md",
      body: "# Citer\n",
      frontmatter: frontmatter({ title: "Citer", sources: ["pricing/target.md"] }),
      agent: AGENT,
    });

    const res = await handleView(vault, { path: "/doc/pricing/target.md", host: HOST });
    expect(res.status).toBe(200);
    expect(res.body).toContain("<strong>world</strong>");
    expect(res.body).toContain(`href="/doc/pricing/citer.md"`);
  });

  it("a missing doc path returns 404", async () => {
    const res = await handleView(vault, { path: "/doc/pricing/nope.md", host: HOST });
    expect(res.status).toBe(404);
  });
});
