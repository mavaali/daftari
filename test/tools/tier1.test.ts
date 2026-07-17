import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeEdge } from "../../src/curation/edges.js";
import { recordProvenance } from "../../src/curation/provenance.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultTier1 } from "../../src/tools/tier1.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:compiler";

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Metric",
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

// Seeds the full three-class neighborhood around pricing/metric.md:
// a compiled dependent (run-correlated read→write), a declared dependent
// (sources citation), and an earned dependent (derives_from observation).
async function seedNeighborhood(vault: string): Promise<void> {
  const unit = await vaultWrite(vault, {
    path: "pricing/metric.md",
    body: "# Metric\n\nvalue: 40\n",
    frontmatter: frontmatter(),
    agent: AGENT,
  });
  if (!unit.ok) throw unit.error;

  await vaultRead(vault, "pricing/metric.md", undefined, "run-1");
  const artifact = await vaultWrite(vault, {
    path: "pricing/artifact.md",
    body: "# Artifact\n\nBuilt from the metric.\n",
    frontmatter: frontmatter({ title: "Artifact", provenance: "synthesized" }),
    agent: AGENT,
    run_id: "run-1",
  });
  if (!artifact.ok) throw artifact.error;

  const citer = await vaultWrite(vault, {
    path: "pricing/citer.md",
    body: "# Citer\n",
    frontmatter: frontmatter({ title: "Citer", sources: ["pricing/metric.md"] }),
    agent: AGENT,
  });
  if (!citer.ok) throw citer.error;

  const earned = await observeEdge(vault, {
    fromPath: "pricing/earned-dep.md",
    toPath: "pricing/metric.md",
    observedBy: "agent:curation-loop",
    blind: false,
    at: "2026-07-01T00:00:00Z",
  });
  if (!earned.ok) throw earned.error;
}

describe("vault_tier1 (#232)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("dispatches a real change across all three classes from provenance", async () => {
    await seedNeighborhood(vault);

    // Change the unit: tags only, same body.
    const updated = await vaultWrite(vault, {
      path: "pricing/metric.md",
      body: "# Metric\n\nvalue: 40\n",
      frontmatter: frontmatter({ tags: ["revised"] }),
      agent: AGENT,
    });
    if (!updated.ok) throw updated.error;

    const result = await vaultTier1(vault, { unit: "pricing/metric.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;

    expect(result.value.change_source).toBe("provenance");
    expect(result.value.changed_fields).toEqual(["tags"]);

    const byArtifact = new Map(result.value.verdicts.map((v) => [v.artifact, v]));
    // Compiled whole-doc edge: certain hit (the run consumed everything).
    expect(byArtifact.get("pricing/artifact.md")?.verdict).toBe("affected");
    expect(byArtifact.get("pricing/artifact.md")?.edge_class).toBe("compiled");
    // Declared citation: a claim.
    expect(byArtifact.get("pricing/citer.md")?.verdict).toBe("possibly-affected");
    // Earned edge: routed, never decided.
    expect(byArtifact.get("pricing/earned-dep.md")?.verdict).toBe("semantic-review");
    expect(result.value.summary.resolved_at_tier1).toBe(false);
  }, 60_000);

  it("a bookkeeping-only provenance entry resolves everything as unaffected", async () => {
    await seedNeighborhood(vault);

    // A write whose only frontmatter delta is the server stamp and whose body
    // is unchanged (a truly identical re-write cannot land — git refuses an
    // empty commit — so the log entry is seeded directly).
    const stamped = await recordProvenance(vault, {
      tool: "vault_write",
      file: "pricing/metric.md",
      agent: AGENT,
      action: "update",
      body_changed: false,
      frontmatter_diff: { updated: { before: "2026-07-16", after: "2026-07-17" } },
    });
    if (!stamped.ok) throw stamped.error;

    const result = await vaultTier1(vault, { unit: "pricing/metric.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.changed_fields).toEqual([]);
    expect(result.value.verdicts.every((v) => v.verdict === "unaffected")).toBe(true);
    expect(result.value.summary.resolved_at_tier1).toBe(true);
  }, 60_000);

  it("a body change from provenance carries 'body' into the dispatch", async () => {
    await seedNeighborhood(vault);
    const updated = await vaultWrite(vault, {
      path: "pricing/metric.md",
      body: "# Metric\n\nvalue: 60\n",
      frontmatter: frontmatter(),
      agent: AGENT,
    });
    if (!updated.ok) throw updated.error;

    const result = await vaultTier1(vault, { unit: "pricing/metric.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changed_fields).toEqual(["body"]);
  }, 60_000);

  it("explicit changed_fields asks about a hypothetical change", async () => {
    await seedNeighborhood(vault);
    const result = await vaultTier1(vault, {
      unit: "pricing/metric.md",
      changed_fields: ["updated", "updated_by"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.change_source).toBe("explicit");
    expect(result.value.changed_fields).toEqual([]);
    expect(result.value.verdicts.every((v) => v.verdict === "unaffected")).toBe(true);
  }, 60_000);

  it("errors, asking for changed_fields, when the unit has no provenance", async () => {
    // Fixture docs predate the provenance log.
    const result = await vaultTier1(vault, { unit: "pricing/helios-consumption-pricing.md" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("changed_fields");
  });

  it("omits verdicts the caller cannot see, summary included (#217)", async () => {
    await seedNeighborhood(vault);
    // A compiled dependent in another collection.
    await vaultRead(vault, "pricing/metric.md", undefined, "run-2");
    const cross = await vaultWrite(vault, {
      path: "competitive-intel/cross-artifact.md",
      body: "# Cross\n",
      frontmatter: frontmatter({ title: "Cross", collection: "competitive-intel" }),
      agent: AGENT,
      run_id: "run-2",
    });
    if (!cross.ok) throw cross.error;

    const pricingOnly = {
      user: "human:narrow",
      roleName: "pricing-only",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };
    const gated = await vaultTier1(
      vault,
      { unit: "pricing/metric.md", changed_fields: ["body"] },
      pricingOnly,
    );
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;
    const artifacts = gated.value.verdicts.map((v) => v.artifact);
    expect(artifacts).not.toContain("competitive-intel/cross-artifact.md");
    expect(artifacts).toContain("pricing/artifact.md");

    // An unreadable anchor yields an empty result — no existence signal.
    const intelOnly = {
      user: "human:narrow",
      roleName: "intel-only",
      role: { read: ["competitive-intel"], write: [], promote: false, ratify: false },
    };
    const blind = await vaultTier1(
      vault,
      { unit: "pricing/metric.md", changed_fields: ["body"] },
      intelOnly,
    );
    expect(blind.ok).toBe(true);
    if (!blind.ok) return;
    expect(blind.value.verdicts).toEqual([]);
    expect(blind.value.summary.resolved_at_tier1).toBe(true);
  }, 60_000);
});
