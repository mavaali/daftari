import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordProvenance } from "../../src/curation/provenance.js";
import { listTensions } from "../../src/curation/tension.js";
import { vaultLint, vaultProvenance, vaultTensionLog } from "../../src/tools/curation.js";

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
