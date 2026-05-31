// Verifies the index-state guards on search and write tools. The MCP server
// opens its stdio transport before the cold-start reindex finishes; during
// that window every tool that touches the SQLite index must refuse with a
// progress-bearing busy error instead of corrupting the in-progress rebuild.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markIndexError,
  markIndexing,
  markIndexReady,
  resetIndexState,
  setIndexProgress,
} from "../../src/search/index-state.js";
import { reindexVault } from "../../src/search/reindex.js";
import { vaultReindex, vaultSearch, vaultSearchRelated } from "../../src/tools/search.js";
import { vaultAppend, vaultDeprecate, vaultPromote, vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:test";

function frontmatter() {
  return {
    title: "Busy Doc",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-05-01",
    updated: "2026-05-01",
    updated_by: "agent:test",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: ["pricing"],
  };
}

describe("index-state guards", () => {
  let vault: string;

  beforeEach(async () => {
    vault = makeTempVault();
    resetIndexState();
    // Prime the index so tools don't fall through to the empty-index reindex
    // path; we want to test the guard in isolation.
    const result = await reindexVault(vault);
    if (!result.ok) throw result.error;
  }, 60_000);

  afterEach(() => {
    resetIndexState();
    cleanupVault(vault);
  });

  describe("while status is 'indexing'", () => {
    beforeEach(() => {
      markIndexing();
      setIndexProgress(123, 1000);
    });

    it("vault_search returns a busy error with progress", async () => {
      const result = await vaultSearch(vault, { query: "anything" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("still indexing");
      expect(result.error.message).toContain("123/1000");
    });

    it("vault_search_related returns a busy error", async () => {
      const result = await vaultSearchRelated(vault, {
        path: "competitive-intel/vega-insight-positioning.md",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("still indexing");
    });

    it("vault_reindex coalesces with an in-flight pass and then runs", async () => {
      // Contract: rather than refusing when a reindex is already in flight
      // (e.g. the startup-time background pass), vault_reindex awaits the
      // in-flight pass and then runs the requested reindex. An agent that
      // asks to rebuild the index should not get a busy error just because
      // the server is finishing its own startup work.
      setTimeout(() => markIndexReady(), 50);
      const result = await vaultReindex(vault);
      expect(result.ok).toBe(true);
    }, 30_000);

    it("vault_write returns a busy error and writes nothing", async () => {
      const result = await vaultWrite(vault, {
        path: "pricing/busy.md",
        body: "# busy\n",
        frontmatter: frontmatter(),
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("still indexing");
    });

    it("vault_append returns a busy error", async () => {
      const result = await vaultAppend(vault, {
        path: "pricing/helios-consumption-pricing.md",
        section: "## Note\n",
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("still indexing");
    });

    it("vault_promote returns a busy error", async () => {
      const result = await vaultPromote(vault, {
        path: "pricing/helios-consumption-pricing.md",
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("still indexing");
    });

    it("vault_deprecate returns a busy error", async () => {
      const result = await vaultDeprecate(vault, {
        path: "pricing/helios-consumption-pricing.md",
        agent: AGENT,
        reason: "obsolete",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("still indexing");
    });
  });

  describe("while status is 'error'", () => {
    beforeEach(() => {
      markIndexError("disk full");
    });

    it("vault_search surfaces the error state", async () => {
      const result = await vaultSearch(vault, { query: "anything" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("error state");
      expect(result.error.message).toContain("disk full");
    });

    it("vault_write surfaces the error state", async () => {
      const result = await vaultWrite(vault, {
        path: "pricing/err.md",
        body: "# err\n",
        frontmatter: frontmatter(),
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("error state");
    });
  });

  describe("while status is 'ready'", () => {
    it("vault_search works normally", async () => {
      const result = await vaultSearch(vault, {
        query: "Helios compute credit consumption pricing",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.length).toBeGreaterThan(0);
    }, 30_000);

    it("vault_write works normally", async () => {
      const result = await vaultWrite(vault, {
        path: "pricing/ready.md",
        body: "# ready\n",
        frontmatter: frontmatter(),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
    }, 30_000);
  });
});
