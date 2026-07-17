// #141 — tier write-protection: `source` bodies are immutable, `manual`
// bodies require a human:* identity, unset/`compiled` are unenforced. The
// escape hatch is demote-then-write via vault_set_tier, never an inline flag.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultMerge, vaultSetTier, vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:claude-code";
const HUMAN = "human:mihir";

const BODY = "# Ingested Article\n\nOriginal source text.\n";

function seed(vault: string, relPath: string, fields: Record<string, string>, body = BODY): void {
  const lines = Object.entries(fields)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const abs = join(vault, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    `---\ntitle: Seeded Doc\ndomain: accumulation\ncollection: pricing\n` +
      `status: canonical\nconfidence: high\ncreated: 2026-05-01\nupdated: 2026-05-01\n` +
      `updated_by: human:mihir\nprovenance: direct\n${lines}\n---\n\n${body}`,
  );
}

describe("tier write-protection (#141)", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  describe("vault_write on tier: source", () => {
    it("refuses a body-changing update, naming the escape hatch", async () => {
      seed(vault, "pricing/ingested.md", { tier: "source" });
      const result = await vaultWrite(vault, {
        path: "pricing/ingested.md",
        body: "# Ingested Article\n\nAgent-improved text.\n",
        frontmatter: {},
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("tier 'source'");
      expect(result.error.message).toContain("vault_set_tier");
    });

    it("refuses a body-changing update even from a human identity", async () => {
      seed(vault, "pricing/ingested.md", { tier: "source" });
      const result = await vaultWrite(vault, {
        path: "pricing/ingested.md",
        body: "# Ingested Article\n\nHand-corrected text.\n",
        frontmatter: {},
        agent: HUMAN,
      });
      expect(result.ok).toBe(false);
    });

    it("allows a frontmatter-only update with the body unchanged", async () => {
      seed(vault, "pricing/ingested.md", { tier: "source" });
      const result = await vaultWrite(vault, {
        path: "pricing/ingested.md",
        body: BODY,
        frontmatter: { tags: ["ingested"] },
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
    }, 60_000);
  });

  describe("vault_write on tier: manual", () => {
    it("refuses a body rewrite from an agent identity", async () => {
      seed(vault, "pricing/handbook.md", { tier: "manual" });
      const result = await vaultWrite(vault, {
        path: "pricing/handbook.md",
        body: "# Rewritten by compilation pass\n",
        frontmatter: {},
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("tier 'manual'");
      expect(result.error.message).toContain("human:");
    });

    it("allows a body rewrite from a human identity", async () => {
      seed(vault, "pricing/handbook.md", { tier: "manual" });
      const result = await vaultWrite(vault, {
        path: "pricing/handbook.md",
        body: "# Rewritten by the author\n",
        frontmatter: {},
        agent: HUMAN,
      });
      expect(result.ok).toBe(true);
    }, 60_000);
  });

  describe("vault_write on unset / compiled tier", () => {
    it("leaves an untiered doc's body freely rewritable (pre-#141 behavior)", async () => {
      seed(vault, "pricing/notes.md", {});
      const result = await vaultWrite(vault, {
        path: "pricing/notes.md",
        body: "# Fully rewritten\n",
        frontmatter: {},
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
    }, 60_000);

    it("leaves a compiled doc's body freely rewritable", async () => {
      seed(vault, "pricing/synthesis.md", { tier: "compiled" });
      const result = await vaultWrite(vault, {
        path: "pricing/synthesis.md",
        body: "# Regenerated synthesis\n",
        frontmatter: {},
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
    }, 60_000);
  });

  describe("vault_write cannot re-tier a protected doc (no set_tier bypass)", () => {
    it("refuses an agent frontmatter-only write that demotes tier: source", async () => {
      seed(vault, "pricing/ingested.md", { tier: "source" });
      const result = await vaultWrite(vault, {
        path: "pricing/ingested.md",
        body: BODY,
        frontmatter: { tier: "compiled" },
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("vault_set_tier");
    });

    it("refuses an agent frontmatter-only write that clears tier: manual", async () => {
      seed(vault, "pricing/handbook.md", { tier: "manual" });
      const result = await vaultWrite(vault, {
        path: "pricing/handbook.md",
        body: BODY,
        frontmatter: { tier: null },
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
    });

    it("allows a protected-doc write that leaves the tier alone", async () => {
      seed(vault, "pricing/ingested.md", { tier: "source" });
      const result = await vaultWrite(vault, {
        path: "pricing/ingested.md",
        body: BODY,
        frontmatter: { tags: ["kept"] },
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
    }, 60_000);
  });

  describe("vault_set_tier", () => {
    it("tags an untiered doc, stamps the diff into provenance", async () => {
      seed(vault, "pricing/notes.md", {});
      const result = await vaultSetTier(vault, {
        path: "pricing/notes.md",
        tier: "source",
        reason: "ingested verbatim from the vendor blog",
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.action).toBe("tier-set");

      const read = await vaultRead(vault, "pricing/notes.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.raw.tier).toBe("source");

      const logEntries = await readProvenanceLog(vault);
      expect(logEntries.ok).toBe(true);
      if (!logEntries.ok) return;
      const last = logEntries.value.at(-1);
      expect(last?.tool).toBe("vault_set_tier");
      expect(last?.frontmatter_diff?.tier).toEqual({ before: null, after: "source" });
    }, 60_000);

    it("requires a reason", async () => {
      seed(vault, "pricing/notes.md", { tier: "source" });
      const result = await vaultSetTier(vault, {
        path: "pricing/notes.md",
        tier: "compiled",
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
    });

    it("rejects an unknown tier value", async () => {
      seed(vault, "pricing/notes.md", {});
      const result = await vaultSetTier(vault, {
        path: "pricing/notes.md",
        tier: "raw",
        reason: "x",
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
    });

    it("rejects a no-op (tier already at the target)", async () => {
      seed(vault, "pricing/notes.md", { tier: "source" });
      const result = await vaultSetTier(vault, {
        path: "pricing/notes.md",
        tier: "source",
        reason: "x",
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("already");
    });

    it("demote-then-write: the escape hatch works end-to-end for an agent", async () => {
      seed(vault, "pricing/ingested.md", { tier: "source" });
      const demote = await vaultSetTier(vault, {
        path: "pricing/ingested.md",
        tier: "compiled",
        reason: "re-ingesting the corrected copy of the article",
        agent: AGENT,
      });
      expect(demote.ok).toBe(true);

      const rewrite = await vaultWrite(vault, {
        path: "pricing/ingested.md",
        body: "# Ingested Article\n\nCorrected text.\n",
        frontmatter: {},
        agent: AGENT,
      });
      expect(rewrite.ok).toBe(true);
    }, 60_000);

    it("refuses an agent moving a doc away from tier: manual, allows a human", async () => {
      seed(vault, "pricing/handbook.md", { tier: "manual" });
      const denied = await vaultSetTier(vault, {
        path: "pricing/handbook.md",
        tier: "compiled",
        reason: "x",
        agent: AGENT,
      });
      expect(denied.ok).toBe(false);
      if (denied.ok) return;
      expect(denied.error.message).toContain("human:");

      const allowed = await vaultSetTier(vault, {
        path: "pricing/handbook.md",
        tier: "compiled",
        reason: "opening the handbook to agent maintenance",
        agent: HUMAN,
      });
      expect(allowed.ok).toBe(true);
    }, 60_000);

    it("lets an agent ADD manual protection to an untiered doc", async () => {
      seed(vault, "pricing/notes.md", {});
      const result = await vaultSetTier(vault, {
        path: "pricing/notes.md",
        tier: "manual",
        reason: "human-authored canon, protecting it",
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
    }, 60_000);
  });

  describe("vault_merge tier guard on the target", () => {
    it("refuses a merge whose target is tier: source", async () => {
      seed(vault, "pricing/a.md", {}, "# A\n");
      seed(vault, "pricing/b.md", {}, "# B\n");
      seed(vault, "pricing/target.md", { tier: "source" });
      const result = await vaultMerge(vault, {
        path_a: "pricing/a.md",
        path_b: "pricing/b.md",
        target_path: "pricing/target.md",
        body: "# Merged\n",
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("tier 'source'");
    });

    it("refuses an agent merge whose target is tier: manual, allows a human one", async () => {
      seed(vault, "pricing/a.md", {}, "# A\n");
      seed(vault, "pricing/b.md", {}, "# B\n");
      seed(vault, "pricing/target.md", { tier: "manual" });
      const denied = await vaultMerge(vault, {
        path_a: "pricing/a.md",
        path_b: "pricing/b.md",
        target_path: "pricing/target.md",
        body: "# Merged\n",
        agent: AGENT,
      });
      expect(denied.ok).toBe(false);

      const allowed = await vaultMerge(vault, {
        path_a: "pricing/a.md",
        path_b: "pricing/b.md",
        target_path: "pricing/target.md",
        body: "# Merged\n",
        agent: HUMAN,
      });
      expect(allowed.ok).toBe(true);
    }, 60_000);

    it("merging INTO a source doc's collection with an untiered target still works", async () => {
      seed(vault, "pricing/a.md", { tier: "source" }, "# A\n");
      seed(vault, "pricing/b.md", {}, "# B\n");
      const result = await vaultMerge(vault, {
        path_a: "pricing/a.md",
        path_b: "pricing/b.md",
        target_path: "pricing/merged.md",
        body: "# Merged\n",
        agent: AGENT,
      });
      // path_a is tier:source but only gets a frontmatter-level supersede —
      // its body is untouched, so the merge is allowed.
      expect(result.ok).toBe(true);
    }, 60_000);
  });
});
