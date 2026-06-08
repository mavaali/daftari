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

async function seedDraft(vault: string, path: string): Promise<void> {
  const written = await vaultWrite(vault, {
    path,
    body: "# Federation Spec\n\nBody.\n",
    frontmatter: draftFrontmatter(),
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

  it("approving a supersede is a graceful punt deferred to §11.4", async () => {
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
    expect(result.value.applied).toBe(false);
    expect(result.value.deferred_to).toBe("§11.4");

    const action = await getStagedActionById(vault, staged.value.id);
    expect(action.ok && action.value?.status).toBe("ratified-pending-tool");
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
