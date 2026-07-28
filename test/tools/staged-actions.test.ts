import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { BATCH_RATIFY_MAX } from "../../src/curation/risk.js";
import { getStagedActionById, stageAction } from "../../src/curation/staged-actions.js";
import { listTensions } from "../../src/curation/tension.js";
import { vaultRead } from "../../src/tools/read.js";
import {
  stagedActionTools,
  vaultRatify,
  vaultStageAction,
} from "../../src/tools/staged-actions.js";
import { vaultWrite } from "../../src/tools/write.js";
import { expectMatchesOutputSchema } from "../helpers/output-schema.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:curation-loop";
const HUMAN = "human:mihir";

const stageActionTool = stagedActionTools.find((t) => t.name === "vault_stage_action");
if (!stageActionTool) throw new Error("vault_stage_action not registered");
const ratifyTool = stagedActionTools.find((t) => t.name === "vault_ratify");
if (!ratifyTool) throw new Error("vault_ratify not registered");

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
    expectMatchesOutputSchema(stageActionTool, result.value);
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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

  it("records the authenticated caller as staged_by_principal (C4)", async () => {
    await seedDraft(vault, "pricing/foo.md");
    const access = {
      user: "human:mihir",
      roleName: "curator",
      role: { read: ["*"], write: ["*"], promote: true, ratify: true },
    };
    const result = await vaultStageAction(
      vault,
      {
        action_type: "promote",
        target_path: "pricing/foo.md",
        proposed_by: AGENT,
        rationale: "Matured.",
        proposed_diff: {},
      },
      access,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const staged = await getStagedActionById(vault, result.value.id);
    expect(staged.ok).toBe(true);
    if (!staged.ok || !staged.value) return;
    expect(staged.value.stagedByPrincipal).toBe("human:mihir");
    // proposed_by remains the claimed-agent display string, untouched.
    expect(staged.value.proposedBy).toBe(AGENT);
  });

  it("omits staged_by_principal when there is no access context (operator use)", async () => {
    await seedDraft(vault, "pricing/foo.md");
    const result = await vaultStageAction(vault, {
      action_type: "promote",
      target_path: "pricing/foo.md",
      proposed_by: AGENT,
      rationale: "Matured.",
      proposed_diff: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const staged = await getStagedActionById(vault, result.value.id);
    expect(staged.ok && staged.value?.stagedByPrincipal).toBeNull();
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
    expectMatchesOutputSchema(ratifyTool, ratified.value);

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
      reason_category: "stale-evidence",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(false);
    expect((result.value as { decision_kind?: string }).decision_kind).toBe("reject");

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("rejected");
    expect(action.ok && action.value?.reasonCategory).toBe("stale-evidence");
  });

  it("errors on reject without a reason_category, enumerating the categories (C6)", async () => {
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
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("reason_category");
    expect(result.error.message).toContain("wrong-conclusion");
    expect(result.error.message).toContain("other");

    // The action is untouched — still pending.
    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("pending");
  });

  it("rejects an unknown reason_category", async () => {
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
      reason_category: "not-a-real-category",
    });
    expect(result.ok).toBe(false);
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
      {
        id: staged.value.id,
        decision: "reject",
        principal: "human:mihir",
        reason_category: "wrong-conclusion",
      },
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

  it("tier-0 gate judges the MERGED post-state: omitted sources are inherited from disk", async () => {
    // The proposal promotes to canonical but does not re-declare sources.
    // vault_write's update path merges the payload UNDER the existing
    // frontmatter, so the old draft-citing sources array survives the write —
    // the gate must see it (review finding on #249).
    await seedDraft(vault, "pricing/wip-source.md");
    await seedDraft(vault, "pricing/promotable.md", { sources: ["pricing/wip-source.md"] });

    const staged = await vaultStageAction(vault, {
      action_type: "write",
      target_path: "pricing/promotable.md",
      proposed_by: AGENT,
      rationale: "Promote via full write, sources omitted.",
      proposed_diff: {
        // No `sources` key: inherited from the on-disk doc on merge.
        frontmatter: { status: "canonical" },
        body: "# Federation Spec\n\nRevised body.\n",
      },
    });
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
  }, 60_000);

  it("tier-0 gate judges the MERGED post-state: omitted status keeps the doc canonical", async () => {
    // The target is already canonical; the proposal adds a draft source
    // without declaring status. The merged doc is still canonical, so the
    // gate must run even though the payload never says "canonical".
    await seedDraft(vault, "pricing/wip-source.md");
    await seedDraft(vault, "pricing/settled.md", { status: "canonical" });

    const staged = await vaultStageAction(vault, {
      action_type: "write",
      target_path: "pricing/settled.md",
      proposed_by: AGENT,
      rationale: "Cite the WIP doc, status untouched.",
      proposed_diff: {
        frontmatter: { sources: ["pricing/wip-source.md"] },
        body: "# Federation Spec\n\nNow citing WIP.\n",
      },
    });
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

  it("tier-0 gate validates the merged post-state against config schema extensions", async () => {
    // Config declares a required extension AFTER seeding (seeding first —
    // otherwise the seed write itself would be blocked by the missing field).
    // A canonical write proposal omitting the required extension must be
    // caught by the gate with the tier-0 message, not fail later with the
    // generic invalid-frontmatter dispatch error (review finding on #249).
    await seedDraft(vault, "pricing/ext.md");
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(
      join(vault, ".daftari", "config.yaml"),
      "schema_extensions:\n  adr_id:\n    type: string\n    required: true\n",
    );

    const staged = await vaultStageAction(vault, {
      action_type: "write",
      target_path: "pricing/ext.md",
      proposed_by: AGENT,
      rationale: "Promote via write, required extension missing.",
      proposed_diff: {
        frontmatter: { status: "canonical" },
        body: "# Federation Spec\n\nRevised.\n",
      },
    });
    if (!staged.ok) throw staged.error;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("tier-0 gate blocked canonical write");
    expect(result.error.message).toContain("adr_id");

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("pending");
  }, 60_000);

  it("tier-0 gate blocks a write that demotes a canonical doc with canonical dependents", async () => {
    // The mirror of the promote-in-one-step case: a write proposal flipping
    // status off canonical is a deprecate in one step, and without a
    // superseded_by forward it strands dependents exactly like an unforwarded
    // staged deprecate (review finding on #249).
    await seedDraft(vault, "pricing/lib.md", { status: "canonical" });
    await seedDraft(vault, "pricing/user.md", {
      status: "canonical",
      sources: ["pricing/lib.md"],
    });

    const staged = await vaultStageAction(vault, {
      action_type: "write",
      target_path: "pricing/lib.md",
      proposed_by: AGENT,
      rationale: "Retire it via full write.",
      proposed_diff: {
        frontmatter: { status: "deprecated" },
        body: "# Federation Spec\n\nRetired.\n",
      },
    });
    if (!staged.ok) throw staged.error;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("tier-0 gate blocked demoting write");
    expect(result.error.message).toContain("canonical → deprecated");
    expect(result.error.message).toContain("pricing/user.md");

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("pending");
  }, 60_000);

  it("tier-0 gate passes a demoting write that forwards dependents via superseded_by", async () => {
    await seedDraft(vault, "pricing/lib.md", { status: "canonical" });
    await seedDraft(vault, "pricing/lib2.md", { status: "canonical" });
    await seedDraft(vault, "pricing/user.md", {
      status: "canonical",
      sources: ["pricing/lib.md"],
    });

    const staged = await vaultStageAction(vault, {
      action_type: "write",
      target_path: "pricing/lib.md",
      proposed_by: AGENT,
      rationale: "Replaced via full write.",
      proposed_diff: {
        frontmatter: { status: "superseded", superseded_by: "pricing/lib2.md" },
        body: "# Federation Spec\n\nReplaced.\n",
      },
    });
    if (!staged.ok) throw staged.error;

    const result = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.applied).toBe(true);

    const read = await vaultRead(vault, "pricing/lib.md");
    expect(read.ok && read.value.frontmatter.status).toBe("superseded");
    expect(read.ok && read.value.frontmatter.superseded_by).toBe("pricing/lib2.md");
  }, 60_000);

  it("gates the fallback collection on the NORMALIZED path, not the raw string", async () => {
    // pricing/../competitive-intel/ghost.md splits to "pricing" raw but
    // resolves to competitive-intel — a pricing-only role must not be able
    // to queue write proposals into a collection it cannot write (review
    // finding on #249).
    const pricingOnly = {
      user: "agent:writer",
      roleName: "pricing-writer",
      role: { read: ["*"], write: ["pricing"], promote: false, ratify: false },
    };
    const result = await vaultStageAction(
      vault,
      {
        action_type: "write",
        target_path: "pricing/../competitive-intel/ghost.md",
        proposed_by: AGENT,
        rationale: "Traversal attempt.",
        proposed_diff: { frontmatter: draftFrontmatter(), body: "# Ghost\n" },
      },
      pricingOnly,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("access denied");
    expect(result.error.message).toContain("competitive-intel");
  });

  it("stages the canonical relPath so aliased spellings contend in conflict detection", async () => {
    await seedDraft(vault, "pricing/aliased.md");
    const first = await vaultStageAction(vault, {
      action_type: "write",
      target_path: "pricing/aliased.md",
      proposed_by: AGENT,
      rationale: "First proposal.",
      proposed_diff: { frontmatter: draftFrontmatter(), body: "# A\n" },
    });
    if (!first.ok) throw first.error;

    // Same target through a dotted spelling — must conflict with the first.
    const second = await vaultStageAction(vault, {
      action_type: "write",
      target_path: "pricing/../pricing/aliased.md",
      proposed_by: AGENT,
      rationale: "Second proposal, aliased path.",
      proposed_diff: { frontmatter: draftFrontmatter(), body: "# B\n" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.conflicts_with).toEqual([first.value.id]);

    const action = await getStagedActionById(vault, second.value.id);
    expect(action.ok && action.value?.targetPath).toBe("pricing/aliased.md");
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
    await vaultRatify(vault, {
      id: staged.value.id,
      decision: "reject",
      principal: HUMAN,
      reason_category: "wrong-conclusion",
    });
    const again = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: HUMAN,
    });
    expect(again.ok).toBe(false);
  });

  // 2026-07-26 risk-triaged-ratification spec, Decision 3: edit-then-approve.
  describe("edit-then-approve (amended_diff)", () => {
    it("dispatches the amendment instead of the staged diff; the decision record keeps both", async () => {
      const staged = await vaultStageAction(vault, {
        action_type: "write",
        target_path: "pricing/edited-analysis.md",
        proposed_by: AGENT,
        rationale: "Initial draft synthesis.",
        proposed_diff: {
          frontmatter: draftFrontmatter({ title: "Original" }),
          body: "# Original\n\nOriginal content.\n",
        },
      });
      expect(staged.ok).toBe(true);
      if (!staged.ok) throw staged.error;

      const amendedDiff = {
        frontmatter: draftFrontmatter({ title: "Amended" }),
        body: "# Amended\n\nCorrected content.\n",
      };
      const ratified = await vaultRatify(vault, {
        id: staged.value.id,
        decision: "approve",
        principal: HUMAN,
        reason_category: "wrong-conclusion",
        amended_diff: amendedDiff,
      });
      expect(ratified.ok).toBe(true);
      if (!ratified.ok) throw ratified.error;
      expect((ratified.value as { decision_kind?: string }).decision_kind).toBe(
        "edit-then-approve",
      );
      expectMatchesOutputSchema(ratifyTool, ratified.value);

      const read = await vaultRead(vault, "pricing/edited-analysis.md");
      expect(read.ok && read.value.content).toContain("Corrected content.");
      expect(read.ok && read.value.content).not.toContain("Original content.");

      const action = await getStagedActionById(vault, staged.value.id);
      expect(action.ok && action.value?.status).toBe("ratified");
      expect(action.ok && action.value?.decisionKind).toBe("edit-then-approve");
      expect(action.ok && action.value?.amendedDiff).toEqual(amendedDiff);
      // proposedDiff still records the ORIGINAL proposal — history preserved.
      const proposed = action.ok
        ? (action.value?.proposedDiff as { frontmatter?: { title?: string } })
        : undefined;
      expect(proposed?.frontmatter?.title).toBe("Original");
    }, 60_000);

    it("amended_diff requires reason_category (C6)", async () => {
      const staged = await vaultStageAction(vault, {
        action_type: "write",
        target_path: "pricing/edited-2.md",
        proposed_by: AGENT,
        rationale: "Initial.",
        proposed_diff: { frontmatter: draftFrontmatter(), body: "# X\n" },
      });
      if (!staged.ok) throw staged.error;
      const result = await vaultRatify(vault, {
        id: staged.value.id,
        decision: "approve",
        principal: HUMAN,
        amended_diff: { frontmatter: draftFrontmatter(), body: "# Y\n" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("reason_category");
    });

    it("an amended write payload still hits the tier-0 canonical-write gate", async () => {
      await seedDraft(vault, "pricing/wip-source.md");
      const staged = await vaultStageAction(vault, {
        action_type: "write",
        target_path: "pricing/amend-target.md",
        proposed_by: AGENT,
        rationale: "Innocuous draft proposal.",
        proposed_diff: { frontmatter: draftFrontmatter({ title: "Draft" }), body: "# Draft\n" },
      });
      if (!staged.ok) throw staged.error;

      const result = await vaultRatify(vault, {
        id: staged.value.id,
        decision: "approve",
        principal: HUMAN,
        reason_category: "overbroad",
        amended_diff: {
          frontmatter: draftFrontmatter({
            title: "Bold Claim",
            status: "canonical",
            sources: ["pricing/wip-source.md"],
          }),
          body: "# Bold Claim\n",
        },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("tier-0 gate blocked canonical write");

      const action = await getStagedActionById(vault, staged.value.id);
      expect(action.ok && action.value?.status).toBe("pending");
    }, 60_000);

    it("errors under shadow_mode instead of discarding the amendment (C7)", async () => {
      await seedDraft(vault, "pricing/shadow-target.md");
      const staged = await stageAction(vault, {
        actionType: "confidence-up",
        targetPath: "pricing/shadow-target.md",
        proposedBy: AGENT,
        rationale: "Survived re-derivation.",
        proposedDiff: { confidence: "high" },
      });
      if (!staged.ok) throw staged.error;

      mkdirSync(join(vault, ".daftari"), { recursive: true });
      writeFileSync(join(vault, ".daftari", "config.yaml"), "version: 1\nshadow_mode: true\n");

      const result = await vaultRatify(vault, {
        id: staged.value.id,
        decision: "approve",
        principal: HUMAN,
        reason_category: "wrong-conclusion",
        amended_diff: { confidence: "medium" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("shadow mode");

      const action = await getStagedActionById(vault, staged.value.id);
      expect(action.ok && action.value?.status).toBe("pending");
      expect(action.ok && action.value?.decisionKind).toBeNull();
      expect(action.ok && action.value?.ratifiedAt).toBeNull();

      // The plain-approve shadow path is unaffected: no amended_diff, no error.
      const plain = await vaultRatify(vault, {
        id: staged.value.id,
        decision: "approve",
        principal: HUMAN,
      });
      expect(plain.ok).toBe(true);
      if (!plain.ok) return;
      expect((plain.value as { shadow?: boolean }).shadow).toBe(true);
    });
  });

  // Decision 2: batch ratify — an explicit id list, never a threshold.
  describe("batch ratify (ids)", () => {
    it("processes ids independently: a gate-blocked id stays pending, the rest land", async () => {
      await seedDraft(vault, "pricing/batch-a.md");
      await seedDraft(vault, "pricing/batch-b.md");
      await seedDraft(vault, "pricing/wip.md");
      await seedDraft(vault, "pricing/batch-c.md", { sources: ["pricing/wip.md"] });

      const a = await stageAction(vault, {
        actionType: "promote",
        targetPath: "pricing/batch-a.md",
        proposedBy: AGENT,
        rationale: "r",
        proposedDiff: {},
      });
      const b = await stageAction(vault, {
        actionType: "promote",
        targetPath: "pricing/batch-b.md",
        proposedBy: AGENT,
        rationale: "r",
        proposedDiff: {},
      });
      const c = await stageAction(vault, {
        actionType: "promote",
        targetPath: "pricing/batch-c.md",
        proposedBy: AGENT,
        rationale: "r",
        proposedDiff: {},
      });
      if (!a.ok || !b.ok || !c.ok) throw new Error("staging failed");

      const result = await vaultRatify(vault, {
        ids: [a.value.id, b.value.id, c.value.id],
        decision: "approve",
        principal: HUMAN,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expectMatchesOutputSchema(ratifyTool, result.value);
      const batch = result.value as {
        decision: string;
        results: Array<{ action_id: string; ok: boolean; applied: boolean; error?: string }>;
        succeeded: number;
        failed: number;
      };
      expect(batch.succeeded).toBe(2);
      expect(batch.failed).toBe(1);
      const cOutcome = batch.results.find((r) => r.action_id === c.value.id);
      expect(cOutcome?.ok).toBe(false);
      expect(cOutcome?.error).toContain("tier-0 gate blocked promote");

      const aAction = await getStagedActionById(vault, a.value.id);
      expect(aAction.ok && aAction.value?.status).toBe("ratified");
      const cAction = await getStagedActionById(vault, c.value.id);
      expect(cAction.ok && cAction.value?.status).toBe("pending");
    }, 60_000);

    it("batch reject: one shared reason_category applies to every id", async () => {
      await seedDraft(vault, "pricing/rej-a.md");
      await seedDraft(vault, "pricing/rej-b.md");
      const a = await stageAction(vault, {
        actionType: "promote",
        targetPath: "pricing/rej-a.md",
        proposedBy: AGENT,
        rationale: "r",
        proposedDiff: {},
      });
      const b = await stageAction(vault, {
        actionType: "promote",
        targetPath: "pricing/rej-b.md",
        proposedBy: AGENT,
        rationale: "r",
        proposedDiff: {},
      });
      if (!a.ok || !b.ok) throw new Error("staging failed");

      const result = await vaultRatify(vault, {
        ids: [a.value.id, b.value.id],
        decision: "reject",
        principal: HUMAN,
        reason_category: "duplicate",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const batch = result.value as { succeeded: number; failed: number };
      expect(batch.succeeded).toBe(2);
      expect(batch.failed).toBe(0);

      const aAction = await getStagedActionById(vault, a.value.id);
      expect(aAction.ok && aAction.value?.reasonCategory).toBe("duplicate");
      const bAction = await getStagedActionById(vault, b.value.id);
      expect(bAction.ok && bAction.value?.reasonCategory).toBe("duplicate");
    });

    it("interrupted-batch recovery: re-issuing pins landed ids as not-pending and applies the rest", async () => {
      await seedDraft(vault, "pricing/rec-a.md");
      await seedDraft(vault, "pricing/rec-b.md");
      await seedDraft(vault, "pricing/rec-c.md");
      const a = await stageAction(vault, {
        actionType: "promote",
        targetPath: "pricing/rec-a.md",
        proposedBy: AGENT,
        rationale: "r",
        proposedDiff: {},
      });
      const b = await stageAction(vault, {
        actionType: "promote",
        targetPath: "pricing/rec-b.md",
        proposedBy: AGENT,
        rationale: "r",
        proposedDiff: {},
      });
      const c = await stageAction(vault, {
        actionType: "promote",
        targetPath: "pricing/rec-c.md",
        proposedBy: AGENT,
        rationale: "r",
        proposedDiff: {},
      });
      if (!a.ok || !b.ok || !c.ok) throw new Error("staging failed");

      // Simulate "already landed before the interruption": decide `a` out of
      // band, as if an earlier call to this same batch had already processed it.
      const preDecided = await vaultRatify(vault, {
        id: a.value.id,
        decision: "approve",
        principal: HUMAN,
      });
      expect(preDecided.ok).toBe(true);

      // Re-issue the FULL original batch — the documented recovery path.
      const result = await vaultRatify(vault, {
        ids: [a.value.id, b.value.id, c.value.id],
        decision: "approve",
        principal: HUMAN,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const batch = result.value as {
        results: Array<{ action_id: string; ok: boolean; error?: string }>;
        succeeded: number;
        failed: number;
      };
      expect(batch.failed).toBe(1);
      expect(batch.succeeded).toBe(2);
      const aOutcome = batch.results.find((r) => r.action_id === a.value.id);
      expect(aOutcome?.ok).toBe(false);
      expect(aOutcome?.error).toContain("not 'pending'");
    }, 60_000);

    it("caps the batch at BATCH_RATIFY_MAX ids", async () => {
      const ids = Array.from({ length: BATCH_RATIFY_MAX + 1 }, (_, i) => `stage-${i}`);
      const result = await vaultRatify(vault, { ids, decision: "approve", principal: HUMAN });
      expect(result.ok).toBe(false);
    });

    it("rejects an empty ids array", async () => {
      const result = await vaultRatify(vault, { ids: [], decision: "approve", principal: HUMAN });
      expect(result.ok).toBe(false);
    });

    it("rejects a duplicate id within ids", async () => {
      const result = await vaultRatify(vault, {
        ids: ["stage-001", "stage-001"],
        decision: "approve",
        principal: HUMAN,
      });
      expect(result.ok).toBe(false);
    });

    it("errors when both id and ids are supplied", async () => {
      const result = await vaultRatify(vault, {
        id: "stage-001",
        ids: ["stage-002"],
        decision: "approve",
        principal: HUMAN,
      });
      expect(result.ok).toBe(false);
    });

    it("errors when neither id nor ids is supplied", async () => {
      const result = await vaultRatify(vault, { decision: "approve", principal: HUMAN });
      expect(result.ok).toBe(false);
    });

    it("errors when amended_diff is combined with ids — single-id only", async () => {
      const result = await vaultRatify(vault, {
        ids: ["stage-001", "stage-002"],
        decision: "approve",
        principal: HUMAN,
        reason_category: "overbroad",
        amended_diff: { confidence: "high" },
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("single-id only");
    });

    it("denies a batch under a propose-only role", async () => {
      const proposeOnly = {
        user: "agent:proposer",
        roleName: "proposer",
        role: { read: ["*"], write: ["*"], promote: false, ratify: true, proposeOnly: true },
      };
      const result = await vaultRatify(
        vault,
        { ids: ["stage-001", "stage-002"], decision: "approve", principal: HUMAN },
        proposeOnly,
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("propose-only");
    });
  });
});
