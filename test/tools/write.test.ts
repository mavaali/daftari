import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  vaultAppend,
  vaultDeprecate,
  vaultPromote,
  vaultWrite,
} from "../../src/tools/write.js";
import { vaultRead } from "../../src/tools/read.js";
import { acquireLock, openLockDb, releaseLock } from "../../src/access/locks.js";
import { log } from "../../src/utils/git.js";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:claude-code";
const TODAY = new Date().toISOString().slice(0, 10);

// A complete, valid frontmatter block for a brand-new document.
function newFrontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Serverless Cost Notes",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-05-01",
    updated: "2026-05-01",
    updated_by: "agent:seed",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: ["pricing", "serverless"],
    ...overrides,
  };
}

describe("write tools", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  describe("vault_write", () => {
    it("creates a new document, commits it, and logs provenance", async () => {
      const result = await vaultWrite(vault, {
        path: "pricing/new-note.md",
        body: "# Serverless Cost Notes\n\nFresh content.\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.action).toBe("create");
      expect(result.value.commit).toMatch(/^[0-9a-f]+$/);

      // The file is on disk with server-stamped updated / updated_by.
      const read = await vaultRead(vault, "pricing/new-note.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.content).toContain("Fresh content.");
      expect(read.value.frontmatter.updated).toBe(TODAY);
      expect(read.value.frontmatter.updated_by).toBe(AGENT);

      // The auto-commit names the tool and the agent.
      const history = await log(vault, { path: "pricing/new-note.md" });
      expect(history.ok).toBe(true);
      if (!history.ok) return;
      expect(history.value[0]?.subject).toContain("vault_write");
      expect(history.value[0]?.subject).toContain(AGENT);

      // Provenance records the create.
      const prov = await readProvenanceLog(vault);
      expect(prov.ok).toBe(true);
      if (!prov.ok) return;
      const entry = prov.value.find(
        (e) => e.file === "pricing/new-note.md" && e.action === "create",
      );
      expect(entry?.tool).toBe("vault_write");
      expect(entry?.frontmatter_diff?.title?.after).toBe(
        "Serverless Cost Notes",
      );
    }, 60_000);

    it("updates an existing document and preserves its created date", async () => {
      await vaultWrite(vault, {
        path: "pricing/new-note.md",
        body: "v1\n",
        frontmatter: newFrontmatter({ created: "2026-05-01" }),
        agent: AGENT,
      });
      const update = await vaultWrite(vault, {
        path: "pricing/new-note.md",
        body: "v2 content\n",
        // Caller passes a different created date — it must be ignored.
        frontmatter: newFrontmatter({ created: "2099-12-31" }),
        agent: AGENT,
      });
      expect(update.ok).toBe(true);
      if (!update.ok) return;
      expect(update.value.action).toBe("update");

      const read = await vaultRead(vault, "pricing/new-note.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.content).toContain("v2 content");
      expect(read.value.frontmatter.created).toBe("2026-05-01");
    }, 60_000);

    it("rejects invalid frontmatter without writing", async () => {
      const result = await vaultWrite(vault, {
        path: "pricing/bad.md",
        body: "body\n",
        frontmatter: newFrontmatter({ title: "", domain: "nonsense" }),
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("invalid frontmatter");

      const read = await vaultRead(vault, "pricing/bad.md");
      expect(read.ok).toBe(false);
    });
  });

  describe("vault_append", () => {
    it("appends a section and re-stamps updated metadata", async () => {
      const result = await vaultAppend(vault, {
        path: "_drafts/moonshot-agentic-etl.md",
        section: "## New Section\n\nAppended body.",
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.action).toBe("append");

      const read = await vaultRead(vault, "_drafts/moonshot-agentic-etl.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.content).toContain("Appended body.");
      expect(read.value.content).toContain("Speculative sketch");
      expect(read.value.frontmatter.updated).toBe(TODAY);
      expect(read.value.frontmatter.updated_by).toBe(AGENT);

      const history = await log(vault, {
        path: "_drafts/moonshot-agentic-etl.md",
      });
      expect(history.ok && history.value[0]?.subject).toContain("vault_append");
    }, 60_000);

    it("rejects an append to a non-existent document", async () => {
      const result = await vaultAppend(vault, {
        path: "pricing/ghost.md",
        section: "nothing",
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("not found");
    });
  });

  describe("vault_promote", () => {
    it("promotes a complete draft to canonical", async () => {
      const result = await vaultPromote(vault, {
        path: "_drafts/moonshot-agentic-etl.md",
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.action).toBe("promote");
      expect(result.value.status).toBe("canonical");

      const read = await vaultRead(vault, "_drafts/moonshot-agentic-etl.md");
      expect(read.ok && read.value.frontmatter.status).toBe("canonical");

      const history = await log(vault, {
        path: "_drafts/moonshot-agentic-etl.md",
      });
      expect(history.ok && history.value[0]?.subject).toContain(
        "draft→canonical",
      );
    }, 60_000);

    it("refuses to promote a document that is not a draft", async () => {
      const result = await vaultPromote(vault, {
        path: "competitive-intel/snowflake-cortex-positioning.md",
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("only draft");
    });

    it("refuses to promote a document with incomplete frontmatter", async () => {
      const result = await vaultPromote(vault, {
        path: "_drafts/incomplete-note.md",
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("incomplete");
    });
  });

  describe("vault_deprecate", () => {
    it("deprecates a document and records reason + superseded_by", async () => {
      const result = await vaultDeprecate(vault, {
        path: "pricing/fabric-capacity-skus.md",
        reason: "Replaced by the 2026 capacity refresh",
        superseded_by: "pricing/fabric-capacity-skus-2026.md",
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.action).toBe("deprecate");
      expect(result.value.status).toBe("deprecated");

      const read = await vaultRead(vault, "pricing/fabric-capacity-skus.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.frontmatter.status).toBe("deprecated");
      expect(read.value.frontmatter.superseded_by).toBe(
        "pricing/fabric-capacity-skus-2026.md",
      );

      // The reason is captured in the auto-commit message.
      const history = await log(vault, {
        path: "pricing/fabric-capacity-skus.md",
      });
      expect(history.ok).toBe(true);
      if (!history.ok) return;
      expect(history.value[0]?.subject).toContain(
        "Replaced by the 2026 capacity refresh",
      );
    }, 60_000);

    it("deprecates without a superseded_by when none is given", async () => {
      const result = await vaultDeprecate(vault, {
        path: "pricing/fabric-capacity-skus.md",
        reason: "Stale, no replacement yet",
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const read = await vaultRead(vault, "pricing/fabric-capacity-skus.md");
      expect(read.ok && read.value.frontmatter.superseded_by).toBeNull();
    }, 60_000);

    it("requires a reason", async () => {
      const result = await vaultDeprecate(vault, {
        path: "pricing/fabric-capacity-skus.md",
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("lock contention", () => {
    it("blocks a write while another holder owns the file lock", async () => {
      // A separate connection holds the lock — simulating a concurrent writer.
      const lockDbResult = openLockDb(vault);
      expect(lockDbResult.ok).toBe(true);
      if (!lockDbResult.ok) return;
      const lockDb = lockDbResult.value;
      const held = acquireLock(lockDb, "pricing/contended.md", "agent:other");
      expect(held.ok).toBe(true);

      // The second write must fail cleanly rather than corrupt the file.
      const blocked = await vaultWrite(vault, {
        path: "pricing/contended.md",
        body: "body\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
      });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.error.message).toContain("locked");

      // Once the lock is released the same write succeeds.
      releaseLock(lockDb, "pricing/contended.md", "agent:other");
      lockDb.close();

      const allowed = await vaultWrite(vault, {
        path: "pricing/contended.md",
        body: "body\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
      });
      expect(allowed.ok).toBe(true);
    }, 60_000);

    it("serializes two concurrent writes without corruption", async () => {
      const writeOnce = (agent: string) =>
        vaultWrite(vault, {
          path: "pricing/race.md",
          body: `written by ${agent}\n`,
          frontmatter: newFrontmatter(),
          agent,
        });
      const results = await Promise.all([
        writeOnce("agent:a"),
        writeOnce("agent:b"),
      ]);

      // At least one write lands; any write that loses the race fails cleanly
      // with a lock error rather than throwing or producing a partial file.
      const ok = results.filter((r) => r.ok);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        if (!r.ok) expect(r.error.message).toContain("locked");
      }

      const read = await vaultRead(vault, "pricing/race.md");
      expect(read.ok).toBe(true);
    }, 60_000);
  });
});
