// Retiring a canonical document requires the promote grant
// (bead mavaali-beads-w3wy).
//
// 3.18.0 gated every transition INTO canonical on `promote`, and
// vault_unsupersede (restoring a retired doc) already needed it. But
// vault_deprecate, vault_supersede and vault_merge gated only on `write`, so a
// writer could retire canonical knowledge it could not restore. The symmetric
// rule: any write whose prior status is canonical and whose post-state is not
// needs `promote`. Retiring a non-canonical doc still needs only `write`;
// operator servers (no access context) are unchanged; under vault_ratify the
// ratifier's grant decides. All calls go through the registered MCP tool
// handlers on a throwaway vault.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { registeredTools } from "../../src/server.js";
import { vaultRead } from "../../src/tools/read.js";
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

const WRITER: AccessContext = {
  user: "agent:writer",
  roleName: "writer",
  role: { read: ["*"], write: ["*"], promote: false, ratify: false },
};
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
// May ratify but NOT promote.
const RATIFIER: AccessContext = {
  user: "human:ratifier",
  roleName: "ratifier",
  role: { read: ["*"], write: ["*"], promote: false, ratify: true },
};
const RATIFIER_PROMOTER: AccessContext = {
  user: "human:curator",
  roleName: "curator",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};

// Names the grant and both ways forward.
const DENIAL = /cannot retire canonical documents.*'promote' grant.*vault_stage_action/;

function fm(overrides: Record<string, unknown> = {}) {
  return {
    title: "Retire Doc",
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
  return (r.value as { frontmatter?: { status?: string } }).frontmatter?.status ?? null;
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

describe("retiring a canonical document requires the promote grant", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  // ---- vault_deprecate -------------------------------------------------------

  describe("vault_deprecate", () => {
    const deprecate = (access: AccessContext | undefined, path = "pricing/a.md") =>
      tool("vault_deprecate")(vault, { path, agent: "x", reason: "retired" }, access);

    it("refuses a writer on a canonical doc and leaves it canonical", async () => {
      await seedCanonical(vault, "pricing/a.md");
      const msg = errorOf(await deprecate(WRITER));
      expect(msg).toMatch(DENIAL);
      expect(msg).toContain("role 'writer'");
      expect(msg).toContain("vault_deprecate");
      expect(await statusOf(vault, "pricing/a.md")).toBe("canonical");
    });

    it("lets a writer deprecate a draft", async () => {
      await seedDraft(vault, "pricing/a.md");
      value(await deprecate(WRITER));
      expect(await statusOf(vault, "pricing/a.md")).toBe("deprecated");
    });

    it("lets a promoter deprecate a canonical doc", async () => {
      await seedCanonical(vault, "pricing/a.md");
      value(await deprecate(PROMOTER));
      expect(await statusOf(vault, "pricing/a.md")).toBe("deprecated");
    });

    it("operator (no access context) is unchanged", async () => {
      await seedCanonical(vault, "pricing/a.md");
      value(await deprecate(undefined));
      expect(await statusOf(vault, "pricing/a.md")).toBe("deprecated");
    });
  });

  // ---- vault_supersede -------------------------------------------------------

  describe("vault_supersede", () => {
    const supersede = (access: AccessContext | undefined) =>
      tool("vault_supersede")(
        vault,
        { old_path: "pricing/old.md", new_path: "pricing/new.md", agent: "x" },
        access,
      );

    it("refuses a writer when the retired doc is canonical", async () => {
      await seedCanonical(vault, "pricing/old.md", "Old");
      await seedDraft(vault, "pricing/new.md", "New");
      const msg = errorOf(await supersede(WRITER));
      expect(msg).toMatch(DENIAL);
      expect(msg).toContain("vault_supersede");
      expect(await statusOf(vault, "pricing/old.md")).toBe("canonical");
    });

    it("lets a writer supersede a draft (even with a canonical successor)", async () => {
      await seedDraft(vault, "pricing/old.md", "Old");
      await seedCanonical(vault, "pricing/new.md", "New");
      value(await supersede(WRITER));
      expect(await statusOf(vault, "pricing/old.md")).toBe("superseded");
    });

    it("lets a promoter supersede a canonical doc", async () => {
      await seedCanonical(vault, "pricing/old.md", "Old");
      await seedDraft(vault, "pricing/new.md", "New");
      value(await supersede(PROMOTER));
      expect(await statusOf(vault, "pricing/old.md")).toBe("superseded");
    });

    it("operator (no access context) is unchanged", async () => {
      await seedCanonical(vault, "pricing/old.md", "Old");
      await seedDraft(vault, "pricing/new.md", "New");
      value(await supersede(undefined));
      expect(await statusOf(vault, "pricing/old.md")).toBe("superseded");
    });
  });

  // ---- vault_merge -----------------------------------------------------------

  describe("vault_merge", () => {
    const merge = (
      access: AccessContext | undefined,
      target = "pricing/merged.md",
      frontmatter: Record<string, unknown> = { title: "Merged", status: "draft" },
    ) =>
      tool("vault_merge")(
        vault,
        {
          path_a: "pricing/src-a.md",
          path_b: "pricing/src-b.md",
          target_path: target,
          body: "# Merged\n\nBoth.\n",
          frontmatter: { superseded_by: null, ...frontmatter },
          agent: "x",
        },
        access,
      );

    it("refuses a writer when path_b is canonical; nothing is written", async () => {
      await seedDraft(vault, "pricing/src-a.md", "Src A");
      await seedCanonical(vault, "pricing/src-b.md", "Src B");
      const msg = errorOf(await merge(WRITER));
      expect(msg).toMatch(DENIAL);
      expect(msg).toContain("vault_merge");
      expect(await statusOf(vault, "pricing/merged.md")).toBeNull();
      expect(await statusOf(vault, "pricing/src-a.md")).toBe("draft");
      expect(await statusOf(vault, "pricing/src-b.md")).toBe("canonical");
    });

    it("refuses a writer when path_a is canonical and merged away into a new draft", async () => {
      await seedCanonical(vault, "pricing/src-a.md", "Src A");
      await seedDraft(vault, "pricing/src-b.md", "Src B");
      expect(errorOf(await merge(WRITER))).toMatch(DENIAL);
      expect(await statusOf(vault, "pricing/merged.md")).toBeNull();
      expect(await statusOf(vault, "pricing/src-a.md")).toBe("canonical");
    });

    it("refuses a writer folding into a canonical target with a non-canonical status", async () => {
      await seedCanonical(vault, "pricing/src-a.md", "Src A");
      await seedDraft(vault, "pricing/src-b.md", "Src B");
      expect(errorOf(await merge(WRITER, "pricing/src-a.md"))).toMatch(DENIAL);
      expect(await statusOf(vault, "pricing/src-a.md")).toBe("canonical");
      expect(await statusOf(vault, "pricing/src-b.md")).toBe("draft");
    });

    it("BOUNDARY: a writer may fold a draft into a canonical target that stays canonical", async () => {
      await seedCanonical(vault, "pricing/src-a.md", "Src A");
      await seedDraft(vault, "pricing/src-b.md", "Src B");
      value(await merge(WRITER, "pricing/src-a.md", { title: "Src A" }));
      expect(await statusOf(vault, "pricing/src-a.md")).toBe("canonical");
      expect(await statusOf(vault, "pricing/src-b.md")).toBe("superseded");
    });

    it("lets a writer merge two drafts", async () => {
      await seedDraft(vault, "pricing/src-a.md", "Src A");
      await seedDraft(vault, "pricing/src-b.md", "Src B");
      value(await merge(WRITER));
      expect(await statusOf(vault, "pricing/src-a.md")).toBe("superseded");
      expect(await statusOf(vault, "pricing/src-b.md")).toBe("superseded");
    });

    it("lets a promoter merge canonical docs away", async () => {
      await seedCanonical(vault, "pricing/src-a.md", "Src A");
      await seedCanonical(vault, "pricing/src-b.md", "Src B");
      value(await merge(PROMOTER));
      expect(await statusOf(vault, "pricing/src-a.md")).toBe("superseded");
      expect(await statusOf(vault, "pricing/src-b.md")).toBe("superseded");
    });

    it("operator (no access context) is unchanged", async () => {
      await seedCanonical(vault, "pricing/src-a.md", "Src A");
      await seedCanonical(vault, "pricing/src-b.md", "Src B");
      value(await merge(undefined));
      expect(await statusOf(vault, "pricing/src-b.md")).toBe("superseded");
    });
  });

  // ---- vault_write: a status change out of canonical ------------------------

  describe("vault_write status change", () => {
    const setStatus = (access: AccessContext, status: string) =>
      tool("vault_write")(
        vault,
        {
          path: "pricing/w.md",
          body: "# Seed\n\nBody.\n",
          frontmatter: { status },
          agent: "x",
        },
        access,
      );

    it("refuses a writer moving canonical → deprecated / archived / draft", async () => {
      await seedCanonical(vault, "pricing/w.md", "Seed");
      for (const s of ["deprecated", "archived", "draft"]) {
        const msg = errorOf(await setStatus(WRITER, s));
        expect(msg).toMatch(DENIAL);
        expect(msg).toContain("vault_write");
      }
      expect(await statusOf(vault, "pricing/w.md")).toBe("canonical");
    });

    it("lets a writer archive a draft", async () => {
      await seedDraft(vault, "pricing/w.md", "Seed");
      value(await setStatus(WRITER, "archived"));
      expect(await statusOf(vault, "pricing/w.md")).toBe("archived");
    });

    it("lets a promoter archive a canonical doc", async () => {
      await seedCanonical(vault, "pricing/w.md", "Seed");
      value(await setStatus(PROMOTER, "archived"));
      expect(await statusOf(vault, "pricing/w.md")).toBe("archived");
    });
  });

  // ---- vault_ratify: the ratifier's grant decides ---------------------------

  describe("vault_ratify of a staged retirement", () => {
    // The writer is refused directly and takes the suggested route: stage it.
    async function stage(
      actionType: string,
      target: string,
      diff: Record<string, unknown>,
    ): Promise<string> {
      const staged = value(
        await tool("vault_stage_action")(
          vault,
          {
            action_type: actionType,
            target_path: target,
            proposed_by: "agent:writer",
            rationale: "retire it",
            proposed_diff: diff,
          },
          WRITER,
        ),
      );
      return staged.id as string;
    }
    const ratify = (id: string, access: AccessContext) =>
      tool("vault_ratify")(vault, { id, decision: "approve", principal: access.user }, access);

    it("staged deprecate of a canonical doc: ratifier without promote refused, with promote applied", async () => {
      await seedCanonical(vault, "pricing/a.md");
      const id = await stage("deprecate", "pricing/a.md", {});
      const denied = errorOf(await ratify(id, RATIFIER));
      expect(denied).toMatch(DENIAL);
      expect(denied).toContain("role 'ratifier'");
      expect(await statusOf(vault, "pricing/a.md")).toBe("canonical");
      expect(value(await ratify(id, RATIFIER_PROMOTER)).applied).toBe(true);
      expect(await statusOf(vault, "pricing/a.md")).toBe("deprecated");
    }, 60_000);

    it("staged deprecate of a draft: a ratifier without promote may apply it", async () => {
      await seedDraft(vault, "pricing/a.md");
      const id = await stage("deprecate", "pricing/a.md", {});
      expect(value(await ratify(id, RATIFIER)).applied).toBe(true);
      expect(await statusOf(vault, "pricing/a.md")).toBe("deprecated");
    }, 60_000);

    it("staged supersede of a canonical doc: ratifier without promote refused, with promote applied", async () => {
      await seedCanonical(vault, "pricing/old.md", "Old");
      await seedDraft(vault, "pricing/new.md", "New");
      const id = await stage("supersede", "pricing/old.md", { superseded_by: "pricing/new.md" });
      expect(errorOf(await ratify(id, RATIFIER))).toMatch(DENIAL);
      expect(await statusOf(vault, "pricing/old.md")).toBe("canonical");
      expect(value(await ratify(id, RATIFIER_PROMOTER)).applied).toBe(true);
      expect(await statusOf(vault, "pricing/old.md")).toBe("superseded");
    }, 60_000);

    it("staged merge of a canonical source: ratifier without promote refused, with promote applied", async () => {
      await seedDraft(vault, "pricing/m-a.md", "M A");
      await seedCanonical(vault, "pricing/m-b.md", "M B");
      const id = await stage("merge", "pricing/m-a.md", {
        merge_from: ["pricing/m-a.md", "pricing/m-b.md"],
        body: "# Merged\n\nStaged.\n",
        frontmatter: { title: "Merged", status: "draft", superseded_by: null },
      });
      expect(errorOf(await ratify(id, RATIFIER))).toMatch(DENIAL);
      expect(await statusOf(vault, "pricing/m-b.md")).toBe("canonical");
      expect(value(await ratify(id, RATIFIER_PROMOTER)).applied).toBe(true);
      expect(await statusOf(vault, "pricing/m-b.md")).toBe("superseded");
    }, 60_000);
  });
});
