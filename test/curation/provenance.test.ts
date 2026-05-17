import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Frontmatter } from "../../src/frontmatter/types.js";
import {
  frontmatterDiff,
  readProvenanceLog,
  recordProvenance,
} from "../../src/curation/provenance.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const baseFrontmatter: Frontmatter = {
  title: "Foo",
  domain: "accumulation",
  collection: "pricing",
  status: "draft",
  confidence: "low",
  created: "2026-01-01",
  updated: "2026-01-01",
  updated_by: "agent:claude-code",
  provenance: "direct",
  sources: [],
  superseded_by: null,
  ttl_days: null,
  tags: [],
};

describe("provenance", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  describe("frontmatterDiff", () => {
    it("treats every field as changed when the document is new", () => {
      const diff = frontmatterDiff(null, baseFrontmatter);
      expect(diff.title).toEqual({ before: undefined, after: "Foo" });
      expect(Object.keys(diff)).toContain("status");
    });

    it("reports only the fields that changed", () => {
      const after: Frontmatter = { ...baseFrontmatter, status: "canonical" };
      const diff = frontmatterDiff(baseFrontmatter, after);
      expect(diff).toEqual({
        status: { before: "draft", after: "canonical" },
      });
    });

    it("returns an empty diff when nothing changed", () => {
      expect(frontmatterDiff(baseFrontmatter, { ...baseFrontmatter })).toEqual(
        {},
      );
    });
  });

  describe("recordProvenance / readProvenanceLog", () => {
    it("returns an empty log when nothing has been written", async () => {
      const log = await readProvenanceLog(vault);
      expect(log.ok && log.value).toEqual([]);
    });

    it("appends entries and reads them back in order", async () => {
      const first = await recordProvenance(vault, {
        tool: "vault_write",
        file: "pricing/a.md",
        agent: "agent:claude-code",
        action: "create",
      });
      expect(first.ok).toBe(true);
      if (first.ok) expect(first.value.timestamp).toBeTruthy();

      await recordProvenance(vault, {
        tool: "vault_promote",
        file: "pricing/a.md",
        agent: "human:mihir",
        action: "promote",
        frontmatter_diff: { status: { before: "draft", after: "canonical" } },
      });

      const log = await readProvenanceLog(vault);
      expect(log.ok).toBe(true);
      if (!log.ok) return;
      expect(log.value).toHaveLength(2);
      expect(log.value[0]?.action).toBe("create");
      expect(log.value[0]?.frontmatter_diff).toBeUndefined();
      expect(log.value[1]?.action).toBe("promote");
      expect(log.value[1]?.frontmatter_diff?.status?.after).toBe("canonical");
    });

    it("omits an empty frontmatter_diff from the recorded entry", async () => {
      const entry = await recordProvenance(vault, {
        tool: "vault_append",
        file: "pricing/a.md",
        agent: "agent:claude-code",
        action: "append",
        frontmatter_diff: {},
      });
      expect(entry.ok).toBe(true);
      if (entry.ok) expect(entry.value.frontmatter_diff).toBeUndefined();
    });
  });
});
