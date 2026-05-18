import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordProvenance } from "../../src/curation/provenance.js";
import { addTension } from "../../src/curation/tension.js";
import {
  readTools,
  type VaultIndexResult,
  vaultIndex,
  vaultRead,
  vaultStatus,
} from "../../src/tools/read.js";
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

  it("returns a version token equal to the SHA-256 of the raw file bytes", async () => {
    const relPath = "competitive-intel/aurora-pipelines-vs-helios-connect.md";
    const result = await vaultRead(VAULT, relPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Hash the file independently — frontmatter included, exactly as on disk.
    const raw = readFileSync(join(VAULT, relPath), "utf-8");
    const expected = createHash("sha256").update(raw, "utf-8").digest("hex");
    expect(result.value.version).toBe(expected);
    expect(result.value.version).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// vaultRead — inline decay surfacing
// Uses a dedicated temp dir so the sample-vault file count stays at 10.
// ---------------------------------------------------------------------------

const HEALTHY_FRONTMATTER = `---
title: "Healthy Document"
domain: accumulation
collection: docs
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-05-01
updated_by: agent:test
provenance: direct
sources: []
superseded_by: null
ttl_days: null
tags: []
---

Body content here.
`;

// updated far in the past + short TTL → always past TTL regardless of wall clock.
const WARN_FRONTMATTER = `---
title: "Stale Document"
domain: accumulation
collection: docs
status: canonical
confidence: high
created: 2020-01-01
updated: 2020-01-01
updated_by: agent:test
provenance: direct
sources: []
superseded_by: null
ttl_days: 1
tags: []
---

Body content here.
`;

describe("vaultRead — decay state", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns decay: null for a healthy document", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "daftari-read-decay-"));
    writeFileSync(join(tempDir, "healthy.md"), HEALTHY_FRONTMATTER, "utf-8");

    const result = await vaultRead(tempDir, "healthy.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decay).toBeNull();
  });

  it("returns decay.level === 'warn' and a non-null banner for a stale document", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "daftari-read-decay-"));
    writeFileSync(join(tempDir, "stale.md"), WARN_FRONTMATTER, "utf-8");

    const result = await vaultRead(tempDir, "stale.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decay).not.toBeNull();
    expect(result.value.decay?.level).toBe("warn");
    expect(result.value.decay?.banner).not.toBeNull();
  });

  it("never embeds the banner inside content — content is byte-identical to the written body", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "daftari-read-decay-"));
    writeFileSync(join(tempDir, "stale.md"), WARN_FRONTMATTER, "utf-8");

    const result = await vaultRead(tempDir, "stale.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The body after frontmatter stripping should be exactly what we wrote.
    expect(result.value.content.trim()).toBe("Body content here.");
    // And the banner must not appear inside content.
    expect(result.value.content).not.toContain("STALE");
    expect(result.value.content).not.toContain("⚠");
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

// ---------------------------------------------------------------------------
// vaultIndex — questions_answered / questions_raised
// ---------------------------------------------------------------------------

function questionsDoc(opts: { answered: string[]; raised: string[] }): string {
  const yamlList = (xs: string[]) =>
    xs.length === 0 ? " []" : `\n${xs.map((x) => `  - "${x}"`).join("\n")}`;
  return `---
title: "Q Doc"
domain: accumulation
collection: docs
status: canonical
confidence: high
created: 2026-01-01
updated: 2026-05-01
updated_by: agent:test
provenance: direct
sources: []
superseded_by: null
ttl_days: null
tags: []
questions_answered:${yamlList(opts.answered)}
questions_raised:${yamlList(opts.raised)}
---

Body.
`;
}

describe("vaultIndex — questions fields", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("exposes each document's questions and filters by has_unanswered", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "daftari-index-q-"));
    writeFileSync(
      join(tempDir, "open.md"),
      questionsDoc({ answered: ["settled?"], raised: ["still open?"] }),
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "closed.md"),
      questionsDoc({ answered: ["all done?"], raised: [] }),
      "utf-8",
    );

    const all = await vaultIndex(tempDir);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const open = all.value.entries.find((e) => e.path === "open.md");
    expect(open?.questionsRaised).toEqual(["still open?"]);
    expect(open?.questionsAnswered).toEqual(["settled?"]);

    const unanswered = await vaultIndex(tempDir, { hasUnanswered: true });
    expect(unanswered.ok).toBe(true);
    if (!unanswered.ok) return;
    expect(unanswered.value.entries.map((e) => e.path)).toEqual(["open.md"]);

    const answered = await vaultIndex(tempDir, { hasUnanswered: false });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect(answered.value.entries.map((e) => e.path)).toEqual(["closed.md"]);
  });

  it("maps the has_unanswered tool argument through the vault_index handler", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "daftari-index-q-"));
    writeFileSync(
      join(tempDir, "open.md"),
      questionsDoc({ answered: [], raised: ["still open?"] }),
      "utf-8",
    );
    writeFileSync(
      join(tempDir, "closed.md"),
      questionsDoc({ answered: ["done?"], raised: [] }),
      "utf-8",
    );

    const indexTool = readTools.find((t) => t.name === "vault_index");
    expect(indexTool).toBeDefined();
    if (!indexTool) return;

    // The boolean arg must reach the filter.
    const unanswered = await indexTool.handler(tempDir, { has_unanswered: true });
    expect(unanswered.ok).toBe(true);
    if (!unanswered.ok) return;
    expect((unanswered.value as VaultIndexResult).entries.map((e) => e.path)).toEqual(["open.md"]);

    const answered = await indexTool.handler(tempDir, { has_unanswered: false });
    expect(answered.ok).toBe(true);
    if (!answered.ok) return;
    expect((answered.value as VaultIndexResult).entries.map((e) => e.path)).toEqual(["closed.md"]);

    // A non-boolean / absent arg must be ignored, not coerced — all docs returned.
    const noFilter = await indexTool.handler(tempDir, {});
    expect(noFilter.ok).toBe(true);
    if (!noFilter.ok) return;
    expect((noFilter.value as VaultIndexResult).count).toBe(2);
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
