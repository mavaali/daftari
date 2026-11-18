// Canonical status requires the promote grant on every write path
// (bead mavaali-beads-mfcr; Stage 1 review T01).
//
// docs/file-format.md: `canonical` is reached only via vault_promote, and the
// `promote` grant is "whether the role may promote a draft to canonical".
// Before this fix vault_write (create and update), a vault_merge frontmatter
// override or inherited status, and vault_ratify of a staged write/merge all
// landed a canonical document for a role without `promote`. These tests pin
// the enforced boundary. All calls go through the registered MCP tool handlers
// (the function src/server.ts invokes for tools/call) on a throwaway vault.

import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { resolveAccess } from "../../src/access/rbac.js";
import { registeredTools } from "../../src/server.js";
import { vaultRead } from "../../src/tools/read.js";
import { loadConfig } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

type ToolResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: Error };
type Handler = (
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
) => Promise<ToolResult>;

function tool(name: string): Handler {
  const t = registeredTools().find((x) => x.name === name);
  if (!t) throw new Error(`tool not registered: ${name}`);
  return t.handler as unknown as Handler;
}

function value(r: ToolResult): Record<string, unknown> {
  if (!r.ok) throw r.error;
  return r.value;
}

function errorOf(r: ToolResult): string {
  if (r.ok) throw new Error(`expected a denial, got ${JSON.stringify(r.value)}`);
  return r.error.message;
}

// May write everywhere, may NOT promote or ratify.
const WRITER: AccessContext = {
  user: "agent:writer",
  roleName: "writer",
  role: { read: ["*"], write: ["*"], promote: false, ratify: false },
};
// May write and promote, may NOT ratify.
const PROMOTER: AccessContext = {
  user: "human:promoter",
  roleName: "promoter",
  role: { read: ["*"], write: ["*"], promote: true, ratify: false },
};
const ADMIN: AccessContext = {
  user: "human:admin",
  roleName: "admin",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};
const PROPOSER: AccessContext = {
  user: "agent:proposer",
  roleName: "agent-proposer",
  role: { read: ["*"], write: ["*"], promote: false, ratify: false, proposeOnly: true },
};
// May ratify but NOT promote (distinct grants, rbac.ts).
const RATIFIER: AccessContext = {
  user: "human:ratifier",
  roleName: "ratifier",
  role: { read: ["*"], write: ["*"], promote: false, ratify: true },
};
// May ratify AND promote.
const RATIFIER_PROMOTER: AccessContext = {
  user: "human:curator",
  roleName: "curator",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};

const DENIAL = /cannot promote documents.*vault_promote/;

function fm(overrides: Record<string, unknown> = {}) {
  return {
    title: "Authority Doc",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-07-01",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: null,
    tags: [],
    ...overrides,
  };
}

async function statusOf(vault: string, path: string): Promise<string | null> {
  const r = await vaultRead(vault, path);
  if (!r.ok) return null;
  const doc = r.value as { frontmatter?: { status?: string } };
  return doc.frontmatter?.status ?? null;
}

async function bodyOf(vault: string, path: string): Promise<string | null> {
  const r = await vaultRead(vault, path);
  if (!r.ok) return null;
  return (r.value as { content?: string }).content ?? null;
}

async function seedDraft(vault: string, path: string, title = "Seed Draft") {
  value(
    await tool("vault_write")(
      vault,
      { path, body: `# ${title}\n\nBody.\n`, frontmatter: fm({ title }), agent: "human:admin" },
      ADMIN,
    ),
  );
}

async function seedCanonical(vault: string, path: string, title = "Seed Canonical") {
  await seedDraft(vault, path, title);
  value(await tool("vault_promote")(vault, { path, agent: "human:admin" }, ADMIN));
  expect(await statusOf(vault, path)).toBe("canonical");
}

describe("canonical status requires the promote grant", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  // ---- vault_promote (unchanged reference behavior) -----------------------

  it("vault_promote denies a write-but-not-promote role", async () => {
    await seedDraft(vault, "pricing/a.md");
    const r = await tool("vault_promote")(
      vault,
      { path: "pricing/a.md", agent: "agent:writer" },
      WRITER,
    );
    expect(errorOf(r)).toMatch(/cannot promote documents/);
    expect(await statusOf(vault, "pricing/a.md")).toBe("draft");
  });

  // ---- vault_write: create -------------------------------------------------

  it("vault_write refuses to CREATE a canonical doc for a role without promote", async () => {
    const r = await tool("vault_write")(
      vault,
      {
        path: "pricing/born-canonical.md",
        body: "# Born canonical\n",
        frontmatter: fm({ status: "canonical" }),
        agent: "agent:writer",
      },
      WRITER,
    );
    expect(errorOf(r)).toMatch(DENIAL);
    expect(errorOf(r)).toContain("role 'writer'");
    expect(await statusOf(vault, "pricing/born-canonical.md")).toBeNull();
  });

  it("vault_write lets a role WITH promote create a canonical doc directly", async () => {
    const r = await tool("vault_write")(
      vault,
      {
        path: "pricing/born-canonical.md",
        body: "# Born canonical\n",
        frontmatter: fm({ status: "canonical" }),
        agent: "human:promoter",
      },
      PROMOTER,
    );
    expect(value(r).status).toBe("canonical");
    expect(await statusOf(vault, "pricing/born-canonical.md")).toBe("canonical");
  });

  it("a config-declared role with no promote key (fixture 'analyst') is denied", async () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    copyFileSync(
      resolve("test/fixtures/sample-vault/.daftari/config.yaml"),
      join(vault, ".daftari", "config.yaml"),
    );
    const cfg = loadConfig(vault);
    if (!cfg.ok) throw cfg.error;
    const analyst = resolveAccess(cfg.value, "agent:analyst", "analyst");
    expect(analyst.role?.write).toEqual(["competitive-intel"]);
    expect(analyst.role?.promote ?? false).toBe(false);
    const r = await tool("vault_write")(
      vault,
      {
        path: "competitive-intel/analyst.md",
        body: "# Analyst canonical\n",
        frontmatter: fm({ collection: "competitive-intel", status: "canonical" }),
        agent: "agent:analyst",
      },
      analyst,
    );
    expect(errorOf(r)).toMatch(DENIAL);
    expect(await statusOf(vault, "competitive-intel/analyst.md")).toBeNull();
  });

  it("a role without promote still creates drafts", async () => {
    const r = await tool("vault_write")(
      vault,
      {
        path: "pricing/new-draft.md",
        body: "# Draft\n",
        frontmatter: fm(),
        agent: "agent:writer",
      },
      WRITER,
    );
    expect(value(r).status).toBe("draft");
  });

  // ---- vault_write: update -------------------------------------------------

  it("vault_write refuses draft→canonical (partial payload) for a role without promote", async () => {
    await seedDraft(vault, "pricing/b.md");
    const r = await tool("vault_write")(
      vault,
      {
        path: "pricing/b.md",
        body: "# Seed Draft\n\nBody.\n",
        frontmatter: { status: "canonical" },
        agent: "agent:writer",
      },
      WRITER,
    );
    expect(errorOf(r)).toMatch(DENIAL);
    expect(await statusOf(vault, "pricing/b.md")).toBe("draft");
  });

  it("vault_write allows draft→canonical for a role WITH promote", async () => {
    await seedDraft(vault, "pricing/b.md");
    const r = await tool("vault_write")(
      vault,
      {
        path: "pricing/b.md",
        body: "# Seed Draft\n\nBody.\n",
        frontmatter: { status: "canonical" },
        agent: "human:promoter",
      },
      PROMOTER,
    );
    expect(value(r).status).toBe("canonical");
  });

  it("BOUNDARY: a writer may still edit an already-canonical doc without changing status", async () => {
    await seedCanonical(vault, "pricing/c.md");
    // Partial payload: status is inherited from disk (#113 merge).
    const partial = await tool("vault_write")(
      vault,
      {
        path: "pricing/c.md",
        body: "# Seed Canonical\n\nEdited body.\n",
        frontmatter: { tags: ["edited"] },
        agent: "agent:writer",
      },
      WRITER,
    );
    expect(value(partial).status).toBe("canonical");
    // Full payload restating status: canonical is not a transition either.
    const restated = await tool("vault_write")(
      vault,
      {
        path: "pricing/c.md",
        body: "# Seed Canonical\n\nEdited again.\n",
        frontmatter: fm({ title: "Seed Canonical", status: "canonical" }),
        agent: "agent:writer",
      },
      WRITER,
    );
    expect(value(restated).status).toBe("canonical");
    expect(await bodyOf(vault, "pricing/c.md")).toContain("Edited again.");
  });

  it("vault_write status:canonical by a propose-only role is staged, not written", async () => {
    const r = await tool("vault_write")(
      vault,
      {
        path: "pricing/proposed.md",
        body: "# Proposed\n",
        frontmatter: fm({ status: "canonical" }),
        agent: "agent:proposer",
      },
      PROPOSER,
    );
    expect(value(r).action).toBe("staged");
    expect(await statusOf(vault, "pricing/proposed.md")).toBeNull();
  });

  // ---- vault_patch / vault_append (unchanged) ------------------------------

  it("vault_patch still refuses `status`", async () => {
    await seedDraft(vault, "pricing/d.md");
    const r = await tool("vault_patch")(
      vault,
      {
        path: "pricing/d.md",
        frontmatter: { status: "canonical" },
        reason: "t",
        agent: "agent:writer",
      },
      WRITER,
    );
    expect(errorOf(r)).toMatch(/'status' cannot be patched/);
  });

  it("vault_append ignores a smuggled frontmatter.status", async () => {
    await seedDraft(vault, "pricing/e.md");
    await tool("vault_append")(
      vault,
      {
        path: "pricing/e.md",
        section: "Addendum",
        content: "More.",
        frontmatter: { status: "canonical" },
        agent: "agent:writer",
      },
      WRITER,
    );
    expect(await statusOf(vault, "pricing/e.md")).toBe("draft");
  });

  // ---- vault_merge ---------------------------------------------------------

  it("vault_merge refuses a canonical override for a role without promote", async () => {
    await seedDraft(vault, "pricing/src-a.md", "Src A");
    await seedDraft(vault, "pricing/src-b.md", "Src B");
    const r = await tool("vault_merge")(
      vault,
      {
        path_a: "pricing/src-a.md",
        path_b: "pricing/src-b.md",
        target_path: "pricing/merged.md",
        body: "# Merged\n\nFrom two drafts.\n",
        frontmatter: { title: "Merged", status: "canonical", superseded_by: null },
        agent: "agent:writer",
      },
      WRITER,
    );
    expect(errorOf(r)).toMatch(DENIAL);
    expect(await statusOf(vault, "pricing/merged.md")).toBeNull();
    // Nothing else was touched: the sources were not superseded.
    expect(await statusOf(vault, "pricing/src-a.md")).toBe("draft");
    expect(await statusOf(vault, "pricing/src-b.md")).toBe("draft");
  });

  it("vault_merge refuses a canonical status INHERITED from path_a for a role without promote", async () => {
    await seedCanonical(vault, "pricing/src-a.md", "Src A");
    await seedDraft(vault, "pricing/src-b.md", "Src B");
    const r = await tool("vault_merge")(
      vault,
      {
        path_a: "pricing/src-a.md",
        path_b: "pricing/src-b.md",
        target_path: "pricing/merged.md",
        body: "# Merged\n\nInherits A's status.\n",
        frontmatter: { title: "Merged", superseded_by: null },
        agent: "agent:writer",
      },
      WRITER,
    );
    expect(errorOf(r)).toMatch(DENIAL);
    expect(await statusOf(vault, "pricing/merged.md")).toBeNull();
    expect(await statusOf(vault, "pricing/src-a.md")).toBe("canonical");
  });

  it("BOUNDARY: vault_merge into an already-canonical target needs only write, like an edit", async () => {
    await seedCanonical(vault, "pricing/src-a.md", "Src A");
    await seedDraft(vault, "pricing/src-b.md", "Src B");
    const r = await tool("vault_merge")(
      vault,
      {
        path_a: "pricing/src-a.md",
        path_b: "pricing/src-b.md",
        target_path: "pricing/src-a.md",
        body: "# Src A\n\nB folded in.\n",
        agent: "agent:writer",
      },
      WRITER,
    );
    expect(r.ok).toBe(true);
    expect(await bodyOf(vault, "pricing/src-a.md")).toContain("B folded in.");
  });

  it("vault_merge with a draft result stays open to a role without promote", async () => {
    await seedCanonical(vault, "pricing/src-a.md", "Src A");
    await seedDraft(vault, "pricing/src-b.md", "Src B");
    const r = await tool("vault_merge")(
      vault,
      {
        path_a: "pricing/src-a.md",
        path_b: "pricing/src-b.md",
        target_path: "pricing/merged.md",
        body: "# Merged\n\nDrafted.\n",
        frontmatter: { title: "Merged", status: "draft", superseded_by: null },
        agent: "agent:writer",
      },
      WRITER,
    );
    value(r);
    expect(await statusOf(vault, "pricing/merged.md")).toBe("draft");
  });

  it("vault_merge allows a canonical result (override or inherited) for a role WITH promote", async () => {
    await seedCanonical(vault, "pricing/src-a.md", "Src A");
    await seedDraft(vault, "pricing/src-b.md", "Src B");
    const r = await tool("vault_merge")(
      vault,
      {
        path_a: "pricing/src-a.md",
        path_b: "pricing/src-b.md",
        target_path: "pricing/merged.md",
        body: "# Merged\n\nInherited canonical.\n",
        frontmatter: { title: "Merged", superseded_by: null },
        agent: "human:promoter",
      },
      PROMOTER,
    );
    value(r);
    expect(await statusOf(vault, "pricing/merged.md")).toBe("canonical");
  });

  // ---- vault_ratify: the ratifier's grant decides --------------------------

  it("ratifier WITHOUT promote cannot apply a staged `promote`", async () => {
    await seedDraft(vault, "pricing/f.md");
    const staged = value(
      await tool("vault_stage_action")(
        vault,
        {
          action_type: "promote",
          target_path: "pricing/f.md",
          proposed_by: "agent:proposer",
          rationale: "t",
          proposed_diff: {},
        },
        PROPOSER,
      ),
    );
    const r = await tool("vault_ratify")(
      vault,
      { id: staged.id, decision: "approve", principal: "human:ratifier" },
      RATIFIER,
    );
    expect(errorOf(r)).toMatch(/cannot promote/);
    expect(await statusOf(vault, "pricing/f.md")).toBe("draft");
  }, 60_000);

  async function stageCanonicalWrite(path: string): Promise<string> {
    await seedDraft(vault, path);
    const staged = value(
      await tool("vault_write")(
        vault,
        {
          path,
          body: "# Seed Draft\n\nBody.\n",
          frontmatter: { status: "canonical" },
          agent: "agent:proposer",
        },
        PROPOSER,
      ),
    );
    expect(staged.action).toBe("staged");
    return staged.staged_id as string;
  }

  it("ratifier WITHOUT promote cannot apply a staged `write` whose post-state is canonical", async () => {
    const id = await stageCanonicalWrite("pricing/g.md");
    const r = await tool("vault_ratify")(
      vault,
      { id, decision: "approve", principal: "human:ratifier" },
      RATIFIER,
    );
    expect(errorOf(r)).toMatch(DENIAL);
    expect(errorOf(r)).toContain("role 'ratifier'");
    expect(await statusOf(vault, "pricing/g.md")).toBe("draft");
  }, 60_000);

  it("ratifier WITH promote applies a staged `write` whose post-state is canonical", async () => {
    const id = await stageCanonicalWrite("pricing/g.md");
    const r = await tool("vault_ratify")(
      vault,
      { id, decision: "approve", principal: "human:curator" },
      RATIFIER_PROMOTER,
    );
    expect(value(r).applied).toBe(true);
    expect(await statusOf(vault, "pricing/g.md")).toBe("canonical");
  }, 60_000);

  async function stageCanonicalMerge(): Promise<string> {
    await seedDraft(vault, "pricing/m-a.md", "M A");
    await seedDraft(vault, "pricing/m-b.md", "M B");
    const staged = value(
      await tool("vault_stage_action")(
        vault,
        {
          action_type: "merge",
          // vault_stage_action requires the target to exist: merge into path_a.
          target_path: "pricing/m-a.md",
          proposed_by: "agent:proposer",
          rationale: "t",
          proposed_diff: {
            merge_from: ["pricing/m-a.md", "pricing/m-b.md"],
            body: "# Merged\n\nStaged.\n",
            frontmatter: { title: "Merged", status: "canonical", superseded_by: null },
          },
        },
        PROPOSER,
      ),
    );
    return staged.id as string;
  }

  it("ratifier WITHOUT promote cannot apply a staged `merge` with a canonical override", async () => {
    const id = await stageCanonicalMerge();
    const r = await tool("vault_ratify")(
      vault,
      { id, decision: "approve", principal: "human:ratifier" },
      RATIFIER,
    );
    expect(errorOf(r)).toMatch(DENIAL);
    expect(await statusOf(vault, "pricing/m-a.md")).toBe("draft");
    expect(await statusOf(vault, "pricing/m-b.md")).toBe("draft");
  }, 60_000);

  it("ratifier WITH promote applies a staged `merge` with a canonical override", async () => {
    const id = await stageCanonicalMerge();
    const r = await tool("vault_ratify")(
      vault,
      { id, decision: "approve", principal: "human:curator" },
      RATIFIER_PROMOTER,
    );
    expect(value(r).applied).toBe(true);
    expect(await statusOf(vault, "pricing/m-a.md")).toBe("canonical");
  }, 60_000);

  // ---- operator (no access context) is unaffected --------------------------

  it("an operator server (no access context) may still write canonical directly", async () => {
    const r = await tool("vault_write")(vault, {
      path: "pricing/operator.md",
      body: "# Operator\n",
      frontmatter: fm({ status: "canonical" }),
      agent: "human:operator",
    });
    expect(value(r).status).toBe("canonical");
  });
});
