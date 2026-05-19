import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, openLockDb, releaseLock } from "../../src/access/locks.js";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { getDocument, openIndexDb } from "../../src/storage/index-db.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultAppend, vaultDeprecate, vaultPromote, vaultWrite } from "../../src/tools/write.js";
import { configPath } from "../../src/utils/config.js";
import { log } from "../../src/utils/git.js";
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
      expect(entry?.frontmatter_diff?.title?.after).toBe("Serverless Cost Notes");
    }, 60_000);

    it("round-trips the questions_answered / questions_raised fields", async () => {
      const result = await vaultWrite(vault, {
        path: "pricing/questions-note.md",
        body: "# Notes\n\nBody.\n",
        frontmatter: newFrontmatter({
          questions_answered: ["What is the billing unit?"],
          questions_raised: ["Is spend predictable?"],
        }),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const read = await vaultRead(vault, "pricing/questions-note.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.frontmatter.questions_answered).toEqual(["What is the billing unit?"]);
      expect(read.value.frontmatter.questions_raised).toEqual(["Is spend predictable?"]);
      expect(read.value.validation.valid).toBe(true);
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
      expect(history.ok && history.value[0]?.subject).toContain("draft→canonical");
    }, 60_000);

    it("refuses to promote a document that is not a draft", async () => {
      const result = await vaultPromote(vault, {
        path: "competitive-intel/vega-insight-positioning.md",
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
        path: "pricing/cirrus-capacity-tiers.md",
        reason: "Replaced by the 2026 capacity refresh",
        superseded_by: "pricing/cirrus-capacity-tiers-2026.md",
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.action).toBe("deprecate");
      expect(result.value.status).toBe("deprecated");

      const read = await vaultRead(vault, "pricing/cirrus-capacity-tiers.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.frontmatter.status).toBe("deprecated");
      expect(read.value.frontmatter.superseded_by).toBe("pricing/cirrus-capacity-tiers-2026.md");

      // The reason is captured in the auto-commit message.
      const history = await log(vault, {
        path: "pricing/cirrus-capacity-tiers.md",
      });
      expect(history.ok).toBe(true);
      if (!history.ok) return;
      expect(history.value[0]?.subject).toContain("Replaced by the 2026 capacity refresh");
    }, 60_000);

    it("deprecates without a superseded_by when none is given", async () => {
      const result = await vaultDeprecate(vault, {
        path: "pricing/cirrus-capacity-tiers.md",
        reason: "Stale, no replacement yet",
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const read = await vaultRead(vault, "pricing/cirrus-capacity-tiers.md");
      expect(read.ok && read.value.frontmatter.superseded_by).toBeNull();
    }, 60_000);

    it("requires a reason", async () => {
      const result = await vaultDeprecate(vault, {
        path: "pricing/cirrus-capacity-tiers.md",
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
      const results = await Promise.all([writeOnce("agent:a"), writeOnce("agent:b")]);

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

  // -------------------------------------------------------------------------
  // optimistic concurrency — base_version
  // -------------------------------------------------------------------------

  describe("optimistic concurrency", () => {
    // The `version` token vault_read returns for a file currently on disk.
    async function versionOf(vaultRoot: string, path: string): Promise<string> {
      const read = await vaultRead(vaultRoot, path);
      if (!read.ok) throw new Error(`could not read ${path}: ${read.error.message}`);
      return read.value.version;
    }

    // Count provenance lines for a file whose action is "rejected_stale".
    async function rejectedStaleCount(vaultRoot: string, file: string): Promise<number> {
      const prov = await readProvenanceLog(vaultRoot);
      if (!prov.ok) throw new Error(prov.error.message);
      return prov.value.filter((e) => e.file === file && e.action === "rejected_stale").length;
    }

    it("accepts a vault_write whose base_version matches the file on disk", async () => {
      await vaultWrite(vault, {
        path: "pricing/oc-note.md",
        body: "v1\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
      });
      const version = await versionOf(vault, "pricing/oc-note.md");

      const update = await vaultWrite(vault, {
        path: "pricing/oc-note.md",
        body: "v2 content\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
        base_version: version,
      });
      expect(update.ok).toBe(true);
      if (!update.ok) return;
      // Committed.
      expect(update.value.commit).toMatch(/^[0-9a-f]+$/);
      // Indexed — the new content is searchable.
      expect(update.value.indexUpdated).toBe(true);
      const dbResult = openIndexDb(vault);
      expect(dbResult.ok).toBe(true);
      if (!dbResult.ok) return;
      const doc = getDocument(dbResult.value, "pricing/oc-note.md");
      dbResult.value.close();
      expect(doc?.content).toContain("v2 content");
    }, 60_000);

    it("rejects a vault_write whose base_version is stale, leaving everything untouched", async () => {
      const path = "pricing/oc-stale.md";
      const absPath = join(vault, path);

      await vaultWrite(vault, {
        path,
        body: "v1\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
      });
      // The caller composed against v1.
      const staleVersion = await versionOf(vault, path);

      // Another agent updates the file — the caller's version is now stale.
      await vaultWrite(vault, {
        path,
        body: "v2 by other agent\n",
        frontmatter: newFrontmatter(),
        agent: "agent:other",
      });

      const bytesBefore = readFileSync(absPath);
      const commitsBefore = await log(vault, { path });
      expect(commitsBefore.ok).toBe(true);
      if (!commitsBefore.ok) return;

      const result = await vaultWrite(vault, {
        path,
        body: "v3 composed against stale v1\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
        base_version: staleVersion,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message.startsWith("stale write:")).toBe(true);

      // File byte-identical to before the rejected write.
      expect(readFileSync(absPath).equals(bytesBefore)).toBe(true);
      // No new git commit.
      const commitsAfter = await log(vault, { path });
      expect(commitsAfter.ok).toBe(true);
      if (!commitsAfter.ok) return;
      expect(commitsAfter.value.length).toBe(commitsBefore.value.length);
      // Index still holds the v2 content, not the rejected v3.
      const dbResult = openIndexDb(vault);
      expect(dbResult.ok).toBe(true);
      if (!dbResult.ok) return;
      const doc = getDocument(dbResult.value, path);
      dbResult.value.close();
      expect(doc?.content).toContain("v2 by other agent");
      expect(doc?.content).not.toContain("v3 composed against stale");
      // Exactly one rejected_stale provenance line.
      expect(await rejectedStaleCount(vault, path)).toBe(1);
    }, 60_000);

    it("ignores a stale file when no base_version is supplied (backward compat)", async () => {
      const path = "pricing/oc-nobase.md";
      await vaultWrite(vault, {
        path,
        body: "v1\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
      });
      // The file is modified out from under the caller.
      await vaultWrite(vault, {
        path,
        body: "v2 by other agent\n",
        frontmatter: newFrontmatter(),
        agent: "agent:other",
      });
      // A write with no base_version still lands — last-write-wins is preserved.
      const result = await vaultWrite(vault, {
        path,
        body: "v3 no base_version\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      const read = await vaultRead(vault, path);
      expect(read.ok && read.value.content).toContain("v3 no base_version");
    }, 60_000);

    it("rejects a vault_write to a non-existent path when base_version is provided", async () => {
      const path = "pricing/oc-ghost.md";
      const result = await vaultWrite(vault, {
        path,
        body: "body\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
        base_version: "0".repeat(64),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message.startsWith("stale write:")).toBe(true);
      // Nothing was written.
      expect(existsSync(join(vault, path))).toBe(false);
      // The rejection is recorded in provenance.
      expect(await rejectedStaleCount(vault, path)).toBe(1);
    }, 60_000);

    it("vault_append honors base_version", async () => {
      const path = "_drafts/moonshot-agentic-etl.md";
      const staleVersion = await versionOf(vault, path);

      // Another agent appends — the caller's version is now stale.
      await vaultAppend(vault, {
        path,
        section: "## Bumped\n\nBy another agent.",
        agent: "agent:other",
      });

      const stale = await vaultAppend(vault, {
        path,
        section: "## Stale append",
        agent: AGENT,
        base_version: staleVersion,
      });
      expect(stale.ok).toBe(false);
      if (stale.ok) return;
      expect(stale.error.message.startsWith("stale write:")).toBe(true);

      // With the current version the append lands.
      const fresh = await vaultAppend(vault, {
        path,
        section: "## Fresh append\n\nAgainst current version.",
        agent: AGENT,
        base_version: await versionOf(vault, path),
      });
      expect(fresh.ok).toBe(true);
      const read = await vaultRead(vault, path);
      expect(read.ok && read.value.content).toContain("Fresh append");
    }, 60_000);

    it("vault_promote honors base_version", async () => {
      const path = "_drafts/moonshot-agentic-etl.md";
      const staleVersion = await versionOf(vault, path);

      // An append bumps the file (status stays draft, still promotable).
      await vaultAppend(vault, {
        path,
        section: "## Note\n\nBumped before promotion.",
        agent: "agent:other",
      });

      const stale = await vaultPromote(vault, {
        path,
        agent: AGENT,
        base_version: staleVersion,
      });
      expect(stale.ok).toBe(false);
      if (stale.ok) return;
      expect(stale.error.message.startsWith("stale write:")).toBe(true);

      const fresh = await vaultPromote(vault, {
        path,
        agent: AGENT,
        base_version: await versionOf(vault, path),
      });
      expect(fresh.ok).toBe(true);
      if (!fresh.ok) return;
      expect(fresh.value.status).toBe("canonical");
    }, 60_000);

    it("vault_deprecate honors base_version", async () => {
      const path = "pricing/cirrus-capacity-tiers.md";
      const staleVersion = await versionOf(vault, path);

      await vaultAppend(vault, {
        path,
        section: "## Note\n\nBumped before deprecation.",
        agent: "agent:other",
      });

      const stale = await vaultDeprecate(vault, {
        path,
        reason: "stale attempt",
        agent: AGENT,
        base_version: staleVersion,
      });
      expect(stale.ok).toBe(false);
      if (stale.ok) return;
      expect(stale.error.message.startsWith("stale write:")).toBe(true);

      const fresh = await vaultDeprecate(vault, {
        path,
        reason: "Replaced by the 2026 capacity refresh",
        agent: AGENT,
        base_version: await versionOf(vault, path),
      });
      expect(fresh.ok).toBe(true);
      if (!fresh.ok) return;
      expect(fresh.value.status).toBe("deprecated");
    }, 60_000);
  });

  // -------------------------------------------------------------------------
  // issue #14 regression — the A/B stale-write race
  //
  // A and B never hold the file lock at the same time, yet A's payload was
  // composed against a version B has since replaced. The lock alone cannot
  // catch this; the base_version check must.
  // -------------------------------------------------------------------------

  describe("issue #14 regression — A/B stale-write race", () => {
    it("rejects agent A's write composed against a version agent B has replaced", async () => {
      const path = "pricing/helios.md";

      // Seed the document.
      await vaultWrite(vault, {
        path,
        body: "# Helios\n\nInitial pricing notes.\n",
        frontmatter: newFrontmatter({ title: "Helios" }),
        agent: "agent:seed",
      });

      // 1. Agent A reads the file and captures the version it will compose against.
      const aRead = await vaultRead(vault, path);
      expect(aRead.ok).toBe(true);
      if (!aRead.ok) return;
      const aBaseVersion = aRead.value.version;

      // 2. Agent B reads, writes, and releases its lock. B passes no
      //    base_version, so B's write lands. A never held the lock while B did.
      const bWrite = await vaultWrite(vault, {
        path,
        body: "# Helios\n\nB's revised pricing notes.\n",
        frontmatter: newFrontmatter({ title: "Helios" }),
        agent: "agent:B",
      });
      expect(bWrite.ok).toBe(true);

      // 3. Agent A writes, declaring the version it composed against. Before
      //    issue #14 this silently clobbered B; it must now be rejected.
      const aWrite = await vaultWrite(vault, {
        path,
        body: "# Helios\n\nA's notes, composed against the pre-B version.\n",
        frontmatter: newFrontmatter({ title: "Helios" }),
        agent: "agent:A",
        base_version: aBaseVersion,
      });
      expect(aWrite.ok).toBe(false);
      if (aWrite.ok) return;
      expect(aWrite.error.message.startsWith("stale write:")).toBe(true);

      // B's work survives — A did not clobber it.
      const final = await vaultRead(vault, path);
      expect(final.ok).toBe(true);
      if (!final.ok) return;
      expect(final.value.content).toContain("B's revised pricing notes");
      expect(final.value.content).not.toContain("composed against the pre-B version");
    }, 60_000);
  });

  describe("schema extensions", () => {
    // The temp vault skips the .daftari control dir, so each test that needs
    // schema extensions writes its own config into the vault.
    const EXT_CONFIG = [
      "version: 1",
      "vault_name: sample-vault",
      "schema_extensions:",
      "  adr_id:",
      "    type: string",
      '    pattern: "^ADR-[0-9]+$"',
      "  decision_date:",
      "    type: date",
      "  stakeholders:",
      "    type: array",
      "    items: string",
      "  status_tag:",
      "    type: enum",
      "    enum: [proposed, accepted, rejected]",
      "    default: proposed",
      "",
    ].join("\n");

    beforeEach(() => {
      mkdirSync(`${vault}/.daftari`, { recursive: true });
      writeFileSync(configPath(vault), EXT_CONFIG);
    });

    it("writes declared extension fields and surfaces them on read", async () => {
      const result = await vaultWrite(vault, {
        path: "pricing/adr.md",
        body: "# ADR\n\nDecision body.\n",
        frontmatter: newFrontmatter({
          adr_id: "ADR-019",
          decision_date: "2026-04-10",
          stakeholders: ["platform", "data"],
        }),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const read = await vaultRead(vault, "pricing/adr.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // Extension fields surface in vault_read's raw (exactly-as-parsed) block.
      expect(read.value.raw.adr_id).toBe("ADR-019");
      expect(read.value.raw.stakeholders).toEqual(["platform", "data"]);
      expect(read.value.raw.decision_date).toBe("2026-04-10");
    });

    it("fills a missing extension field from its declared default", async () => {
      const result = await vaultWrite(vault, {
        path: "pricing/adr.md",
        body: "# ADR\n",
        frontmatter: newFrontmatter({ adr_id: "ADR-020" }),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);

      const read = await vaultRead(vault, "pricing/adr.md");
      expect(read.ok && read.value.raw.status_tag).toBe("proposed");
    });

    it("rejects a write whose extension field violates its declared type", async () => {
      const result = await vaultWrite(vault, {
        path: "pricing/adr.md",
        body: "# ADR\n",
        frontmatter: newFrontmatter({ adr_id: "not-an-adr-id" }),
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("invalid frontmatter");
      expect(result.error.message).toContain("adr_id");
    });

    it("preserves extension fields across an update and an append", async () => {
      await vaultWrite(vault, {
        path: "pricing/adr.md",
        body: "# ADR\n",
        frontmatter: newFrontmatter({
          adr_id: "ADR-021",
          stakeholders: ["platform"],
        }),
        agent: AGENT,
      });

      // Update: extension fields supplied again, must round-trip intact.
      await vaultWrite(vault, {
        path: "pricing/adr.md",
        body: "# ADR v2\n",
        frontmatter: newFrontmatter({
          adr_id: "ADR-021",
          stakeholders: ["platform", "security"],
        }),
        agent: AGENT,
      });

      // Append: frontmatter is untouched by the caller; extensions survive.
      const appended = await vaultAppend(vault, {
        path: "pricing/adr.md",
        section: "## Addendum\n\nMore detail.",
        agent: AGENT,
      });
      expect(appended.ok).toBe(true);

      const read = await vaultRead(vault, "pricing/adr.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.raw.adr_id).toBe("ADR-021");
      expect(read.value.raw.stakeholders).toEqual(["platform", "security"]);
      expect(read.value.raw.status_tag).toBe("proposed");
      expect(read.value.content).toContain("More detail.");
    });

    it("does not inject extension defaults when appending to a doc that lacks them", async () => {
      // A document that predates the schema_extensions block — no status_tag,
      // written straight to disk so vault_write's default-fill never runs.
      writeFileSync(
        `${vault}/pricing/legacy.md`,
        [
          "---",
          "title: Legacy ADR",
          "domain: accumulation",
          "collection: pricing",
          "status: draft",
          "confidence: low",
          "created: 2026-05-01",
          "updated: 2026-05-01",
          "updated_by: agent:seed",
          "provenance: direct",
          "sources: []",
          "superseded_by: null",
          "ttl_days: null",
          "tags: []",
          "---",
          "",
          "# Legacy ADR",
          "",
          "Body.",
          "",
        ].join("\n"),
      );

      const appended = await vaultAppend(vault, {
        path: "pricing/legacy.md",
        section: "## More\n\nAppended.",
        agent: AGENT,
      });
      expect(appended.ok).toBe(true);

      const read = await vaultRead(vault, "pricing/legacy.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // The default-bearing extension is not injected by an append.
      expect("status_tag" in read.value.raw).toBe(false);
      expect(read.value.content).toContain("Appended.");
    }, 60_000);
  });
});
