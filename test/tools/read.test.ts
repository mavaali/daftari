import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { vaultIndex, vaultRead, vaultStatus } from "../../src/tools/read.js";

const VAULT = resolve("test/fixtures/sample-vault");

describe("vaultRead", () => {
  it("reads a document and returns body + parsed frontmatter", async () => {
    const result = await vaultRead(
      VAULT,
      "competitive-intel/databricks-lakeflow-vs-data-factory.md",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.title).toBe(
      "Databricks Lakeflow vs Data Factory",
    );
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
    expect(result.value.entries[0]?.path).toBe(
      "_drafts/moonshot-agentic-etl.md",
    );
  });

  it("filters by tags conjunctively", async () => {
    const result = await vaultIndex(VAULT, { tags: ["databricks"] });
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
    const counts = Object.fromEntries(
      result.value.collections.map((c) => [c.collection, c.count]),
    );
    expect(counts["competitive-intel"]).toBe(4);
    expect(counts["pricing"]).toBe(4);
    expect(counts["moonshot"]).toBe(1);
  });

  it("reports the count of documents with invalid frontmatter", async () => {
    const result = await vaultStatus(VAULT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.invalidCount).toBe(1);
  });

  it("documents the phase-deferred sections", async () => {
    const result = await vaultStatus(VAULT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deferred.stalenessDistribution).toContain("Phase 4");
    expect(result.value.deferred.recentWrites).toContain("Phase 3");
  });
});
