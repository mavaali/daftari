import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultWrite } from "../../src/tools/write.js";
import { renderDashboardPage } from "../../src/view/pages.js";
import { handleView } from "../../src/view/server.js";
import type { StatusView } from "../../src/view/status-view.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const HOST = "127.0.0.1:8788";

const sample: StatusView = {
  vault: "/v",
  fileCount: 42,
  collections: [
    { collection: "pricing", count: 20 },
    { collection: "projects", count: 22 },
  ],
  staleness: { fresh: 30, aging: 8, stale: 4, total: 42 },
  validity: { authored: 5, unknown: 37, total: 42 },
  unresolvedTensions: 3,
  ratificationQueue: 2,
  recentRuns: [{ id: "2026-08-14T03:00:00Z", kind: "circadian", ts: "2026-08-14T03:00:00Z" }],
  invalidCount: 0,
  generatedAt: "2026-08-14T12:00:00Z",
};

describe("viewer P3 — dashboard page (R10)", () => {
  it("renders metric tiles, a freshness bar, and the run trend", () => {
    const html = renderDashboardPage(sample);
    expect(html).toContain("Vault dashboard");
    expect(html).toContain(">42<"); // documents count
    expect(html).toContain("documents");
    expect(html).toContain("open tensions");
    expect(html).toContain("ratification queue");
    expect(html).toContain("sbar"); // staleness bar
    expect(html).toContain("fresh 30");
    expect(html).toContain("circadian"); // a run in the trend
    expect(html).toContain(`href="/docs"`);
    expect(html).toContain(`href="/graph"`);
  });

  it("flags open tensions and ratification queue as alerts when non-zero", () => {
    const html = renderDashboardPage(sample);
    expect(html).toContain("tile alert");
  });

  it("shows an empty-state for a vault with no sleep runs", () => {
    const html = renderDashboardPage({ ...sample, recentRuns: [] });
    expect(html).toContain("No runs recorded yet.");
  });
});

describe("viewer P3 — dashboard routes (R9/R10)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("GET /api/status returns the JSON DTO", async () => {
    const res = await handleView(vault, { path: "/api/status", host: HOST });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("application/json");
    const dto = JSON.parse(res.body);
    expect(typeof dto.fileCount).toBe("number");
    expect(Array.isArray(dto.collections)).toBe(true);
    expect(dto.staleness).toHaveProperty("fresh");
    expect(dto).toHaveProperty("ratificationQueue");
    expect(dto).toHaveProperty("recentRuns");
  });

  it("GET / serves the dashboard (not the index)", async () => {
    const res = await handleView(vault, { path: "/", host: HOST });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.body).toContain("Vault dashboard");
  });

  it("GET /docs serves the collection index", async () => {
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
    const res = await handleView(vault, { path: "/docs", host: HOST });
    expect(res.status).toBe(200);
    expect(res.body).toContain("/doc/pricing/a.md");
    expect(res.body).toContain("Vault");
  });

  it("honors the loopback Host guard on /api/status", async () => {
    const res = await handleView(vault, { path: "/api/status", host: "evil.example.com" });
    expect(res.status).toBe(403);
  });
});
