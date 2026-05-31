import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordProvenance } from "../../src/curation/provenance.js";
import { listTensions, resolveTension } from "../../src/curation/tension.js";
import {
  curationTools,
  vaultLint,
  vaultProvenance,
  vaultTensionClusters,
  vaultTensionLog,
} from "../../src/tools/curation.js";

const LINT_VAULT = resolve("test/fixtures/lint-vault");

describe("curation tools", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-curation-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  describe("vault_lint", () => {
    it("runs every check and totals the findings", async () => {
      const result = await vaultLint(LINT_VAULT, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.filter).toBeNull();
      expect(result.value.totalFindings).toBe(5);
      expect(Object.keys(result.value.checks)).toHaveLength(6);
    });

    it("narrows the report to a single check when filtered", async () => {
      const result = await vaultLint(LINT_VAULT, { filter: "orphanFiles" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.filter).toBe("orphanFiles");
      expect(Object.keys(result.value.checks)).toEqual(["orphanFiles"]);
      expect(result.value.totalFindings).toBe(1);
    });

    it("rejects an unknown filter", async () => {
      const result = await vaultLint(LINT_VAULT, { filter: "nonsense" });
      expect(result.ok).toBe(false);
    });
  });

  describe("vault_tension_log", () => {
    it("logs a tension and persists it as unresolved", async () => {
      const result = await vaultTensionLog(vault, {
        title: "Capacity model disagreement",
        sourceA: "pricing/a.md",
        claimA: "pooled is cheaper at scale",
        sourceB: "pricing/b.md",
        claimB: "consumption is cheaper at scale",
        agent: "agent:claude-code",
        kind: "factual",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("unresolved");
      expect(result.value.loggedBy).toBe("agent:claude-code");
      expect(result.value.kind).toBe("factual");

      const logged = await listTensions(vault);
      expect(logged.ok && logged.value).toHaveLength(1);
    });

    it("rejects a tension missing a required field", async () => {
      const result = await vaultTensionLog(vault, {
        title: "Incomplete",
        sourceA: "pricing/a.md",
        agent: "agent:claude-code",
        kind: "factual",
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("vault_tension_clusters", () => {
    it("returns zero clusters when nothing has been logged", async () => {
      const result = await vaultTensionClusters(vault, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.cluster_count).toBe(0);
      expect(result.value.clusters).toEqual([]);
    });

    it("groups two transitively-connected tensions into one cluster", async () => {
      await vaultTensionLog(vault, {
        title: "t1",
        sourceA: "a.md",
        claimA: "A",
        sourceB: "b.md",
        claimB: "B",
        agent: "agent:claude-code",
        kind: "factual",
      });
      await vaultTensionLog(vault, {
        title: "t2",
        sourceA: "b.md",
        claimA: "B",
        sourceB: "c.md",
        claimB: "C",
        agent: "agent:claude-code",
        kind: "interpretive",
      });

      const result = await vaultTensionClusters(vault, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.cluster_count).toBe(1);
      const [cluster] = result.value.clusters;
      expect(cluster?.documents).toEqual(["a.md", "b.md", "c.md"]);
      expect(cluster?.id).toMatch(/^cluster:[0-9a-f]{8}$/);
      expect(cluster?.tension_count).toBe(2);
    });

    it("drops accepted-resolution tensions from cluster scope", async () => {
      const logged = await vaultTensionLog(vault, {
        title: "stable",
        sourceA: "a.md",
        claimA: "A",
        sourceB: "b.md",
        claimB: "B",
        agent: "agent:claude-code",
        kind: "interpretive",
      });
      expect(logged.ok).toBe(true);
      if (!logged.ok) return;
      await resolveTension(vault, logged.value.id as string, {
        resolved_at: "2026-05-15T00:00:00Z",
        resolved_by: "human:mihir",
        kind: "accepted",
      });

      const result = await vaultTensionClusters(vault, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.cluster_count).toBe(0);
    });

    it("registers vault_tension_clusters as a read-only MCP tool", () => {
      const def = curationTools.find((t) => t.name === "vault_tension_clusters");
      expect(def).toBeDefined();
      expect(def?.annotations?.readOnlyHint).toBe(true);
      // No required arguments — accepts an empty object.
      expect((def?.inputSchema as { required?: unknown }).required).toBeUndefined();
    });
  });

  describe("vault_provenance", () => {
    it("returns the write history for a single file, oldest first", async () => {
      await recordProvenance(vault, {
        timestamp: "2026-05-01T00:00:00.000Z",
        tool: "vault_write",
        file: "pricing/a.md",
        agent: "agent:claude-code",
        action: "create",
      });
      await recordProvenance(vault, {
        timestamp: "2026-05-02T00:00:00.000Z",
        tool: "vault_write",
        file: "pricing/b.md",
        agent: "agent:claude-code",
        action: "create",
      });
      await recordProvenance(vault, {
        timestamp: "2026-05-03T00:00:00.000Z",
        tool: "vault_promote",
        file: "pricing/a.md",
        agent: "human:mihir",
        action: "promote",
      });

      const result = await vaultProvenance(vault, { filePath: "pricing/a.md" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.count).toBe(2);
      expect(result.value.history.map((e) => e.action)).toEqual(["create", "promote"]);
    });

    it("returns an empty history for a file with no recorded writes", async () => {
      const result = await vaultProvenance(vault, { filePath: "pricing/x.md" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.count).toBe(0);
    });

    it("rejects a missing filePath", async () => {
      const result = await vaultProvenance(vault, {});
      expect(result.ok).toBe(false);
    });
  });
});
