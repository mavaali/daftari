import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { runLint } from "../../src/curation/lint.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultDeprecate, vaultMerge, vaultSupersede, vaultWrite } from "../../src/tools/write.js";
import { log } from "../../src/utils/git.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:claude-code";

// Reads and writes pricing only: competitive-intel is an unreadable collection.
const PRICING_ONLY: AccessContext = {
  user: "pat",
  roleName: "pricing-editor",
  role: { read: ["pricing"], write: ["pricing"] },
};

async function seed(vault: string, path: string, overrides: Record<string, unknown> = {}) {
  const written = await vaultWrite(vault, {
    path,
    body: `# A Note\n\nBody of ${path}.\n`,
    frontmatter: {
      title: "A Note",
      domain: "accumulation",
      collection: path.split("/")[0],
      status: "canonical",
      confidence: "medium",
      created: "2026-05-01",
      provenance: "direct",
      sources: [],
      superseded_by: null,
      ttl_days: 90,
      tags: ["note"],
      ...overrides,
    },
    agent: "agent:seed",
  });
  if (!written.ok) throw written.error;
}

async function headCommit(vault: string): Promise<string | undefined> {
  const history = await log(vault, {});
  return history.ok ? history.value[0]?.hash : undefined;
}

async function statusOf(vault: string, path: string): Promise<[string, string | null]> {
  const read = await vaultRead(vault, path);
  if (!read.ok) throw read.error;
  return [read.value.frontmatter.status, read.value.frontmatter.superseded_by];
}

describe("supersede loop guard", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  describe("vault_supersede", () => {
    it("refuses to close a two-document loop and writes nothing", async () => {
      await seed(vault, "pricing/a.md", {
        status: "superseded",
        superseded_by: "pricing/b.md",
      });
      await seed(vault, "pricing/b.md");
      const head = await headCommit(vault);

      const result = await vaultSupersede(vault, {
        old_path: "pricing/b.md",
        new_path: "pricing/a.md",
        agent: AGENT,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("loop");
      expect(result.error.message).toContain("pricing/a.md");
      expect(result.error.message).toContain("pricing/b.md");
      expect(await statusOf(vault, "pricing/b.md")).toEqual(["canonical", null]);
      expect(await headCommit(vault)).toBe(head);
    }, 60_000);

    it("refuses a loop closed through a longer chain", async () => {
      await seed(vault, "pricing/a.md", { status: "superseded", superseded_by: "pricing/b.md" });
      await seed(vault, "pricing/b.md", { status: "superseded", superseded_by: "pricing/c.md" });
      await seed(vault, "pricing/c.md");

      const result = await vaultSupersede(vault, {
        old_path: "pricing/c.md",
        new_path: "pricing/a.md",
        agent: AGENT,
      });

      expect(result.ok).toBe(false);
      expect(await statusOf(vault, "pricing/c.md")).toEqual(["canonical", null]);
    }, 60_000);

    it("refuses a self-supersede spelled through a path alias", async () => {
      await seed(vault, "pricing/a.md");

      const result = await vaultSupersede(vault, {
        old_path: "pricing/a.md",
        new_path: "./pricing/a.md",
        agent: AGENT,
      });

      expect(result.ok).toBe(false);
      expect(await statusOf(vault, "pricing/a.md")).toEqual(["canonical", null]);
    }, 60_000);

    it("sees the loop when superseded_by was stored under an alias", async () => {
      await seed(vault, "pricing/a.md", {
        status: "superseded",
        superseded_by: "b.md",
      });
      await seed(vault, "pricing/b.md");

      const result = await vaultSupersede(vault, {
        old_path: "pricing/b.md",
        new_path: "pricing/a.md",
        agent: AGENT,
      });

      expect(result.ok).toBe(false);
    }, 60_000);

    describe("a chain through a document the caller cannot read", () => {
      async function seedHiddenHop() {
        await seed(vault, "pricing/a.md");
        await seed(vault, "competitive-intel/hidden.md", {
          status: "superseded",
          superseded_by: "pricing/a.md",
        });
        await seed(vault, "pricing/b.md", {
          status: "superseded",
          superseded_by: "competitive-intel/hidden.md",
        });
      }
      const args = { old_path: "pricing/a.md", new_path: "pricing/b.md", agent: AGENT };

      it("is no oracle: the caller gets the same result as for a dangling chain", async () => {
        await seedHiddenHop();
        await seed(vault, "pricing/x.md");
        await seed(vault, "pricing/y.md", {
          status: "superseded",
          superseded_by: "competitive-intel/unrelated.md",
        });

        const probe = await vaultSupersede(vault, args, PRICING_ONLY);
        const control = await vaultSupersede(
          vault,
          { old_path: "pricing/x.md", new_path: "pricing/y.md", agent: AGENT },
          PRICING_ONLY,
        );

        expect(probe.ok).toBe(true);
        expect(control.ok).toBe(true);
      }, 60_000);

      it("is still refused for a caller who can read every hop", async () => {
        await seedHiddenHop();

        const result = await vaultSupersede(vault, args);

        expect(result.ok).toBe(false);
        expect(await statusOf(vault, "pricing/a.md")).toEqual(["canonical", null]);
      }, 60_000);

      it("is reported by a lint run that can see the hop, and only that one", async () => {
        await seedHiddenHop();
        const written = await vaultSupersede(vault, args, PRICING_ONLY);
        expect(written.ok).toBe(true);

        const full = await runLint(vault);
        const scoped = await runLint(vault, { pathVisible: (p) => p.startsWith("pricing/") });

        expect(full.ok && full.value.checks.supersedeChains).toHaveLength(1);
        expect(scoped.ok && scoped.value.checks.supersedeChains).toEqual([]);
      }, 60_000);
    });

    it("lets a loop be repaired by pointing one member at a third doc", async () => {
      await seed(vault, "pricing/a.md", { status: "superseded", superseded_by: "pricing/b.md" });
      await seed(vault, "pricing/b.md", { status: "superseded", superseded_by: "pricing/a.md" });
      await seed(vault, "pricing/c.md");

      const result = await vaultSupersede(vault, {
        old_path: "pricing/a.md",
        new_path: "pricing/c.md",
        agent: AGENT,
      });

      expect(result.ok).toBe(true);
      expect(await statusOf(vault, "pricing/a.md")).toEqual(["superseded", "pricing/c.md"]);
    }, 60_000);

    it.each(["superseded", "deprecated"])(
      "writes but warns when the successor is itself %s",
      async (status) => {
        await seed(vault, "pricing/a.md");
        await seed(vault, "pricing/b.md", {
          status,
          ...(status === "superseded" ? { superseded_by: "pricing/c.md" } : {}),
        });
        await seed(vault, "pricing/c.md");

        const result = await vaultSupersede(vault, {
          old_path: "pricing/a.md",
          new_path: "pricing/b.md",
          agent: AGENT,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.successor_warning).toContain(status);
        expect(result.value.successor_warning).toContain("pricing/b.md");
        expect(await statusOf(vault, "pricing/a.md")).toEqual(["superseded", "pricing/b.md"]);
      },
      60_000,
    );

    it("carries no warning when the successor is live", async () => {
      await seed(vault, "pricing/a.md");
      await seed(vault, "pricing/b.md");

      const result = await vaultSupersede(vault, {
        old_path: "pricing/a.md",
        new_path: "pricing/b.md",
        agent: AGENT,
      });

      expect(result.ok && result.value.successor_warning).toBeUndefined();
    }, 60_000);

    it("does not disclose the status of a successor the caller cannot read", async () => {
      await seed(vault, "pricing/a.md");
      await seed(vault, "competitive-intel/retired.md", { status: "deprecated" });

      const result = await vaultSupersede(
        vault,
        { old_path: "pricing/a.md", new_path: "competitive-intel/retired.md", agent: AGENT },
        PRICING_ONLY,
      );

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.successor_warning).toBeUndefined();
    }, 60_000);
  });

  describe("vault_deprecate", () => {
    it("refuses a superseded_by that closes a loop and writes nothing", async () => {
      await seed(vault, "pricing/a.md", { status: "superseded", superseded_by: "pricing/b.md" });
      await seed(vault, "pricing/b.md");

      const result = await vaultDeprecate(vault, {
        path: "pricing/b.md",
        reason: "replaced",
        superseded_by: "pricing/a.md",
        agent: AGENT,
      });

      expect(result.ok).toBe(false);
      expect(await statusOf(vault, "pricing/b.md")).toEqual(["canonical", null]);
    }, 60_000);

    it("still accepts a forward that does not exist yet", async () => {
      await seed(vault, "pricing/a.md");

      const result = await vaultDeprecate(vault, {
        path: "pricing/a.md",
        reason: "replaced",
        superseded_by: "pricing/not-yet.md",
        agent: AGENT,
      });

      expect(result.ok).toBe(true);
    }, 60_000);
  });

  describe("vault_merge", () => {
    it("refuses when the target would inherit a pointer back at a source", async () => {
      // The target inherits path_a's frontmatter, including superseded_by.
      await seed(vault, "pricing/a.md", { status: "superseded", superseded_by: "pricing/b.md" });
      await seed(vault, "pricing/b.md");

      const result = await vaultMerge(vault, {
        path_a: "pricing/a.md",
        path_b: "pricing/b.md",
        target_path: "pricing/merged.md",
        body: "# Merged\n",
        agent: AGENT,
      });

      expect(result.ok).toBe(false);
      expect(await statusOf(vault, "pricing/b.md")).toEqual(["canonical", null]);
      expect((await vaultRead(vault, "pricing/merged.md")).ok).toBe(false);
    }, 60_000);

    it("allows the merge once the override clears the inherited pointer", async () => {
      await seed(vault, "pricing/a.md", { status: "superseded", superseded_by: "pricing/b.md" });
      await seed(vault, "pricing/b.md");

      const result = await vaultMerge(vault, {
        path_a: "pricing/a.md",
        path_b: "pricing/b.md",
        target_path: "pricing/merged.md",
        body: "# Merged\n",
        frontmatter: { status: "canonical", superseded_by: null },
        agent: AGENT,
      });

      expect(result.ok).toBe(true);
    }, 60_000);
  });
});
