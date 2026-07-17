import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { getStagedActionById, stageAction } from "../../src/curation/staged-actions.js";
import { listTensions } from "../../src/curation/tension.js";
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

  it("tier-0 gate blocks promoting a doc that cites a draft source", async () => {
    await seedDraft(vault, "pricing/base.md");
    await seedDraft(vault, "pricing/dep.md", { sources: ["pricing/base.md"] });
    const staged = await stageAction(vault, {
      actionType: "promote",
      targetPath: "pricing/dep.md",
      proposedBy: AGENT,
      rationale: "Matured — but its source has not.",
      proposedDiff: { status: { from: "draft", to: "canonical" } },
    });
    if (!staged.ok) throw staged.error;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("tier-0 gate blocked promote");
    expect(result.error.message).toContain("source pricing/base.md is draft");

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("pending");
  }, 60_000);

  it("tier-0 gate passes a promote whose source is canonical", async () => {
    await seedDraft(vault, "pricing/base.md", { status: "canonical" });
    await seedDraft(vault, "pricing/dep.md", { sources: ["pricing/base.md"] });
    const staged = await stageAction(vault, {
      actionType: "promote",
      targetPath: "pricing/dep.md",
      proposedBy: AGENT,
      rationale: "Matured, source certified.",
      proposedDiff: { status: { from: "draft", to: "canonical" } },
    });
    if (!staged.ok) throw staged.error;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(true);
  }, 60_000);

  it("tier-0 gate blocks an unforwarded deprecate with canonical dependents", async () => {
    await seedDraft(vault, "pricing/lib.md", { status: "canonical" });
    await seedDraft(vault, "pricing/user.md", {
      status: "canonical",
      sources: ["pricing/lib.md"],
    });
    const staged = await stageAction(vault, {
      actionType: "deprecate",
      targetPath: "pricing/lib.md",
      proposedBy: AGENT,
      rationale: "Retire it.",
      proposedDiff: {},
    });
    if (!staged.ok) throw staged.error;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("tier-0 gate blocked deprecate");
    expect(result.error.message).toContain("pricing/user.md");

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("pending");
  }, 60_000);

  it("tier-0 gate passes a deprecate that forwards dependents via superseded_by", async () => {
    await seedDraft(vault, "pricing/lib.md", { status: "canonical" });
    await seedDraft(vault, "pricing/lib2.md", { status: "canonical" });
    await seedDraft(vault, "pricing/user.md", {
      status: "canonical",
      sources: ["pricing/lib.md"],
    });
    const staged = await stageAction(vault, {
      actionType: "deprecate",
      targetPath: "pricing/lib.md",
      proposedBy: AGENT,
      rationale: "Replaced.",
      proposedDiff: { superseded_by: "pricing/lib2.md" },
    });
    if (!staged.ok) throw staged.error;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(true);

    const read = await vaultRead(vault, "pricing/lib.md");
    expect(read.ok && read.value.frontmatter.status).toBe("deprecated");
  }, 60_000);

  it("tier-0 gate coarsens dependents hidden from the ratifier's role (#217 B′)", async () => {
    await seedDraft(vault, "pricing/lib.md", { status: "canonical" });
    await seedDraft(vault, "intel/user.md", {
      status: "canonical",
      collection: "intel",
      sources: ["pricing/lib.md"],
    });
    const staged = await stageAction(vault, {
      actionType: "deprecate",
      targetPath: "pricing/lib.md",
      proposedBy: AGENT,
      rationale: "Retire it.",
      proposedDiff: {},
    });
    if (!staged.ok) throw staged.error;

    const pricingRatifier = {
      user: "human:mihir",
      roleName: "pricing-ratifier",
      role: { read: ["pricing"], write: ["*"], promote: true, ratify: true },
    };
    const result = await vaultRatify(
      vault,
      { id: staged.value.id, decision: "approve", principal: HUMAN },
      pricingRatifier,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("hidden canonical dependents: some");
    expect(result.error.message).not.toContain("intel/user.md");
  }, 60_000);

  it("approves a write: dispatches vault_write, creates a NEW document (#235)", async () => {
    const staged = await vaultStageAction(vault, {
      action_type: "write",
      target_path: "pricing/fresh-analysis.md",
      proposed_by: AGENT,
      rationale: "New synthesis from run traces.",
      proposed_diff: {
        frontmatter: draftFrontmatter({ title: "Fresh Analysis" }),
        body: "# Fresh Analysis\n\nProposed content.\n",
      },
      run_id: "run-042",
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw staged.error;
    expect(staged.value.conflicts_with).toEqual([]);
    expect(staged.value.tension_id).toBeNull();

    // The run id is stamped on the proposal record.
    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.runId).toBe("run-042");

    // Nothing is written until ratification.
    const before = await vaultRead(vault, "pricing/fresh-analysis.md");
    expect(before.ok).toBe(false);

    const ratified = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(ratified.ok).toBe(true);
    if (!ratified.ok) throw ratified.error;
    expect(ratified.value.applied).toBe(true);

    const read = await vaultRead(vault, "pricing/fresh-analysis.md");
    expect(read.ok && read.value.content).toContain("Proposed content.");

    // The proposer's run id rode through the dispatch into provenance.
    const log = await readProvenanceLog(vault);
    expect(log.ok).toBe(true);
    if (!log.ok) throw log.error;
    const entry = log.value.find(
      (e) => e.file === "pricing/fresh-analysis.md" && e.tool === "vault_write",
    );
    expect(entry?.run_id).toBe("run-042");
  }, 60_000);

  it("two contradictory write proposals: both pending, inter-proposal tension, served value unchanged (#235 acceptance)", async () => {
    await seedDraft(vault, "pricing/contested.md", {
      status: "canonical",
    });

    const first = await vaultStageAction(vault, {
      action_type: "write",
      target_path: "pricing/contested.md",
      proposed_by: "agent:alpha",
      rationale: "The limit is 40 units.",
      proposed_diff: {
        frontmatter: draftFrontmatter({ title: "Contested" }),
        body: "# Contested\n\nThe limit is 40 units.\n",
      },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;
    expect(first.value.conflicts_with).toEqual([]);

    const second = await vaultStageAction(vault, {
      action_type: "write",
      target_path: "pricing/contested.md",
      proposed_by: "agent:beta",
      rationale: "The limit is 60 units.",
      proposed_diff: {
        frontmatter: draftFrontmatter({ title: "Contested" }),
        body: "# Contested\n\nThe limit is 60 units.\n",
      },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw second.error;

    // Deterministic outcome: the conflict is surfaced, never silent.
    expect(second.value.conflicts_with).toEqual([first.value.id]);
    expect(second.value.tension_id).toMatch(/^tension-/);

    // Both proposals are pending — neither promoted, no last-write-wins.
    const a = await getStagedActionById(vault, first.value.id);
    const b = await getStagedActionById(vault, second.value.id);
    expect(a.ok && a.value?.status).toBe("pending");
    expect(b.ok && b.value?.status).toBe("pending");

    // The tension is typed inter-proposal, a self-tension on the target.
    const tensions = await listTensions(vault);
    expect(tensions.ok).toBe(true);
    if (!tensions.ok) throw tensions.error;
    const t = tensions.value.find((x) => x.id === second.value.tension_id);
    expect(t?.kind).toBe("inter-proposal");
    expect(t?.sourceA).toBe("pricing/contested.md");
    expect(t?.sourceB).toBe("pricing/contested.md");
    expect(t?.claimA).toContain(first.value.id);
    expect(t?.claimB).toContain(second.value.id);

    // The vault's served value is unchanged.
    const read = await vaultRead(vault, "pricing/contested.md");
    expect(read.ok && read.value.content).toContain("Body.");
    expect(read.ok && read.value.content).not.toContain("40 units");
  }, 60_000);

  it("tier-0 gate blocks ratifying a canonical write proposal citing a draft source", async () => {
    await seedDraft(vault, "pricing/wip-source.md");
    const staged = await vaultStageAction(vault, {
      action_type: "write",
      target_path: "pricing/bold-claim.md",
      proposed_by: AGENT,
      rationale: "Lands directly as canonical.",
      proposed_diff: {
        frontmatter: draftFrontmatter({
          title: "Bold Claim",
          status: "canonical",
          sources: ["pricing/wip-source.md"],
        }),
        body: "# Bold Claim\n",
      },
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw staged.error;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("tier-0 gate blocked canonical write");
    expect(result.error.message).toContain("pricing/wip-source.md");

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("pending");
  }, 60_000);

  it("leaves a malformed write pending (no body in diff)", async () => {
    const staged = await vaultStageAction(vault, {
      action_type: "write",
      target_path: "pricing/malformed.md",
      proposed_by: AGENT,
      rationale: "Missing body.",
      proposed_diff: { frontmatter: draftFrontmatter() },
    });
    // Stage-time validation catches the malformed payload up front.
    expect(staged.ok).toBe(false);
    if (staged.ok) return;
    expect(staged.error.message).toContain("proposed_diff.body");
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
