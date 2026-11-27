// #640 — vault_unsupersede: the reviewed reversal of a supersession, logged as
// its own provenance action. It always lands on `draft`: the prior status is
// not stored on the document, and returning to canonical is vault_promote's
// separate, gated act.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { stageAction } from "../../src/curation/staged-actions.js";
import { parseDocument } from "../../src/frontmatter/parser.js";
import { vaultRatify } from "../../src/tools/staged-actions.js";
import {
  vaultPatch,
  vaultPromote,
  vaultSupersede,
  vaultUnsupersede,
  writeTools,
} from "../../src/tools/write.js";
import { sha256Hex } from "../../src/utils/hash.js";
import { withInjectedRace } from "../helpers/inject-race.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:claude-code";
const REASON = "the supersede closed a loop; the successor points back here";
const OLD = "pricing/old.md";
const NEW = "pricing/new.md";

function seed(vault: string, relPath: string, fields: string[] = []): void {
  const abs = join(vault, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    "---\ntitle: Doc\ndomain: accumulation\ncollection: pricing\nstatus: canonical\n" +
      "confidence: high\ncreated: 2026-05-01\nupdated: 2026-05-01\nupdated_by: human:mihir\n" +
      `provenance: direct\n${fields.join("\n")}${fields.length > 0 ? "\n" : ""}---\n\n# Doc\n\nBody.\n`,
  );
}

function raw(vault: string, relPath: string): Record<string, unknown> {
  const parsed = parseDocument(readFileSync(join(vault, relPath), "utf-8"));
  if (!parsed.ok) throw parsed.error;
  return parsed.value.raw;
}

async function supersede(vault: string): Promise<void> {
  const superseded = await vaultSupersede(vault, {
    old_path: OLD,
    new_path: NEW,
    agent: AGENT,
  });
  if (!superseded.ok) throw superseded.error;
}

describe("vault_unsupersede (#640)", () => {
  let vault: string;

  beforeEach(async () => {
    vault = makeTempVault();
    seed(vault, OLD);
    seed(vault, NEW);
    await supersede(vault);
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("returns the document to draft and clears superseded_by", async () => {
    const result = await vaultUnsupersede(vault, { path: OLD, reason: REASON, agent: AGENT });
    if (!result.ok) throw result.error;
    expect(result.value.action).toBe("unsupersede");
    expect(result.value.status).toBe("draft");
    expect(raw(vault, OLD).status).toBe("draft");
    expect(raw(vault, OLD).superseded_by).toBeNull();
  });

  it("leaves a provenance entry naming who, when, and why (acceptance)", async () => {
    const result = await vaultUnsupersede(vault, {
      path: OLD,
      reason: REASON,
      agent: AGENT,
      run_id: "run-640",
    });
    if (!result.ok) throw result.error;

    const log = await readProvenanceLog(vault);
    if (!log.ok) throw log.error;
    const entry = log.value.find((e) => e.action === "unsupersede");
    expect(entry).toMatchObject({
      tool: "vault_unsupersede",
      file: OLD,
      agent: AGENT,
      reason: REASON,
      run_id: "run-640",
      body_changed: false,
    });
    expect(Number.isNaN(Date.parse(entry?.timestamp ?? ""))).toBe(false);
    expect(entry?.frontmatter_diff?.status).toEqual({ before: "superseded", after: "draft" });
    expect(entry?.frontmatter_diff?.superseded_by).toEqual({ before: NEW, after: null });
  });

  it("records the authenticated principal alongside the claimed agent", async () => {
    const result = await vaultUnsupersede(
      vault,
      { path: OLD, reason: REASON, agent: AGENT },
      {
        user: "alice",
        roleName: "editor",
        role: { read: ["*"], write: ["*"], promote: true },
      },
    );
    if (!result.ok) throw result.error;
    const log = await readProvenanceLog(vault);
    if (!log.ok) throw log.error;
    expect(log.value.find((e) => e.action === "unsupersede")?.principal).toBe("alice");
  });

  it("can then be promoted back to canonical as a second, separate act", async () => {
    const reversed = await vaultUnsupersede(vault, { path: OLD, reason: REASON, agent: AGENT });
    if (!reversed.ok) throw reversed.error;
    const promoted = await vaultPromote(vault, { path: OLD, agent: AGENT });
    if (!promoted.ok) throw promoted.error;
    expect(raw(vault, OLD).status).toBe("canonical");
  });

  it("requires a reason", async () => {
    const result = await vaultUnsupersede(vault, { path: OLD, agent: AGENT });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("'reason'");
  });

  it.each(["draft", "canonical", "deprecated", "archived"])(
    "refuses a document whose status is %s",
    async (status) => {
      const abs = join(vault, NEW);
      writeFileSync(
        abs,
        readFileSync(abs, "utf-8").replace("status: canonical", `status: ${status}`),
      );
      const result = await vaultUnsupersede(vault, { path: NEW, reason: REASON, agent: AGENT });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("only superseded");
    },
  );

  it("refuses a missing document", async () => {
    const result = await vaultUnsupersede(vault, {
      path: "pricing/absent.md",
      reason: REASON,
      agent: AGENT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("document not found");
  });

  it("leaves an authored valid_until in place and hints at clearing it", async () => {
    const abs = join(vault, OLD);
    writeFileSync(
      abs,
      readFileSync(abs, "utf-8").replace("valid_until: null", "valid_until: 2026-06-01"),
    );
    const result = await vaultUnsupersede(vault, { path: OLD, reason: REASON, agent: AGENT });
    if (!result.ok) throw result.error;
    expect(String(raw(vault, OLD).valid_until)).toContain("2026-06-01");
    expect(result.value.hint).toContain("valid_until");
    expect(result.value.hint).toContain("vault_patch");
  });

  it("gives no hint when there is no valid_until", async () => {
    const result = await vaultUnsupersede(vault, { path: OLD, reason: REASON, agent: AGENT });
    if (!result.ok) throw result.error;
    expect(result.value.hint).toBeUndefined();
  });

  it("reports downstream dependents as an advisory", async () => {
    const result = await vaultUnsupersede(vault, { path: OLD, reason: REASON, agent: AGENT });
    if (!result.ok) throw result.error;
    expect(result.value.dependents).toBeDefined();
  });

  it("writes nothing under shadow_mode", async () => {
    writeFileSync(join(vault, ".daftari/config.yaml"), "version: 1\nshadow_mode: true\n");
    const before = readFileSync(join(vault, OLD), "utf-8");
    const result = await vaultUnsupersede(vault, { path: OLD, reason: REASON, agent: AGENT });
    if (!result.ok) throw result.error;
    expect(result.value.shadow).toBe(true);
    expect(readFileSync(join(vault, OLD), "utf-8")).toBe(before);
  });

  it("rejects an explicit stale base_version", async () => {
    const stale = sha256Hex(readFileSync(join(vault, OLD), "utf-8"));
    const moved = await vaultPatch(vault, {
      path: OLD,
      reason: "tag it",
      agent: AGENT,
      frontmatter: { tags: ["moved"] },
    });
    if (!moved.ok) throw moved.error;

    const result = await vaultUnsupersede(vault, {
      path: OLD,
      reason: REASON,
      agent: AGENT,
      base_version: stale,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/^stale write:/);
  });

  it("retries once when base_version is omitted, keeping the concurrent change", async () => {
    const result = await withInjectedRace(
      join(vault, OLD),
      async () => {
        const moved = await vaultPatch(vault, {
          path: OLD,
          reason: "tag it",
          agent: "agent:other",
          frontmatter: { tags: ["concurrent"] },
        });
        if (!moved.ok) throw moved.error;
      },
      () => vaultUnsupersede(vault, { path: OLD, reason: REASON, agent: AGENT }),
    );
    if (!result.ok) throw result.error;
    expect(raw(vault, OLD).tags).toEqual(["concurrent"]);
    expect(raw(vault, OLD).status).toBe("draft");
  });

  describe("access control", () => {
    it("denies a role without the promote grant", async () => {
      const result = await vaultUnsupersede(
        vault,
        { path: OLD, reason: REASON, agent: AGENT },
        { user: "bob", roleName: "writer", role: { read: ["*"], write: ["*"], promote: false } },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("access denied");
      expect(raw(vault, OLD).status).toBe("superseded");
    });

    it("denies a role that cannot write the document's collection", async () => {
      const result = await vaultUnsupersede(
        vault,
        { path: OLD, reason: REASON, agent: AGENT },
        { user: "bob", roleName: "other", role: { read: ["*"], write: ["other"], promote: true } },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("cannot write");
    });

    it("denies a propose-only role, pointing at the staging surface", async () => {
      const result = await vaultUnsupersede(
        vault,
        { path: OLD, reason: REASON, agent: AGENT },
        {
          user: "agent:proposer",
          roleName: "proposer",
          role: { read: ["*"], write: ["*"], promote: true, proposeOnly: true },
        },
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("vault_stage_action");
    });
  });

  describe("staged reversal", () => {
    const ADMIN = {
      user: "human:mihir",
      roleName: "admin",
      role: { read: ["*"], write: ["*"], promote: true, ratify: true },
    };

    async function stage(): Promise<string> {
      const staged = await stageAction(vault, {
        actionType: "unsupersede",
        targetPath: OLD,
        proposedBy: "agent:proposer",
        rationale: REASON,
        proposedDiff: {},
      });
      if (!staged.ok) throw staged.error;
      return staged.value.id;
    }

    it("lands on vault_ratify, carrying the rationale into provenance", async () => {
      const id = await stage();
      const ratified = await vaultRatify(
        vault,
        { id, decision: "approve", principal: "human:mihir" },
        ADMIN,
      );
      if (!ratified.ok) throw ratified.error;
      expect(ratified.value.applied).toBe(true);
      expect(raw(vault, OLD).status).toBe("draft");

      const log = await readProvenanceLog(vault);
      if (!log.ok) throw log.error;
      const entry = log.value.find((e) => e.action === "unsupersede");
      expect(entry).toMatchObject({
        tool: "vault_unsupersede",
        agent: "human:mihir",
        principal: "human:mihir",
        reason: REASON,
      });
    });

    it("stays pending when the document is no longer superseded at ratify time", async () => {
      const id = await stage();
      const first = await vaultUnsupersede(vault, { path: OLD, reason: REASON, agent: AGENT });
      if (!first.ok) throw first.error;
      const ratified = await vaultRatify(
        vault,
        { id, decision: "approve", principal: "human:mihir" },
        ADMIN,
      );
      expect(ratified.ok).toBe(false);
    });
  });

  it("is registered with the unsupersede action and draft status", () => {
    const tool = writeTools.find((t) => t.name === "vault_unsupersede");
    expect(tool).toBeDefined();
    expect(JSON.stringify(tool?.outputSchema)).toContain('"unsupersede"');
    expect(tool?.annotations?.destructiveHint).toBe(true);
  });
});
