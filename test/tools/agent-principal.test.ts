// §11.6 — the agent principal in RBAC: the `ratify` grant gating the
// curation-verdict tier (vault_ratify, vault_edge_contest) and authenticated
// principal attribution on provenance + shadow records.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import { listShadowActions, resetShadowSession } from "../../src/curation/shadow.js";
import { stageAction } from "../../src/curation/staged-actions.js";
import { vaultEdgeContest, vaultEdgeObserve } from "../../src/tools/edges.js";
import { vaultRatify } from "../../src/tools/staged-actions.js";
import { vaultMerge, vaultWrite } from "../../src/tools/write.js";
import { configPath, loadConfig } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// A full curator EXCEPT the ratify grant — the §11.6 posture for the loop
// itself: it proposes and writes, humans ratify.
const LOOP: AccessContext = {
  user: "agent:curation-loop",
  roleName: "curation-loop",
  role: { read: ["*"], write: ["*"], promote: true, ratify: false },
};

const HUMAN: AccessContext = {
  user: "human:mihir",
  roleName: "admin",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "A Note",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-05-01",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: ["note"],
    ...overrides,
  };
}

async function seed(vault: string, path: string, overrides: Record<string, unknown> = {}) {
  const written = await vaultWrite(vault, {
    path,
    body: `# A Note\n\nBody of ${path}.\n`,
    frontmatter: frontmatter(overrides),
    agent: "agent:seed",
  });
  if (!written.ok) throw written.error;
}

describe("ratify grant (§11.6)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("denies vault_ratify to a role without the grant — even a writing, promoting one", async () => {
    await seed(vault, "pricing/draft.md");
    const staged = await stageAction(vault, {
      actionType: "promote",
      targetPath: "pricing/draft.md",
      proposedBy: LOOP.user,
      rationale: "Matured.",
      proposedDiff: {},
    });
    if (!staged.ok) throw staged.error;

    const result = await vaultRatify(
      vault,
      { id: staged.value.id, decision: "approve", principal: LOOP.user },
      LOOP,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("cannot ratify");
  }, 60_000);

  it("allows vault_ratify with the grant, end to end", async () => {
    await seed(vault, "pricing/draft.md");
    const staged = await stageAction(vault, {
      actionType: "promote",
      targetPath: "pricing/draft.md",
      proposedBy: LOOP.user,
      rationale: "Matured.",
      proposedDiff: {},
    });
    if (!staged.ok) throw staged.error;

    const result = await vaultRatify(
      vault,
      { id: staged.value.id, decision: "approve", principal: HUMAN.user },
      HUMAN,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.applied).toBe(true);
  }, 60_000);

  it("denies vault_edge_contest without the grant; observe stays open", async () => {
    await seed(vault, "pricing/a.md");
    await seed(vault, "pricing/b.md");
    // Observing is the curation-surface tier — the loop may do it.
    const observed = await vaultEdgeObserve(
      vault,
      { from_path: "pricing/a.md", to_path: "pricing/b.md", observed_by: LOOP.user, blind: false },
      LOOP,
    );
    expect(observed.ok).toBe(true);

    // Contesting is a verdict — denied without the grant…
    const denied = await vaultEdgeContest(
      vault,
      {
        from_path: "pricing/a.md",
        to_path: "pricing/b.md",
        contested_by: LOOP.user,
        reason: "x",
      },
      LOOP,
    );
    expect(denied.ok).toBe(false);

    // …and allowed with it.
    const allowed = await vaultEdgeContest(
      vault,
      {
        from_path: "pricing/a.md",
        to_path: "pricing/b.md",
        contested_by: HUMAN.user,
        reason: "re-derivation failed",
      },
      HUMAN,
    );
    expect(allowed.ok).toBe(true);
  }, 60_000);

  it("denies vault_ratify to the guest shape the server actually passes (role null)", async () => {
    const guest: AccessContext = { user: "guest", roleName: "guest", role: null };
    const result = await vaultRatify(
      vault,
      { id: "stage-001", decision: "approve", principal: "guest" },
      guest,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("cannot ratify");
  });

  it("a ratify-dispatched write attributes both the claim and the authenticated principal", async () => {
    await seed(vault, "pricing/draft.md");
    const staged = await stageAction(vault, {
      actionType: "promote",
      targetPath: "pricing/draft.md",
      proposedBy: LOOP.user,
      rationale: "Matured.",
      proposedDiff: {},
    });
    if (!staged.ok) throw staged.error;

    const ratified = await vaultRatify(
      vault,
      { id: staged.value.id, decision: "approve", principal: HUMAN.user },
      HUMAN,
    );
    expect(ratified.ok).toBe(true);

    const prov = await readProvenanceLog(vault);
    expect(prov.ok).toBe(true);
    if (!prov.ok) return;
    const entry = prov.value.find((e) => e.file === "pricing/draft.md" && e.action === "promote");
    expect(entry?.agent).toBe(HUMAN.user); // the claim ratify passed as agent
    expect(entry?.principal).toBe(HUMAN.user); // the authenticated identity
  }, 60_000);

  it("rejects a malformed ratify value in config", () => {
    mkdirSync(dirname(configPath(vault)), { recursive: true });
    writeFileSync(configPath(vault), 'roles:\n  x:\n    read: ["*"]\n    ratify: "yes"\n');
    const result = loadConfig(vault);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("ratify");
  });
});

describe("authenticated principal attribution (§11.6)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
    resetShadowSession(vault);
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("records principal on provenance when an access context is present", async () => {
    const result = await vaultWrite(
      vault,
      {
        path: "pricing/attributed.md",
        body: "# A\n\nBody.\n",
        frontmatter: frontmatter(),
        agent: "agent:claude-code", // the caller's CLAIM
      },
      LOOP, // the AUTHENTICATED identity
    );
    expect(result.ok).toBe(true);

    const prov = await readProvenanceLog(vault);
    expect(prov.ok).toBe(true);
    if (!prov.ok) return;
    const entry = prov.value.find((e) => e.file === "pricing/attributed.md");
    expect(entry?.agent).toBe("agent:claude-code");
    expect(entry?.principal).toBe("agent:curation-loop");
  }, 60_000);

  it("omits principal when the server runs without an access context", async () => {
    await seed(vault, "pricing/plain.md");
    const prov = await readProvenanceLog(vault);
    expect(prov.ok).toBe(true);
    if (!prov.ok) return;
    const entry = prov.value.find((e) => e.file === "pricing/plain.md");
    expect(entry?.principal).toBeUndefined();
  }, 60_000);

  it("records principal on every file of a live merge (hand-rolled path)", async () => {
    await seed(vault, "pricing/a.md", { status: "canonical" });
    await seed(vault, "pricing/b.md", { status: "canonical" });
    const result = await vaultMerge(
      vault,
      {
        path_a: "pricing/a.md",
        path_b: "pricing/b.md",
        target_path: "pricing/merged.md",
        body: "# Merged\n\nCombined.\n",
        agent: "agent:claude-code",
      },
      LOOP,
    );
    expect(result.ok).toBe(true);

    const prov = await readProvenanceLog(vault);
    expect(prov.ok).toBe(true);
    if (!prov.ok) return;
    const mergeEntries = prov.value.filter((e) => e.tool === "vault_merge");
    expect(mergeEntries).toHaveLength(3);
    expect(mergeEntries.every((e) => e.principal === LOOP.user)).toBe(true);
  }, 60_000);

  it("records principal on shadow records too", async () => {
    mkdirSync(dirname(configPath(vault)), { recursive: true });
    writeFileSync(configPath(vault), "version: 1\nshadow_mode: true\n");
    const result = await vaultWrite(
      vault,
      {
        path: "pricing/shadowed.md",
        body: "# S\n\nBody.\n",
        frontmatter: frontmatter(),
        agent: "agent:claude-code",
      },
      LOOP,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shadow).toBe(true);

    const log = await listShadowActions(vault);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value[0]?.principal).toBe("agent:curation-loop");
  }, 60_000);
});
