import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { getStagedActionById, listStagedActions } from "../../src/curation/staged-actions.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultRatify } from "../../src/tools/staged-actions.js";
import { vaultAppend, vaultDeprecate, vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// #235 delta 4: the propose-only role. Structural enforcement — the
// permission layer coerces/denies; nothing depends on agent convention.

const PROPOSER = {
  user: "agent:proposer",
  roleName: "agent-proposer",
  role: { read: ["*"], write: ["*"], promote: false, ratify: false, proposeOnly: true },
};

const ADMIN = {
  user: "human:mihir",
  roleName: "admin",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Proposed Doc",
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

describe("propose-only role (#235)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("coerces vault_write into a staged write proposal — nothing written", async () => {
    const result = await vaultWrite(
      vault,
      {
        path: "pricing/proposed.md",
        body: "# Proposed\n\nContent.\n",
        frontmatter: frontmatter(),
        agent: "agent:proposer",
        run_id: "run-007",
      },
      PROPOSER,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.action).toBe("staged");
    expect(result.value.committed).toBe(false);
    expect(result.value.staged_id).toMatch(/^stage-/);
    expect(result.value.conflicts_with).toEqual([]);

    // No file landed.
    const read = await vaultRead(vault, "pricing/proposed.md");
    expect(read.ok).toBe(false);

    // The proposal is pending, typed write, and carries the run id.
    const action = await getStagedActionById(vault, result.value.staged_id as string);
    expect(action.ok).toBe(true);
    if (!action.ok) throw action.error;
    expect(action.value?.status).toBe("pending");
    expect(action.value?.actionType).toBe("write");
    expect(action.value?.runId).toBe("run-007");
  });

  it("a ratified coerced proposal lands with the proposer's run id in provenance", async () => {
    const staged = await vaultWrite(
      vault,
      {
        path: "pricing/proposed.md",
        body: "# Proposed\n\nContent.\n",
        frontmatter: frontmatter(),
        agent: "agent:proposer",
        run_id: "run-007",
      },
      PROPOSER,
    );
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw staged.error;

    const ratified = await vaultRatify(
      vault,
      { id: staged.value.staged_id, decision: "approve", principal: "human:mihir" },
      ADMIN,
    );
    expect(ratified.ok).toBe(true);
    if (!ratified.ok) throw ratified.error;
    expect(ratified.value.applied).toBe(true);

    const read = await vaultRead(vault, "pricing/proposed.md");
    expect(read.ok && read.value.content).toContain("Content.");

    const log = await readProvenanceLog(vault);
    expect(log.ok).toBe(true);
    if (!log.ok) throw log.error;
    const entry = log.value.find((e) => e.file === "pricing/proposed.md");
    expect(entry?.run_id).toBe("run-007");
  }, 60_000);

  it("two propose-only agents contesting one target both land as pending + tension", async () => {
    const first = await vaultWrite(
      vault,
      {
        path: "pricing/contested.md",
        body: "# Contested\n\nLimit is 40.\n",
        frontmatter: frontmatter({ title: "Contested" }),
        agent: "agent:alpha",
      },
      PROPOSER,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;

    const second = await vaultWrite(
      vault,
      {
        path: "pricing/contested.md",
        body: "# Contested\n\nLimit is 60.\n",
        frontmatter: frontmatter({ title: "Contested" }),
        agent: "agent:beta",
      },
      PROPOSER,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw second.error;
    expect(second.value.conflicts_with).toEqual([first.value.staged_id]);
    expect(second.value.tension_id).toMatch(/^tension-/);

    const pending = await listStagedActions(vault, "pending");
    expect(pending.ok).toBe(true);
    if (!pending.ok) throw pending.error;
    expect(pending.value.map((a) => a.id).sort()).toEqual(
      [first.value.staged_id, second.value.staged_id].sort(),
    );
  });

  it("denies vault_append and vault_deprecate with a pointer to staging", async () => {
    const append = await vaultAppend(
      vault,
      {
        path: "pricing/helios-consumption-pricing.md",
        section: "## Note\n",
        agent: "agent:proposer",
      },
      PROPOSER,
    );
    expect(append.ok).toBe(false);
    if (append.ok) return;
    expect(append.error.message).toContain("propose-only");
    expect(append.error.message).toContain("vault_stage_action");

    const deprecate = await vaultDeprecate(
      vault,
      {
        path: "pricing/helios-consumption-pricing.md",
        reason: "trying a direct deprecate",
        agent: "agent:proposer",
      },
      PROPOSER,
    );
    expect(deprecate.ok).toBe(false);
    if (deprecate.ok) return;
    expect(deprecate.error.message).toContain("propose-only");
  });

  it("still respects the write grant: cannot propose into an unwritable collection", async () => {
    const scoped = {
      user: "agent:proposer",
      roleName: "scoped-proposer",
      role: {
        read: ["*"],
        write: ["competitive-intel"],
        promote: false,
        ratify: false,
        proposeOnly: true,
      },
    };
    const result = await vaultWrite(
      vault,
      {
        path: "pricing/out-of-scope.md",
        body: "# Nope\n",
        frontmatter: frontmatter(),
        agent: "agent:proposer",
      },
      scoped,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("access denied");
  });
});
