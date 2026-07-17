import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStagedActionById, stageAction } from "../../src/curation/staged-actions.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultRatify, vaultStageAction } from "../../src/tools/staged-actions.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:curation-loop";
const HUMAN = "human:mihir";

function draftFrontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Federation Spec",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-05-01",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: ["spec"],
    ...overrides,
  };
}

async function seedDraft(
  vault: string,
  path: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const written = await vaultWrite(vault, {
    path,
    body: "# Federation Spec\n\nBody.\n",
    frontmatter: draftFrontmatter(overrides),
    agent: "agent:seed",
  });
  if (!written.ok) throw written.error;
}

describe("vault_stage_action", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("stages an action and returns its id + expiry", async () => {
    await seedDraft(vault, "pricing/foo.md");
    const result = await vaultStageAction(vault, {
      action_type: "promote",
      target_path: "pricing/foo.md",
      proposed_by: AGENT,
      rationale: "Matured beyond draft.",
      proposed_diff: { status: { from: "draft", to: "canonical" } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.id).toBe("stage-001");
    expect(result.value.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("denies a role that lacks write access to the target collection", async () => {
    await seedDraft(vault, "pricing/foo.md");
    const readOnly = {
      user: "agent:reader",
      roleName: "reader",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };
    const result = await vaultStageAction(
      vault,
      {
        action_type: "promote",
        target_path: "pricing/foo.md",
        proposed_by: AGENT,
        rationale: "read-only role should not be able to stage this",
        proposed_diff: { status: { from: "draft", to: "canonical" } },
      },
      readOnly,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("access denied");
  });

  it("allows a role with write access to the target collection", async () => {
    await seedDraft(vault, "pricing/foo.md");
    const writer = {
      user: "agent:writer",
      roleName: "writer",
      role: { read: ["pricing"], write: ["pricing"], promote: false, ratify: false },
    };
    const result = await vaultStageAction(
      vault,
      {
        action_type: "promote",
        target_path: "pricing/foo.md",
        proposed_by: AGENT,
        rationale: "writer may stage",
        proposed_diff: { status: { from: "draft", to: "canonical" } },
      },
      writer,
    );
    expect(result.ok).toBe(true);
  });

  it("denies a write-less role for an absent target without leaking existence", async () => {
    // The target does not exist. A role lacking write must get 'access denied'
    // (derived from the path-segment collection) — NOT 'not found' — so the
    // not-found signal can't be used to probe document existence.
    const readOnly = {
      user: "agent:reader",
      roleName: "reader",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };
    const result = await vaultStageAction(
      vault,
      {
        action_type: "promote",
        target_path: "pricing/ghost.md",
        proposed_by: AGENT,
        rationale: "absent target, no write grant",
        proposed_diff: {},
      },
      readOnly,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("access denied");
    expect(result.error.message).not.toContain("not found");
  });

  it("returns not-found to an authorized writer for an absent target", async () => {
    const writer = {
      user: "agent:writer",
      roleName: "writer",
      role: { read: ["pricing"], write: ["pricing"], promote: false, ratify: false },
    };
    const result = await vaultStageAction(
      vault,
      {
        action_type: "promote",
        target_path: "pricing/ghost.md",
        proposed_by: AGENT,
        rationale: "absent target, has write grant",
        proposed_diff: {},
      },
      writer,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("not found");
  });

  it("rejects an action whose target document does not exist", async () => {
    const result = await vaultStageAction(vault, {
      action_type: "promote",
      target_path: "pricing/does-not-exist.md",
      proposed_by: AGENT,
      rationale: "x",
      proposed_diff: {},
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a missing required argument", async () => {
    const result = await vaultStageAction(vault, {
      action_type: "promote",
      proposed_by: AGENT,
      rationale: "x",
      proposed_diff: {},
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown action_type", async () => {
    const result = await vaultStageAction(vault, {
      action_type: "frobnicate",
      target_path: "pricing/foo.md",
      proposed_by: AGENT,
      rationale: "x",
      proposed_diff: {},
    });
    expect(result.ok).toBe(false);
  });
});

describe("vault_ratify", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("approves a promote: dispatches vault_promote, commits, marks ratified", async () => {
    await seedDraft(vault, "pricing/federation.md");
    const staged = await stageAction(vault, {
      actionType: "promote",
      targetPath: "pricing/federation.md",
      proposedBy: AGENT,
      rationale: "Matured.",
      proposedDiff: { status: { from: "draft", to: "canonical" } },
    });
    if (!staged.ok) return;

    const ratified = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
      reason: "settled",
    });
    expect(ratified.ok).toBe(true);
    if (!ratified.ok) return;
    expect(ratified.value.applied).toBe(true);
    expect(ratified.value.commit).toMatch(/^[0-9a-f]+$/);

    // The document is now canonical.
    const read = await vaultRead(vault, "pricing/federation.md");
    expect(read.ok && read.value.frontmatter.status).toBe("canonical");

    // The action collapses to ratified.
    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("ratified");
  }, 60_000);

  it("rejects an action: records rejection, applies nothing", async () => {
    const staged = await stageAction(vault, {
      actionType: "promote",
      targetPath: "pricing/federation.md",
      proposedBy: AGENT,
      rationale: "Matured.",
      proposedDiff: {},
    });
    if (!staged.ok) return;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "reject",
      principal: HUMAN,
      reason: "not ready",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(false);

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("rejected");
  });

  it("approves a supersede: dispatches vault_supersede, marks ratified (§11.4)", async () => {
    await seedDraft(vault, "pricing/old.md");
    await seedDraft(vault, "pricing/new.md");
    const staged = await stageAction(vault, {
      actionType: "supersede",
      targetPath: "pricing/old.md",
      proposedBy: AGENT,
      rationale: "Replaced by new analysis.",
      proposedDiff: { superseded_by: "pricing/new.md" },
    });
    if (!staged.ok) return;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(true);
    expect(result.value.commit).toMatch(/^[0-9a-f]+$/);

    const read = await vaultRead(vault, "pricing/old.md");
    expect(read.ok && read.value.frontmatter.status).toBe("superseded");
    expect(read.ok && read.value.frontmatter.superseded_by).toBe("pricing/new.md");

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("ratified");
  }, 60_000);

  it("approves a confidence-up: dispatches vault_set_confidence (§11.4)", async () => {
    await seedDraft(vault, "pricing/conf.md", { confidence: "low" });
    const staged = await stageAction(vault, {
      actionType: "confidence-up",
      targetPath: "pricing/conf.md",
      proposedBy: AGENT,
      rationale: "Survived three independent re-derivations.",
      proposedDiff: { confidence: "high" },
    });
    if (!staged.ok) return;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(true);

    const read = await vaultRead(vault, "pricing/conf.md");
    expect(read.ok && read.value.frontmatter.confidence).toBe("high");

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("ratified");
  }, 60_000);

  it("approves a merge: dispatches vault_merge, supersedes both sources (§11.4)", async () => {
    await seedDraft(vault, "pricing/a.md");
    await seedDraft(vault, "pricing/b.md");
    const staged = await stageAction(vault, {
      actionType: "merge",
      targetPath: "pricing/merged.md",
      proposedBy: AGENT,
      rationale: "Two overlapping specs converged.",
      proposedDiff: {
        merge_from: ["pricing/a.md", "pricing/b.md"],
        body: "# Merged\n\nCombined.\n",
      },
    });
    if (!staged.ok) return;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(true);

    const target = await vaultRead(vault, "pricing/merged.md");
    expect(target.ok && target.value.content).toContain("Combined.");
    const a = await vaultRead(vault, "pricing/a.md");
    expect(a.ok && a.value.frontmatter.status).toBe("superseded");

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("ratified");
  }, 60_000);

  it("leaves a malformed supersede pending (no superseded_by in diff)", async () => {
    await seedDraft(vault, "pricing/old.md");
    const staged = await stageAction(vault, {
      actionType: "supersede",
      targetPath: "pricing/old.md",
      proposedBy: AGENT,
      rationale: "Missing successor.",
      proposedDiff: {},
    });
    if (!staged.ok) return;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(false);

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("pending");
  }, 60_000);

  it("leaves a malformed merge pending (merge_from not two paths)", async () => {
    await seedDraft(vault, "pricing/a.md");
    const staged = await stageAction(vault, {
      actionType: "merge",
      targetPath: "pricing/merged.md",
      proposedBy: AGENT,
      rationale: "Bad merge diff.",
      proposedDiff: { merge_from: ["pricing/a.md"], body: "x" },
    });
    if (!staged.ok) return;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(false);

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("pending");
  }, 60_000);

  it("leaves a malformed confidence-up pending (no confidence in diff)", async () => {
    await seedDraft(vault, "pricing/conf.md", { confidence: "low" });
    const staged = await stageAction(vault, {
      actionType: "confidence-up",
      targetPath: "pricing/conf.md",
      proposedBy: AGENT,
      rationale: "Missing confidence value.",
      proposedDiff: {},
    });
    if (!staged.ok) return;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(false);

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("pending");
  }, 60_000);

  it("vault_ratify approve stamps decidedByPrincipal on the ratified record", async () => {
    await seedDraft(vault, "pricing/stamp-approve.md");
    const staged = await stageAction(vault, {
      actionType: "promote",
      targetPath: "pricing/stamp-approve.md",
      proposedBy: AGENT,
      rationale: "Matured — approve stamp test.",
      proposedDiff: { status: { from: "draft", to: "canonical" } },
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw staged.error;

    const access = {
      user: "agent:curation-loop",
      roleName: "curator",
      role: { read: ["*"], write: ["*"], promote: true, ratify: true },
    };

    const ratified = await vaultRatify(
      vault,
      { id: staged.value.id, decision: "approve", principal: HUMAN, reason: "verified" },
      access,
    );
    expect(ratified.ok).toBe(true);
    if (!ratified.ok) throw ratified.error;
    expect(ratified.value.applied).toBe(true);

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok).toBe(true);
    if (!action.ok) throw action.error;
    expect(action.value?.decidedByPrincipal).toBe("agent:curation-loop");
  }, 60_000);

  it("vault_ratify reject stamps the authenticated principal", async () => {
    const staged = await stageAction(vault, {
      actionType: "promote",
      targetPath: "pricing/federation.md",
      proposedBy: AGENT,
      rationale: "Matured.",
      proposedDiff: {},
    });
    if (!staged.ok) return;

    const access = {
      user: "agent:curation-loop",
      roleName: "curator",
      role: { read: ["*"], write: ["*"], promote: true, ratify: true },
    };

    const result = await vaultRatify(
      vault,
      { id: staged.value.id, decision: "reject", principal: "human:mihir" },
      access,
    );
    expect(result.ok).toBe(true);

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok).toBe(true);
    if (!action.ok || !action.value) return;
    expect(action.value.decidedByPrincipal).toBe("agent:curation-loop");
  });

  it("errors when ratifying an unknown id", async () => {
    const result = await vaultRatify(vault, {
      id: "stage-999",
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(false);
  });

  it("errors when ratifying an already-decided action", async () => {
    const staged = await stageAction(vault, {
      actionType: "promote",
      targetPath: "pricing/federation.md",
      proposedBy: AGENT,
      rationale: "x",
      proposedDiff: {},
    });
    if (!staged.ok) return;
    await vaultRatify(vault, { id: staged.value.id, decision: "reject", principal: HUMAN });
    const again = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(again.ok).toBe(false);
  });
});

// Tier 0 ratify gate (#232 via #236 QW1): an approval that would introduce a
// certain structural defect is refused, and the action stays pending — same
// retryable posture as a dispatch failure. Direct writes stay unblocked;
// curation stays advisory. Only the ratification control point gates.
describe("tier 0 ratify gate", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  async function seedDoc(
    path: string,
    over: { status?: string; sources?: string[]; collection?: string } = {},
  ): Promise<void> {
    const written = await vaultWrite(vault, {
      path,
      body: `# Doc\n\nBody of ${path}.\n`,
      frontmatter: draftFrontmatter({
        status: over.status ?? "draft",
        sources: over.sources ?? [],
        collection: over.collection ?? "pricing",
      }),
      agent: "agent:seed",
    });
    if (!written.ok) throw written.error;
  }

  async function stageAndApprove(
    actionType: string,
    targetPath: string,
    access?: Parameters<typeof vaultRatify>[2],
  ) {
    const staged = await stageAction(vault, {
      actionType: actionType as never,
      targetPath,
      proposedBy: AGENT,
      rationale: "Tier 0 gate test.",
      proposedDiff: {},
    });
    if (!staged.ok) throw staged.error;
    const result = await vaultRatify(
      vault,
      { id: staged.value.id, decision: "approve", principal: HUMAN },
      access,
    );
    return { id: staged.value.id, result };
  }

  it("refuses to promote a doc whose source is still draft, leaving the action pending", async () => {
    await seedDoc("pricing/dep.md", { status: "draft" });
    await seedDoc("pricing/target.md", { status: "draft", sources: ["pricing/dep.md"] });
    const { id, result } = await stageAndApprove("promote", "pricing/target.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("pricing/dep.md");
    const after = await getStagedActionById(vault, id);
    expect(after.ok && after.value?.status).toBe("pending");
  }, 60_000);

  it("refuses to promote a doc with a broken vault-path source ref", async () => {
    await seedDoc("pricing/target2.md", { status: "draft", sources: ["pricing/vanished.md"] });
    const { result } = await stageAndApprove("promote", "pricing/target2.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("pricing/vanished.md");
  }, 60_000);

  it("promotes cleanly when sources are canonical or external provenance", async () => {
    await seedDoc("pricing/base.md", { status: "canonical" });
    await seedDoc("pricing/t3.md", {
      status: "draft",
      sources: ["pricing/base.md", "interview with the platform team"],
    });
    const { result } = await stageAndApprove("promote", "pricing/t3.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(true);
  }, 60_000);

  it("refuses to deprecate a doc canonical dependents rely on, naming visible ones", async () => {
    await seedDoc("pricing/base2.md", { status: "canonical" });
    await seedDoc("pricing/cert.md", { status: "canonical", sources: ["pricing/base2.md"] });
    const { id, result } = await stageAndApprove("deprecate", "pricing/base2.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("pricing/cert.md");
    const after = await getStagedActionById(vault, id);
    expect(after.ok && after.value?.status).toBe("pending");
  }, 60_000);

  it("coarsens dependents in unreadable collections instead of naming them (#217)", async () => {
    await seedDoc("pricing/base3.md", { status: "canonical" });
    await seedDoc("intel/hidden-cert.md", {
      status: "canonical",
      sources: ["pricing/base3.md"],
      collection: "intel",
    });
    const restricted = {
      user: "human:reviewer",
      roleName: "pricing-ratifier",
      role: { read: ["pricing"], write: [], promote: false, ratify: true },
    };
    const { result } = await stageAndApprove("deprecate", "pricing/base3.md", restricted);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toContain("intel/hidden-cert.md");
    expect(result.error.message).toContain("some");
  }, 60_000);
});
