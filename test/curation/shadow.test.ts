import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProvenanceLog } from "../../src/curation/provenance.js";
import {
  computeShadowMetrics,
  listShadowActions,
  recordEnvelopeDecision,
  recordShadowAction,
  resetShadowSession,
  SHADOW_B0_BASE,
  SHADOW_I_BASE,
  shadowBudget,
  shadowImpact,
  shadowLintSummary,
  shadowSpent,
} from "../../src/curation/shadow.js";
import { stageAction } from "../../src/curation/staged-actions.js";
import { loadDocuments } from "../../src/curation/vault-docs.js";
import { vaultLint } from "../../src/tools/curation.js";
import { vaultRatify } from "../../src/tools/staged-actions.js";
import { vaultMerge, vaultPromote, vaultWrite } from "../../src/tools/write.js";
import { configPath } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:curation-loop";

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

// Flips the vault into shadow mode. Written AFTER any live seeding a test
// needs, since the config applies to every write that follows.
function enableShadowMode(vault: string): void {
  mkdirSync(dirname(configPath(vault)), { recursive: true });
  writeFileSync(configPath(vault), "version: 1\nshadow_mode: true\n");
}

async function seedLive(vault: string, path: string, overrides: Record<string, unknown> = {}) {
  const written = await vaultWrite(vault, {
    path,
    body: `# A Note\n\nBody of ${path}.\n`,
    frontmatter: frontmatter(overrides),
    agent: "agent:seed",
  });
  if (!written.ok) throw written.error;
}

describe("shadow math", () => {
  it("impact is i_base at blast 1, grows convexly, caps at 1", () => {
    expect(shadowImpact("create", 1)).toBeCloseTo(SHADOW_I_BASE.create as number, 5);
    const atTwo = shadowImpact("promote", 2);
    const atThree = shadowImpact("promote", 3);
    const atFive = shadowImpact("promote", 5);
    // Convex: each step up in blast costs more than the last.
    expect(atThree - atTwo).toBeLessThan(atFive - atThree);
    expect(shadowImpact("merge", 1000)).toBe(1);
  });

  it("budget is proportional to queue depth with a log(N) ceiling", () => {
    // Empty queue: the base floor.
    expect(shadowBudget(0, 100)).toBeCloseTo(SHADOW_B0_BASE, 5);
    // Deep queue: capped at ln(N).
    expect(shadowBudget(100, 100)).toBeCloseTo(Math.log(100), 5);
    // Tiny vault: ceiling never below 1.
    expect(shadowBudget(100, 2)).toBeCloseTo(1, 5);
  });
});

describe("shadow-mode write path", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
    resetShadowSession(vault);
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("vault_write computes but does not write: no file, no commit, no provenance", async () => {
    enableShadowMode(vault);
    const result = await vaultWrite(vault, {
      path: "pricing/shadowed.md",
      body: "# Shadowed\n\nNever lands.\n",
      frontmatter: frontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shadow).toBe(true);
    expect(result.value.commit).toBeNull();
    expect(result.value.committed).toBe(false);
    expect(result.value.indexUpdated).toBe(false);

    // Nothing on disk, nothing in the provenance log.
    expect(existsSync(join(vault, "pricing", "shadowed.md"))).toBe(false);
    const prov = await readProvenanceLog(vault);
    expect(prov.ok && prov.value.filter((e) => e.file === "pricing/shadowed.md")).toHaveLength(0);

    // One shadow record with the diff and a budget verdict.
    const log = await listShadowActions(vault);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value).toHaveLength(1);
    const rec = log.value[0];
    expect(rec?.tool).toBe("vault_write");
    expect(rec?.action).toBe("create");
    expect(rec?.target_path).toBe("pricing/shadowed.md");
    expect(rec?.impact).toBeGreaterThan(0);
    expect(rec?.budget).toBeGreaterThan(0);
    expect(typeof rec?.would_gate).toBe("boolean");
    expect(rec?.frontmatter_diff?.title?.after).toBe("A Note");
  }, 60_000);

  it("session spend accumulates until writes would gate", async () => {
    enableShadowMode(vault);
    // Empty queue → B₀ = 0.5; each create on a fresh path costs i_base = 0.1
    // (blast 1). Writes 1–4 fit (spent_before + 0.1 ≤ 0.5); write 5 leaves
    // spent at 0.5; write 6 would exceed → gated.
    for (let i = 1; i <= 6; i++) {
      const r = await vaultWrite(vault, {
        path: `pricing/shadow-${i}.md`,
        body: "# S\n\nBody.\n",
        frontmatter: frontmatter({ title: `S${i}` }),
        agent: AGENT,
      });
      if (!r.ok) throw r.error;
    }
    const log = await listShadowActions(vault);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value).toHaveLength(6);
    expect(log.value.slice(0, 5).every((r) => !r.would_gate)).toBe(true);
    expect(log.value[5]?.would_gate).toBe(true);
    expect(log.value[5]?.spent_before).toBeCloseTo(0.5, 5);
  }, 60_000);

  it("vault_merge shadows as one record with all touched paths, files untouched", async () => {
    await seedLive(vault, "pricing/a.md", { status: "canonical" });
    await seedLive(vault, "pricing/b.md", { status: "canonical" });
    enableShadowMode(vault);

    const result = await vaultMerge(vault, {
      path_a: "pricing/a.md",
      path_b: "pricing/b.md",
      target_path: "pricing/merged.md",
      body: "# Merged\n\nNever lands.\n",
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shadow).toBe(true);

    expect(existsSync(join(vault, "pricing", "merged.md"))).toBe(false);
    const log = await listShadowActions(vault);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value).toHaveLength(1);
    expect(log.value[0]?.action).toBe("merge");
    expect(log.value[0]?.touched_paths).toHaveLength(3);
    // Merge is the heaviest action in the starting I-table.
    expect(log.value[0]?.i_base).toBe(SHADOW_I_BASE.merge);
  }, 60_000);

  it("vault_ratify over a shadowed dispatch leaves the action pending", async () => {
    await seedLive(vault, "pricing/draft.md");
    const staged = await stageAction(vault, {
      actionType: "promote",
      targetPath: "pricing/draft.md",
      proposedBy: AGENT,
      rationale: "Matured.",
      proposedDiff: { status: { from: "draft", to: "canonical" } },
    });
    if (!staged.ok) throw staged.error;
    enableShadowMode(vault);

    const ratified = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: "human:mihir",
    });
    expect(ratified.ok).toBe(true);
    if (!ratified.ok) return;
    expect(ratified.value.applied).toBe(false);
    expect(ratified.value.shadow).toBe(true);

    // The doc is untouched and the action can still be ratified live later.
    const again = await vaultRatify(vault, {
      id: staged.value.id,
      decision: "approve",
      principal: "human:mihir",
    });
    expect(again.ok).toBe(true); // still pending → ratifiable (shadows again)
  }, 60_000);

  it("lint surfaces the would-have-gated summary", async () => {
    enableShadowMode(vault);
    for (let i = 1; i <= 6; i++) {
      await vaultWrite(vault, {
        path: `pricing/shadow-${i}.md`,
        body: "# S\n\nBody.\n",
        frontmatter: frontmatter({ title: `S${i}` }),
        agent: AGENT,
      });
    }
    const summary = await shadowLintSummary(vault);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    expect(summary.value.total).toBe(6);
    expect(summary.value.gated).toBe(1);
    expect(summary.value.recentGated[0]?.targetPath).toBe("pricing/shadow-6.md");

    const lint = await vaultLint(vault);
    expect(lint.ok).toBe(true);
    if (!lint.ok) return;
    expect(lint.value.shadowActions.gated).toBe(1);
  }, 60_000);

  it("a rejected write leaves NO shadow record (calibration purity)", async () => {
    await seedLive(vault, "pricing/canon.md", { status: "canonical" });
    enableShadowMode(vault);
    // Promote of a non-draft fails validation exactly as live...
    const result = await vaultPromote(vault, { path: "pricing/canon.md", agent: AGENT });
    expect(result.ok).toBe(false);
    // ...and the shadow log records only writes that WOULD have executed.
    const log = await listShadowActions(vault);
    expect(log.ok && log.value).toHaveLength(0);
  }, 60_000);

  it("blast counts downstream dependents and raises impact (alias-canonical seeds)", async () => {
    await seedLive(vault, "pricing/a.md", { status: "canonical" });
    // b.md cites a.md as a source → a change to a.md has downstream reach.
    await seedLive(vault, "pricing/b.md", {
      status: "canonical",
      sources: ["pricing/a.md"],
    });
    enableShadowMode(vault);

    // Write to a.md through an ALIASED path — the seed must still hit the
    // reverse maps (the path-canonicalization class, third sighting).
    const result = await vaultWrite(vault, {
      path: "pricing/../pricing/a.md",
      body: "# A\n\nRevised.\n",
      frontmatter: frontmatter({ status: "canonical" }),
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    const log = await listShadowActions(vault);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    const rec = log.value[0];
    expect(rec?.blast).toBe(2); // a.md + its dependent b.md
    expect(rec?.impact).toBeGreaterThan(rec?.i_base ?? 1);
  }, 60_000);

  it("budget grows with live pending staged actions (queue-depth integration)", async () => {
    await seedLive(vault, "pricing/target.md");
    for (let i = 0; i < 2; i++) {
      const staged = await stageAction(vault, {
        actionType: "promote",
        targetPath: "pricing/target.md",
        proposedBy: AGENT,
        rationale: "queue depth fixture",
        proposedDiff: {},
      });
      if (!staged.ok) throw staged.error;
    }
    enableShadowMode(vault);

    const result = await vaultWrite(vault, {
      path: "pricing/fresh.md",
      body: "# F\n\nBody.\n",
      frontmatter: frontmatter({ title: "F" }),
      agent: AGENT,
    });
    expect(result.ok).toBe(true);

    const docs = await loadDocuments(vault);
    expect(docs.ok).toBe(true);
    if (!docs.ok) return;
    const log = await listShadowActions(vault);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.value[0]?.budget).toBeCloseTo(shadowBudget(2, docs.value.length), 5);
    expect(log.value[0]?.budget).toBeGreaterThan(shadowBudget(0, docs.value.length));
  }, 60_000);

  it("shadow off (default): writes land and carry no shadow flag", async () => {
    const result = await vaultWrite(vault, {
      path: "pricing/live.md",
      body: "# Live\n\nLands.\n",
      frontmatter: frontmatter(),
      agent: AGENT,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.shadow).toBeUndefined();
    expect(existsSync(join(vault, "pricing", "live.md"))).toBe(true);
  }, 60_000);
});

describe("recordEnvelopeDecision", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
    resetShadowSession(vault);
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("journals an admitted loop decision (no gate fields, would_gate false)", async () => {
    const rec = await recordEnvelopeDecision(vault, {
      tool: "vault_edge_observe",
      action: "edge-observe",
      targetPath: "pricing/a.md",
      touchedPaths: ["pricing/a.md", "pricing/b.md"],
      agent: AGENT,
      decision: "admitted",
      impact: 0.05,
      budget: 0.5,
      blast: 1,
      spentBefore: 0.1,
      commitMessage: "edge: a -> b",
    });
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    expect(rec.value.decision).toBe("admitted");
    expect(rec.value.would_gate).toBe(false);
    expect(rec.value.gate).toBeUndefined();
    expect(rec.value.gate_reason).toBeUndefined();
    expect(rec.value.i_base).toBe(SHADOW_I_BASE["edge-observe"]);
    expect(rec.value.spent_before).toBe(0.1);
    expect(rec.value.touched_paths).toEqual(["pricing/a.md", "pricing/b.md"]);

    const log = await listShadowActions(vault);
    expect(log.ok && log.value).toHaveLength(1);
    if (log.ok) expect(log.value[0]?.decision).toBe("admitted");
  }, 60_000);

  it("journals a gated loop decision with gate + reason, and NEVER advances spentByVault", async () => {
    resetShadowSession(vault);
    expect(shadowSpent(vault)).toBe(0);

    const rec = await recordEnvelopeDecision(vault, {
      tool: "vault_edge_contest",
      action: "edge-contest",
      targetPath: "pricing/a.md",
      touchedPaths: ["pricing/a.md", "pricing/b.md"],
      agent: AGENT,
      decision: "gated",
      gate: "budget",
      gateReason: "trust-budget exhausted: spent 0.500 + I 0.100 > B0 0.500",
      impact: 0.1,
      budget: 0.5,
      blast: 1,
      spentBefore: 0.5,
      commitMessage: "edge-contest: a vs b",
    });
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    expect(rec.value.decision).toBe("gated");
    expect(rec.value.gate).toBe("budget");
    expect(rec.value.gate_reason).toContain("trust-budget");
    expect(rec.value.would_gate).toBe(true);

    // The envelope owns its own spend; the module global must stay untouched.
    expect(shadowSpent(vault)).toBe(0);
  }, 60_000);
});

describe("computeShadowMetrics", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
    resetShadowSession(vault);
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("matches the impact/budget recordShadowAction records for the same fixture", async () => {
    await seedLive(vault, "pricing/a.md", { status: "canonical" });
    await seedLive(vault, "pricing/b.md", { status: "canonical", sources: ["pricing/a.md"] });

    // Record one shadow action directly (refactor must keep it unchanged).
    resetShadowSession(vault);
    const rec = await recordShadowAction(vault, {
      tool: "vault_write",
      action: "update",
      targetPath: "pricing/a.md",
      agent: AGENT,
      commitMessage: "update a",
    });
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;

    const metrics = await computeShadowMetrics(vault, "update", ["pricing/a.md"]);
    expect(metrics.ok).toBe(true);
    if (!metrics.ok) return;
    expect(metrics.value.impact).toBeCloseTo(rec.value.impact, 10);
    expect(metrics.value.budget).toBeCloseTo(rec.value.budget, 10);
    expect(metrics.value.blast).toBe(rec.value.blast);
  }, 60_000);
});

describe("shadowLintSummary gated view", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
    resetShadowSession(vault);
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("surfaces envelope-gated rows in gatedSurfaced/gatedCount, leaving would_gate-based gated intact", async () => {
    enableShadowMode(vault);
    // 6 doc writes → 1 would_gate row (the would_gate-based calibration view).
    for (let i = 1; i <= 6; i++) {
      await vaultWrite(vault, {
        path: `pricing/shadow-${i}.md`,
        body: "# S\n\nBody.\n",
        frontmatter: frontmatter({ title: `S${i}` }),
        agent: AGENT,
      });
    }
    // One ADMITTED envelope loop decision: decision === "admitted" so it does
    // NOT appear in the decision-based gated view, and its would_gate is false
    // so it does NOT appear in the would_gate-based view either. This isolates
    // the two surfaces cleanly.
    const admitted = await recordEnvelopeDecision(vault, {
      tool: "vault_edge_observe",
      action: "edge-observe",
      targetPath: "pricing/shadow-2.md",
      touchedPaths: ["pricing/shadow-2.md"],
      agent: AGENT,
      decision: "admitted",
      impact: 0.05,
      budget: 0.5,
      blast: 1,
      spentBefore: 0,
      commitMessage: "edge-observe admitted",
    });
    expect(admitted.ok).toBe(true);

    // One GATED envelope loop decision (decision === "gated").
    const envRec = await recordEnvelopeDecision(vault, {
      tool: "vault_edge_contest",
      action: "edge-contest",
      targetPath: "pricing/shadow-1.md",
      touchedPaths: ["pricing/shadow-1.md"],
      agent: AGENT,
      decision: "gated",
      gate: "invariants",
      gateReason: "tension-respect: pricing/shadow-1.md has an unresolved tension",
      impact: 0.1,
      budget: 0.5,
      blast: 1,
      spentBefore: 0,
      commitMessage: "edge-contest gated",
    });
    expect(envRec.ok).toBe(true);

    const summary = await shadowLintSummary(vault);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    // would_gate-based view: the 6th doc write (would_gate true) PLUS the gated
    // envelope row (would_gate mirrors decision === "gated"). The admitted
    // envelope row is excluded. The two views are computed from DIFFERENT
    // fields and are NOT merged: this view still keys off would_gate.
    expect(summary.value.gated).toBe(2);
    expect(summary.value.recentGated[0]?.targetPath).toBe("pricing/shadow-1.md");
    // decision-based view: ONLY the gated envelope row (the admitted envelope
    // row and all six doc writes — which set no `decision` — are excluded).
    expect(summary.value.gatedCount).toBe(1);
    expect(summary.value.gatedSurfaced).toHaveLength(1);
    expect(summary.value.gatedSurfaced[0]?.targetPath).toBe("pricing/shadow-1.md");
  }, 60_000);
});
