import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canPromote,
  canRatify,
  canRead,
  canWrite,
  filterByReadPermission,
  guestAccess,
  hasAnyRead,
  resolveAccess,
} from "../../src/access/rbac.js";
import { vaultIndex } from "../../src/tools/read.js";
import { vaultReindex, vaultSearch } from "../../src/tools/search.js";
import { configPath, loadConfig } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const SAMPLE = resolve("test/fixtures/sample-vault");
const MOONSHOT_DOC = "_drafts/moonshot-agentic-etl.md";

// The sample vault's config is the RBAC fixture for the whole suite.
const sampleConfig = loadConfig(SAMPLE);
if (!sampleConfig.ok) throw sampleConfig.error;
const config = sampleConfig.value;

const analyst = resolveAccess(config, "human:a", "analyst");
const researcher = resolveAccess(config, "human:r", "researcher");
const admin = resolveAccess(config, "human:m", "admin");

describe("rbac", () => {
  describe("loadConfig", () => {
    it("loads the sample vault's roles", () => {
      expect(Object.keys(config.roles).sort()).toEqual(["admin", "analyst", "researcher"]);
      expect(config.roles.analyst?.read).toEqual(["competitive-intel", "pricing"]);
      expect(config.roles.admin?.promote).toBe(true);
    });

    it("returns an empty role set when no config file exists", () => {
      const dir = mkdtempSync(join(tmpdir(), "daftari-noconfig-"));
      try {
        const result = loadConfig(dir);
        expect(result.ok && result.value.roles).toEqual({});
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails loud on invalid YAML", () => {
      const dir = mkdtempSync(join(tmpdir(), "daftari-badyaml-"));
      try {
        mkdirSync(join(dir, ".daftari"), { recursive: true });
        writeFileSync(configPath(dir), "roles:\n  analyst:\n    read: [a, b\n");
        const result = loadConfig(dir);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("malformed");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("fails loud on a structurally malformed config", () => {
      const dir = mkdtempSync(join(tmpdir(), "daftari-badcfg-"));
      try {
        mkdirSync(join(dir, ".daftari"), { recursive: true });
        // `read` must be a list, not a string.
        writeFileSync(configPath(dir), "roles:\n  analyst:\n    read: competitive-intel\n");
        const result = loadConfig(dir);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain("malformed");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("permission primitives", () => {
    it("lets the analyst read competitive-intel and pricing but not moonshot", () => {
      expect(canRead(analyst.role, "competitive-intel")).toBe(true);
      expect(canRead(analyst.role, "pricing")).toBe(true);
      expect(canRead(analyst.role, "moonshot")).toBe(false);
    });

    it("lets the analyst write competitive-intel only", () => {
      expect(canWrite(analyst.role, "competitive-intel")).toBe(true);
      expect(canWrite(analyst.role, "pricing")).toBe(false);
      expect(canWrite(analyst.role, "moonshot")).toBe(false);
      expect(canPromote(analyst.role)).toBe(false);
    });

    it("lets the researcher write moonshot and _drafts only", () => {
      expect(canWrite(researcher.role, "moonshot")).toBe(true);
      expect(canWrite(researcher.role, "_drafts")).toBe(true);
      expect(canWrite(researcher.role, "competitive-intel")).toBe(false);
      expect(canWrite(researcher.role, "pricing")).toBe(false);
      expect(canPromote(researcher.role)).toBe(false);
    });

    it("lets the admin read, write, and promote everything via wildcard", () => {
      expect(canRead(admin.role, "anything")).toBe(true);
      expect(canWrite(admin.role, "anything")).toBe(true);
      expect(canPromote(admin.role)).toBe(true);
    });

    it("grants ratify only where the config declares it (§11.6)", () => {
      expect(canRatify(admin.role)).toBe(true);
      expect(canRatify(analyst.role)).toBe(false);
      expect(canRatify(researcher.role)).toBe(false);
      expect(canRatify(null)).toBe(false);
    });

    it("resolves an unknown role to a deny-all guest", () => {
      const unknown = resolveAccess(config, "human:x", "nonexistent");
      expect(unknown.role).toBeNull();
      expect(canRead(unknown.role, "competitive-intel")).toBe(false);
      expect(canWrite(unknown.role, "competitive-intel")).toBe(false);
      expect(canPromote(unknown.role)).toBe(false);
      expect(hasAnyRead(unknown.role)).toBe(false);
    });

    it("denies everything for the guest access context", () => {
      const guest = guestAccess();
      expect(guest.role).toBeNull();
      expect(canRead(guest.role, "pricing")).toBe(false);
      expect(hasAnyRead(guest.role)).toBe(false);
    });
  });

  describe("filterByReadPermission", () => {
    it("keeps only items in collections the role may read", () => {
      const items = [
        { collection: "competitive-intel", path: "a" },
        { collection: "pricing", path: "b" },
        { collection: "moonshot", path: "c" },
      ];
      expect(filterByReadPermission(analyst.role, items).map((i) => i.path)).toEqual(["a", "b"]);
      expect(filterByReadPermission(admin.role, items)).toHaveLength(3);
      expect(filterByReadPermission(guestAccess().role, items)).toEqual([]);
    });
  });

  describe("vault_index scoped by role", () => {
    it("shows the analyst competitive-intel and pricing only", async () => {
      const result = await vaultIndex(SAMPLE, {}, analyst);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const collections = new Set(result.value.entries.map((e) => e.collection));
      expect([...collections].sort()).toEqual(["competitive-intel", "pricing"]);
      expect(result.value.count).toBe(8);
    });

    it("shows the researcher moonshot but not _drafts", async () => {
      const result = await vaultIndex(SAMPLE, {}, researcher);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const collections = new Set(result.value.entries.map((e) => e.collection));
      expect(collections.has("moonshot")).toBe(true);
      expect(collections.has("_drafts")).toBe(false);
    });

    it("shows the admin every document", async () => {
      const result = await vaultIndex(SAMPLE, {}, admin);
      expect(result.ok && result.value.count).toBe(10);
    });

    it("shows the guest nothing", async () => {
      const result = await vaultIndex(SAMPLE, {}, guestAccess());
      expect(result.ok && result.value.count).toBe(0);
    });
  });

  describe("vault_search scoped by role", () => {
    let vault: string;

    beforeAll(async () => {
      vault = makeTempVault();
      const reindexed = await vaultReindex(vault);
      if (!reindexed.ok) throw reindexed.error;
    }, 60_000);

    afterAll(() => {
      cleanupVault(vault);
    });

    it("excludes moonshot hits from the analyst's search", async () => {
      const result = await vaultSearch(vault, { query: "fully agentic ETL moonshot" }, analyst);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.every((h) => h.collection !== "moonshot")).toBe(true);
      expect(result.value.hits.map((h) => h.path)).not.toContain(MOONSHOT_DOC);
    }, 60_000);

    it("includes the moonshot draft in the admin's search", async () => {
      const result = await vaultSearch(vault, { query: "fully agentic ETL moonshot" }, admin);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.map((h) => h.path)).toContain(MOONSHOT_DOC);
    }, 60_000);
  });
});
