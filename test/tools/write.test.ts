import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireLock, openLockDb, releaseLock } from "../../src/access/locks.js";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import type { Frontmatter } from "../../src/frontmatter/types.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { getDocument, openIndexDb } from "../../src/storage/index-db.js";
import { vaultRead } from "../../src/tools/read.js";
import {
  serializeDocument,
  vaultAppend,
  vaultDeprecate,
  vaultPromote,
  vaultWrite,
} from "../../src/tools/write.js";
import { configPath } from "../../src/utils/config.js";
import { isGitRepo, log } from "../../src/utils/git.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:claude-code";

// The write path stamps `new Date()` at write time (correct). Compare against a
// date computed at ASSERTION time — never frozen at module load — and tolerate
// the one-day window between the write and the read-back, so a run that crosses
// a UTC-midnight boundary mid-test does not flake. A date outside [today,
// yesterday] is still a genuine failure.
function isoDaysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}
function expectStampedToday(received: unknown): void {
  expect([isoDaysAgo(0), isoDaysAgo(1)]).toContain(received);
}

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
      expectStampedToday(read.value.frontmatter.updated);
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

    // #127/#128 regression. The write lock must be keyed on the CANONICAL
    // vault-relative path, not the raw caller string. Two spellings of one file
    // (`pricing/new-note.md` and `pricing/./new-note.md`) resolve to the same
    // document; if they took out DISTINCT locks, two concurrent writers would
    // both "hold the file" and silently clobber each other — and the
    // base_version optimistic-concurrency guard, which runs under that same
    // lock, is defeated. Pre-hold the canonical lock under a different holder,
    // then confirm an aliased write is DENIED and never lands on disk.
    it("keys the write lock on the canonical path, so aliased spellings contend", async () => {
      const lockDbResult = openLockDb(vault);
      expect(lockDbResult.ok).toBe(true);
      if (!lockDbResult.ok) return;
      const lockDb = lockDbResult.value;
      const held = acquireLock(lockDb, "pricing/new-note.md", "agent:other");
      expect(held.ok).toBe(true);
      lockDb.close();

      const result = await vaultWrite(vault, {
        path: "pricing/./new-note.md", // aliased spelling of pricing/new-note.md
        body: "# Serverless Cost Notes\n\nAliased write.\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("locked by agent:other");
      // The aliased write must not have slipped past the lock onto disk.
      expect(existsSync(join(vault, "pricing/new-note.md"))).toBe(false);
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

    it("accepts frontmatter that omits server-managed updated / updated_by", async () => {
      const fm = newFrontmatter() as Record<string, unknown>;
      delete fm.updated;
      delete fm.updated_by;
      const result = await vaultWrite(vault, {
        path: "pricing/no-stamps.md",
        body: "# Notes\n\nBody.\n",
        frontmatter: fm,
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const read = await vaultRead(vault, "pricing/no-stamps.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expectStampedToday(read.value.frontmatter.updated);
      expect(read.value.frontmatter.updated_by).toBe(AGENT);
    }, 60_000);
  });

  describe("advisory supersede hint on overwrite (#169)", () => {
    it("a net-new write carries no hint; an overwrite carries one", async () => {
      const created = await vaultWrite(vault, {
        path: "pricing/fact.md",
        frontmatter: newFrontmatter(),
        body: "# Fact\n\nvalue: 40\n",
        agent: AGENT,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.action).toBe("create");
      expect(created.value.supersede_hint).toBeUndefined();

      const overwritten = await vaultWrite(vault, {
        path: "pricing/fact.md",
        frontmatter: newFrontmatter(),
        body: "# Fact\n\nvalue: 60\n",
        agent: AGENT,
      });
      expect(overwritten.ok).toBe(true);
      if (!overwritten.ok) return;
      expect(overwritten.value.action).toBe("update");
      expect(overwritten.value.supersede_hint).toContain("vault_supersede");
      expect(overwritten.value.supersede_hint).toContain("Advisory only");
    }, 60_000);

    it("the hint alters nothing about the written content or result semantics", async () => {
      await vaultWrite(vault, {
        path: "pricing/fact.md",
        frontmatter: newFrontmatter(),
        body: "# Fact\n\nvalue: 40\n",
        agent: AGENT,
      });
      const overwritten = await vaultWrite(vault, {
        path: "pricing/fact.md",
        frontmatter: newFrontmatter({ tags: ["revised"] }),
        body: "# Fact\n\nvalue: 60\n",
        agent: AGENT,
      });
      expect(overwritten.ok).toBe(true);
      if (!overwritten.ok) return;
      // The write itself landed exactly as an un-hinted overwrite would.
      expect(overwritten.value.committed).toBe(true);
      const back = await vaultRead(vault, "pricing/fact.md");
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      expect(back.value.content.trim()).toBe("# Fact\n\nvalue: 60".trim());
      expect(back.value.content).not.toContain("value: 40");
      expect(back.value.frontmatter.tags).toEqual(["revised"]);
      // The hint text never leaks into the document.
      expect(back.value.content).not.toContain("vault_supersede");
    }, 60_000);
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
      expectStampedToday(read.value.frontmatter.updated);
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
      const dbResult = openIndexDb(vault, LOCAL_MINILM_DIM);
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
      const dbResult = openIndexDb(vault, LOCAL_MINILM_DIM);
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

  // ---------------------------------------------------------------------------
  // Frontmatter merge on update (#113). A tool-mediated write must never
  // silently drop a frontmatter field the author put there. On the update path,
  // the document's existing frontmatter is merged under the write payload:
  // every existing field is preserved, the payload wins per-key, and an
  // explicit null in the payload removes the key (opt-in deletion). The create
  // path is unchanged — there is no existing frontmatter to preserve.
  // ---------------------------------------------------------------------------
  describe("vault_write — frontmatter merge on update (#113)", () => {
    // Seeds a document straight to disk so the test controls the exact
    // on-disk frontmatter, independent of any write-path behavior.
    function seed(relPath: string, frontmatterLines: string[]): void {
      const abs = join(vault, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `---\n${frontmatterLines.join("\n")}\n---\n\n# Seed\n\nOriginal body.\n`);
    }

    // A full, valid built-in frontmatter block, optionally extended with extra
    // (custom / undeclared) lines.
    function builtinLines(extra: string[] = []): string[] {
      return [
        "title: Service Architecture",
        "domain: accumulation",
        "collection: pricing",
        "status: canonical",
        "confidence: low",
        "created: 2026-05-01",
        "updated: 2026-05-01",
        "updated_by: agent:seed",
        "provenance: direct",
        "sources: []",
        "superseded_by: null",
        "ttl_days: null",
        "tags: [pricing]",
        ...extra,
      ];
    }

    it("preserves an undeclared custom field when the payload omits it", async () => {
      seed("pricing/svc.md", builtinLines(['co_curator: "@jsmith"']));

      const result = await vaultWrite(vault, {
        path: "pricing/svc.md",
        body: "# Service Architecture\n\nUpdated body.\n",
        frontmatter: newFrontmatter({
          title: "Service Architecture",
          collection: "pricing",
          status: "canonical",
          confidence: "high",
        }),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);

      const read = await vaultRead(vault, "pricing/svc.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.raw.co_curator).toBe("@jsmith");
    }, 60_000);

    it("lets the payload win for a standard field it supplies", async () => {
      seed("pricing/svc.md", builtinLines());

      const result = await vaultWrite(vault, {
        path: "pricing/svc.md",
        body: "# Service Architecture\n",
        frontmatter: newFrontmatter({
          title: "Service Architecture",
          collection: "pricing",
          status: "canonical",
          confidence: "high",
        }),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);

      const read = await vaultRead(vault, "pricing/svc.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.frontmatter.confidence).toBe("high");
    }, 60_000);

    it("removes a key the payload sets to null, while preserving the rest", async () => {
      // `temperature` is set to null in the payload (opt-in deletion); `stakes`
      // is omitted entirely and must survive (preservation, not deletion).
      seed("pricing/svc.md", builtinLines(["temperature: cold", "stakes: high"]));

      const result = await vaultWrite(vault, {
        path: "pricing/svc.md",
        body: "# Service Architecture\n",
        frontmatter: newFrontmatter({
          title: "Service Architecture",
          collection: "pricing",
          status: "canonical",
          temperature: null,
        }),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);

      const read = await vaultRead(vault, "pricing/svc.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect("temperature" in read.value.raw).toBe(false);
      expect(read.value.raw.stakes).toBe("high");
    }, 60_000);

    it("leaves the create path unchanged — only payload fields are written", async () => {
      const result = await vaultWrite(vault, {
        path: "pricing/brand-new.md",
        body: "# Brand New\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);

      const read = await vaultRead(vault, "pricing/brand-new.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // No custom keys appear out of nowhere: the raw block is exactly the
      // built-in field set.
      const BUILTIN_KEYS = [
        "title",
        "domain",
        "collection",
        "status",
        "confidence",
        "created",
        "updated",
        "updated_by",
        "provenance",
        "tier",
        "sources",
        "superseded_by",
        "ttl_days",
        "tags",
        "describes",
        "questions_answered",
        "questions_raised",
      ];
      expect(Object.keys(read.value.raw).sort()).toEqual([...BUILTIN_KEYS].sort());
    }, 60_000);

    it("preserves all six custom fields from the issue #113 repro at once", async () => {
      seed(
        "architecture/service-arch.md",
        builtinLines([
          "type: decision-record",
          "lifecycle: active",
          "curation: quarterly",
          "temperature: cold",
          "stakes: high",
          'co_curator: "@jsmith"',
        ]),
      );

      const result = await vaultWrite(vault, {
        path: "architecture/service-arch.md",
        body: "# Service Architecture\n\nUpdated.\n",
        frontmatter: newFrontmatter({
          title: "Service Architecture",
          collection: "pricing",
          status: "canonical",
          confidence: "high",
        }),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);

      const read = await vaultRead(vault, "architecture/service-arch.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.raw.type).toBe("decision-record");
      expect(read.value.raw.lifecycle).toBe("active");
      expect(read.value.raw.curation).toBe("quarterly");
      expect(read.value.raw.temperature).toBe("cold");
      expect(read.value.raw.stakes).toBe("high");
      expect(read.value.raw.co_curator).toBe("@jsmith");
    }, 60_000);

    it("refuses to overwrite an existing file whose frontmatter does not parse", async () => {
      // Malformed YAML on disk: a create-style clobber here would discard
      // whatever the document holds — the field-loss class #113 guards against.
      const abs = join(vault, "pricing/corrupt.md");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, "---\ntitle: [unterminated\ncustom: keep-me\n---\n\n# Body\n");

      const result = await vaultWrite(vault, {
        path: "pricing/corrupt.md",
        body: "# Replacement\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("could not be");
      // The original bytes are untouched.
      expect(readFileSync(abs, "utf-8")).toContain("custom: keep-me");
    }, 60_000);

    it("applies a partial frontmatter update and records an accurate provenance diff", async () => {
      seed("pricing/svc.md", builtinLines());

      // A realistic partial write: only the changed field is supplied. The
      // merge fills the rest from the existing document, so the write validates.
      const result = await vaultWrite(vault, {
        path: "pricing/svc.md",
        body: "# Service Architecture\n",
        frontmatter: { confidence: "high" },
        agent: AGENT,
      });
      expect(result.ok).toBe(true);

      const read = await vaultRead(vault, "pricing/svc.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // The changed field changed; an omitted optional built-in survived intact.
      expect(read.value.frontmatter.confidence).toBe("high");
      expect(read.value.frontmatter.tags).toEqual(["pricing"]);

      const prov = await readProvenanceLog(vault);
      expect(prov.ok).toBe(true);
      if (!prov.ok) return;
      const entry = prov.value.find((e) => e.file === "pricing/svc.md" && e.action === "update");
      // The diff reflects the actual change, not a wholesale rewrite.
      expect(entry?.frontmatter_diff?.confidence?.before).toBe("low");
      expect(entry?.frontmatter_diff?.confidence?.after).toBe("high");
      expect(entry?.frontmatter_diff?.title).toBeUndefined();
    }, 60_000);
  });

  describe("vault_write — declared schema extensions survive an omitting update (#113)", () => {
    const EXT_CONFIG = [
      "version: 1",
      "vault_name: sample-vault",
      "schema_extensions:",
      "  adr_id:",
      "    type: string",
      '    pattern: "^ADR-[0-9]+$"',
      "  stakeholders:",
      "    type: array",
      "    items: string",
      "",
    ].join("\n");

    beforeEach(() => {
      mkdirSync(`${vault}/.daftari`, { recursive: true });
      writeFileSync(configPath(vault), EXT_CONFIG);
    });

    it("preserves a declared extension field the update payload omits", async () => {
      // Seed a conformant doc carrying declared extension values.
      await vaultWrite(vault, {
        path: "pricing/adr.md",
        body: "# ADR\n",
        frontmatter: newFrontmatter({
          adr_id: "ADR-021",
          stakeholders: ["platform", "security"],
        }),
        agent: AGENT,
      });

      // Update with standard fields only — the extension fields are NOT in the
      // payload. They must survive.
      const result = await vaultWrite(vault, {
        path: "pricing/adr.md",
        body: "# ADR v2\n",
        frontmatter: newFrontmatter({ confidence: "high" }),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);

      const read = await vaultRead(vault, "pricing/adr.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.raw.adr_id).toBe("ADR-021");
      expect(read.value.raw.stakeholders).toEqual(["platform", "security"]);
    }, 60_000);
  });

  describe("auto_commit opt-out (issue #22)", () => {
    function writeConfig(autoCommit: boolean | undefined): void {
      mkdirSync(`${vault}/.daftari`, { recursive: true });
      const lines = ["version: 1", "vault_name: sample-vault"];
      if (autoCommit !== undefined) lines.push(`auto_commit: ${autoCommit}`);
      writeFileSync(configPath(vault), `${lines.join("\n")}\n`);
    }

    it("default config commits and reports committed: true", async () => {
      writeConfig(undefined);
      const result = await vaultWrite(vault, {
        path: "pricing/committed.md",
        body: "# Note\n\nBody.\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.committed).toBe(true);
      expect(result.value.commit).toMatch(/^[0-9a-f]+$/);
    }, 60_000);

    it("auto_commit: false writes the file but skips the commit", async () => {
      writeConfig(false);
      const result = await vaultWrite(vault, {
        path: "pricing/uncommitted.md",
        body: "# Note\n\nBody.\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.committed).toBe(false);
      expect(result.value.commit).toBeNull();

      // File is durable and indexed despite no commit.
      const read = await vaultRead(vault, "pricing/uncommitted.md");
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.content).toContain("Body.");
      expect(result.value.indexUpdated).toBe(true);

      // No git repository was initialized — the commit step was skipped whole.
      expect(await isGitRepo(vault)).toBe(false);

      // Provenance is still recorded — it is an advisory log, not git.
      const prov = await readProvenanceLog(vault);
      expect(prov.ok).toBe(true);
      if (!prov.ok) return;
      const entry = prov.value.find(
        (e) => e.file === "pricing/uncommitted.md" && e.action === "create",
      );
      expect(entry?.tool).toBe("vault_write");
    }, 60_000);

    it("auto_commit: false also applies to vault_append and vault_deprecate", async () => {
      writeConfig(false);

      const appended = await vaultAppend(vault, {
        path: "_drafts/moonshot-agentic-etl.md",
        section: "## Section\n\nText.",
        agent: AGENT,
      });
      expect(appended.ok).toBe(true);
      if (!appended.ok) return;
      expect(appended.value.committed).toBe(false);
      expect(appended.value.commit).toBeNull();

      const deprecated = await vaultDeprecate(vault, {
        path: "_drafts/moonshot-agentic-etl.md",
        reason: "no longer relevant",
        agent: AGENT,
      });
      expect(deprecated.ok).toBe(true);
      if (!deprecated.ok) return;
      expect(deprecated.value.committed).toBe(false);
      expect(deprecated.value.commit).toBeNull();

      expect(await isGitRepo(vault)).toBe(false);
    }, 60_000);

    it("rejects a non-boolean auto_commit value", async () => {
      mkdirSync(`${vault}/.daftari`, { recursive: true });
      writeFileSync(
        configPath(vault),
        ["version: 1", "vault_name: sample-vault", "auto_commit: maybe", ""].join("\n"),
      );
      const result = await vaultWrite(vault, {
        path: "pricing/note.md",
        body: "# Note\n",
        frontmatter: newFrontmatter(),
        agent: AGENT,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("auto_commit");
    });
  });
});

describe("serializeDocument — custom Date frontmatter fields", () => {
  it("serializes a custom Date frontmatter field as YYYY-MM-DD, not a datetime", () => {
    const fm = newFrontmatter({
      describes: [],
      questions_answered: [],
      questions_raised: [],
    }) as unknown as Frontmatter;
    const out = serializeDocument(fm, "body\n", [], {
      published: new Date("2026-06-15T00:00:00.000Z"),
    });
    expect(out).toContain("published: '2026-06-15'");
    expect(out).not.toContain("2026-06-15T00:00:00");
  });
});

describe("expectStampedToday — UTC-midnight boundary tolerance", () => {
  // Regression guard for the flake where a write stamped just before UTC
  // midnight was compared against a date captured after midnight. The write
  // path stamps `new Date()` at write time (correct); the assertion must
  // tolerate the one-day window between the write and the read-back.
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts a date stamped just before a midnight the assertion crosses", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T23:59:59.000Z"));
    const stampedByWrite = new Date().toISOString().slice(0, 10); // "2026-06-10"
    // The read-back assertion runs a moment later, after midnight UTC.
    vi.setSystemTime(new Date("2026-06-11T00:00:01.000Z"));
    expect(() => expectStampedToday(stampedByWrite)).not.toThrow();
  });

  it("accepts a same-instant stamp (no boundary crossed)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-10T12:00:00.000Z"));
    expect(() => expectStampedToday(new Date().toISOString().slice(0, 10))).not.toThrow();
  });

  it("rejects a genuinely wrong (stale or hardcoded) date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-11T00:00:01.000Z"));
    expect(() => expectStampedToday("2020-01-01")).toThrow();
    // Two days back is outside the tolerated window → still a real failure.
    expect(() => expectStampedToday("2026-06-09")).toThrow();
  });
});
