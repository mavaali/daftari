import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordProvenance } from "../../src/curation/provenance.js";
import { addTension } from "../../src/curation/tension.js";
import { vaultIndex, vaultRead, vaultStatus } from "../../src/tools/read.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const VAULT = resolve("test/fixtures/sample-vault");

describe("vaultRead", () => {
  it("reads a document and returns body + parsed frontmatter", async () => {
    const result = await vaultRead(
      VAULT,
      "competitive-intel/aurora-pipelines-vs-helios-connect.md",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.title).toBe("Aurora Pipelines vs Helios Connect");
    expect(result.value.frontmatter.status).toBe("canonical");
    expect(result.value.content).toContain("## Questions Answered");
    expect(result.value.validation.valid).toBe(true);
  });

  it("succeeds on a document with invalid frontmatter, flagging issues", async () => {
    const result = await vaultRead(VAULT, "_drafts/incomplete-note.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.valid).toBe(false);
    const fields = result.value.validation.issues.map((i) => i.field);
    expect(fields).toContain("domain");
    expect(fields).toContain("created");
  });

  it("rejects an empty path argument", async () => {
    const result = await vaultRead(VAULT, "");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("non-empty 'path'");
  });

  it("rejects path traversal", async () => {
    const result = await vaultRead(VAULT, "../../../etc/passwd");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("escapes vault root");
  });

  it("returns an error for a missing file", async () => {
    const result = await vaultRead(VAULT, "competitive-intel/missing.md");
    expect(result.ok).toBe(false);
  });
});

describe("vaultIndex", () => {
  it("lists every document in the vault", async () => {
    const result = await vaultIndex(VAULT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(10);
    expect(result.value.entries).toHaveLength(10);
  });

  it("filters by collection", async () => {
    const result = await vaultIndex(VAULT, { collection: "competitive-intel" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(4);
  });

  it("filters by status", async () => {
    const result = await vaultIndex(VAULT, { status: "canonical" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(6);
  });

  it("filters by domain", async () => {
    const result = await vaultIndex(VAULT, { domain: "generative" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(1);
    expect(result.value.entries[0]?.path).toBe("_drafts/moonshot-agentic-etl.md");
  });

  it("filters by tags conjunctively", async () => {
    const result = await vaultIndex(VAULT, { tags: ["helios"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.count).toBe(2);
  });

  it("marks documents with invalid frontmatter", async () => {
    const result = await vaultIndex(VAULT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const invalid = result.value.entries.filter((e) => !e.valid);
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.path).toBe("_drafts/incomplete-note.md");
  });
});

describe("vaultStatus", () => {
  it("reports file count and per-collection counts", async () => {
    const result = await vaultStatus(VAULT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fileCount).toBe(10);
    const counts = Object.fromEntries(result.value.collections.map((c) => [c.collection, c.count]));
    expect(counts["competitive-intel"]).toBe(4);
    expect(counts.pricing).toBe(4);
    expect(counts.moonshot).toBe(1);
  });

  it("reports the count of documents with invalid frontmatter", async () => {
    const result = await vaultStatus(VAULT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invalidCount).toBe(1);
  });

  it("buckets every file into a staleness distribution", async () => {
    const result = await vaultStatus(VAULT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const dist = result.value.stalenessDistribution;
    // Every scored file lands in exactly one bucket.
    expect(dist.total).toBe(result.value.fileCount);
    expect(dist.fresh + dist.aging + dist.stale).toBe(dist.total);
    // The fixture carries a long-expired document (competitive-intel/
    // cirrus-realtime-early-read.md, updated 2026-01-09, ttl 60).
    expect(dist.stale).toBeGreaterThanOrEqual(1);
  });

  it("reports empty tension/write sections for a pristine vault", async () => {
    const result = await vaultStatus(VAULT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.unresolvedTensions).toEqual({ count: 0, recent: [] });
    expect(result.value.recentWrites).toEqual({ count: 0, entries: [] });
  });

  describe("with a seeded curation log", () => {
    let vault: string;

    afterEach(() => {
      if (vault) cleanupVault(vault);
    });

    it("surfaces unresolved tensions, most recent first", async () => {
      vault = makeTempVault();
      await addTension(vault, {
        title: "Older tension",
        sourceA: "pricing/cirrus-capacity-tiers.md",
        claimA: "pooled capacity is billed whether used or not",
        sourceB: "pricing/serverless-cost-predictability.md",
        claimB: "serverless billing tracks actual consumption",
        loggedBy: "agent:claude-code",
        date: "2026-05-01",
      });
      await addTension(vault, {
        title: "Newer tension",
        sourceA: "competitive-intel/vega-insight-positioning.md",
        claimA: "Vega leads on LLM features",
        sourceB: "competitive-intel/aurora-pipelines-vs-helios-connect.md",
        claimB: "Aurora leads on integration breadth",
        loggedBy: "agent:claude-code",
        date: "2026-05-15",
      });

      const result = await vaultStatus(vault);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.unresolvedTensions.count).toBe(2);
      expect(result.value.unresolvedTensions.recent.map((t) => t.title)).toEqual([
        "Newer tension",
        "Older tension",
      ]);
    });

    it("surfaces the most recent provenance entries", async () => {
      vault = makeTempVault();
      await recordProvenance(vault, {
        timestamp: "2026-05-10T00:00:00.000Z",
        tool: "vault_write",
        file: "pricing/cirrus-capacity-tiers-2026.md",
        agent: "agent:claude-code",
        action: "create",
      });
      await recordProvenance(vault, {
        timestamp: "2026-05-12T00:00:00.000Z",
        tool: "vault_promote",
        file: "pricing/cirrus-capacity-tiers-2026.md",
        agent: "human:mihir",
        action: "promote",
      });

      const result = await vaultStatus(vault);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.recentWrites.count).toBe(2);
      expect(result.value.recentWrites.entries.map((e) => e.action)).toEqual(["create", "promote"]);
    });
  });
});
