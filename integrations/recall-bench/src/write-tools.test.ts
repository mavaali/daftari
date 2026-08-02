// Tests for the write-capable tool surface (write-tools.ts).
//
// HERMETIC block: defs shape tests — no MiniLM, no real reindex, no network.
//
// INTEGRATION block (RB_INTEGRATION): write-then-read against a real tmp vault
// with a real index. Gated because reindexVault loads MiniLM, which is heavy
// (same pattern as adapter.test.ts).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWriteToolSurface } from "./write-tools.js";

const RUN = !!process.env.RB_INTEGRATION;

// ---------------------------------------------------------------------------
// HERMETIC: defs shape — no vault I/O
// ---------------------------------------------------------------------------

describe("buildWriteToolSurface — defs", () => {
  // Use a non-existent path: defs are computed without touching disk.
  const surface = buildWriteToolSurface("/tmp/__daftari_write_tools_fake_vault__");

  it("includes vault_write in defs", () => {
    expect(surface.defs.some((d) => d.name === "vault_write")).toBe(true);
  });

  it("includes vault_supersede in defs", () => {
    expect(surface.defs.some((d) => d.name === "vault_supersede")).toBe(true);
  });

  it("includes vault_tension_log in defs", () => {
    expect(surface.defs.some((d) => d.name === "vault_tension_log")).toBe(true);
  });

  it("includes vault_tension_clusters in defs", () => {
    expect(surface.defs.some((d) => d.name === "vault_tension_clusters")).toBe(true);
  });

  it("includes at least one read tool (vault_search) in defs", () => {
    expect(surface.defs.some((d) => d.name === "vault_search")).toBe(true);
  });

  it("exposes a handler function", () => {
    expect(typeof surface.handler).toBe("function");
  });

  it("has no duplicate tool names (LLM API requires unique names)", () => {
    const names = surface.defs.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION: real tmp vault, real index — gated behind RB_INTEGRATION
// ---------------------------------------------------------------------------

describe("buildWriteToolSurface — write-then-read (RB_INTEGRATION)", () => {
  if (!RUN) {
    it.skip("skipped (set RB_INTEGRATION=1 to run)", () => {});
    return;
  }

  let vaultRoot: string;

  beforeAll(async () => {
    // Create a minimal vault: tmp dir + an empty notes collection dir.
    // vault.json is optional — loadConfig returns emptyConfig() when absent.
    vaultRoot = await mkdtemp(join(tmpdir(), "daftari-write-tools-"));
    await mkdir(join(vaultRoot, "notes"), { recursive: true });

    // Initialize the index before any write (mirrors adapter.ts finalizeIngestion).
    const { reindexVault } = await import("../../../dist/search/reindex.js");
    await reindexVault(vaultRoot);
  });

  afterAll(async () => {
    if (vaultRoot) {
      await rm(vaultRoot, { recursive: true, force: true });
    }
  });

  it("vault_write creates a document that vault_read returns after reindex", async () => {
    const { reindexVault } = await import("../../../dist/search/reindex.js");
    const surface = buildWriteToolSurface(vaultRoot);

    const docPath = "notes/hello-world.md";
    await surface.handler("vault_write", {
      path: docPath,
      body: "Hello from write-tools test.",
      frontmatter: {
        title: "Hello World",
        domain: "accumulation",
        collection: "notes",
        status: "draft",
        confidence: "high",
        provenance: "direct",
        created: "2026-01-01",
        tags: [],
      },
      agent: "test-agent",
    });

    // Reindex so vault_read can resolve the freshly written doc.
    await reindexVault(vaultRoot);

    const result = await surface.handler("vault_read", { path: docPath });
    expect(result).toBeTruthy();
    const r = result as Record<string, unknown>;
    expect(r.path).toBe(docPath);
    // vault_read returns the body in the `content` field (not `body`)
    expect(typeof r.content === "string" && r.content.includes("Hello from write-tools test.")).toBe(true);
  });

  it("handler throws on vault_write error (e.g. missing required field)", async () => {
    const surface = buildWriteToolSurface(vaultRoot);

    // Missing 'body' — vaultWrite returns {ok:false,...} → handler must throw.
    // (body is required; omitting it causes a Result error which unwrapResult throws)
    await expect(
      surface.handler("vault_write", {
        path: "notes/bad.md",
        // body intentionally omitted — triggers "vault_write requires a string 'body' argument"
        frontmatter: {
          title: "Bad",
          domain: "accumulation",
          collection: "notes",
          status: "draft",
          confidence: "high",
          provenance: "direct",
          created: "2026-01-01",
          tags: [],
        },
        agent: "test-agent",
      }),
    ).rejects.toThrow();
  });
});
