import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeEdge } from "../../src/curation/edges.js";
import { recordProvenance } from "../../src/curation/provenance.js";
import { readReadLog } from "../../src/curation/read-log.js";
import { vaultStaleness } from "../../src/tools/edge-staleness.js";
import { vaultRead } from "../../src/tools/read.js";
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

// Same neighborhood as the tier1 tool tests: pricing/metric.md with a
// compiled dependent (run-correlated), a declared dependent (sources), and
// an earned dependent (derives_from observation).
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

async function changeMetricBody(vault: string): Promise<void> {
  const updated = await vaultWrite(vault, {
    path: "pricing/metric.md",
    body: "# Metric\n\nvalue: 60\n",
    frontmatter: frontmatter(),
    agent: AGENT,
  });
  if (!updated.ok) throw updated.error;
}

describe("vault_staleness (#234)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("classifies a compiled dependent broken and a declared one unchecked", async () => {
    await seedNeighborhood(vault);
    await changeMetricBody(vault);

    const artifact = await vaultStaleness(vault, { artifact: "pricing/artifact.md" });
    expect(artifact.ok).toBe(true);
    if (!artifact.ok) throw artifact.error;
    if (artifact.value.mode !== "artifact") throw new Error("expected artifact mode");
    expect(artifact.value.edges).toHaveLength(1);
    expect(artifact.value.edges[0]?.unit).toBe("pricing/metric.md");
    expect(artifact.value.edges[0]?.edge_class).toBe("compiled");
    expect(artifact.value.edges[0]?.staleness).toBe("pending-broken");
    expect(artifact.value.summary.pending_broken).toBe(1);

    const citer = await vaultStaleness(vault, { artifact: "pricing/citer.md" });
    expect(citer.ok).toBe(true);
    if (!citer.ok) throw citer.error;
    if (citer.value.mode !== "artifact") throw new Error("expected artifact mode");
    expect(citer.value.edges[0]?.edge_class).toBe("declared");
    expect(citer.value.edges[0]?.staleness).toBe("pending-unchecked");
  }, 60_000);

  it("bookkeeping-only upstream churn is pending-compatible, no churn is current", async () => {
    await seedNeighborhood(vault);

    const before = await vaultStaleness(vault, { artifact: "pricing/artifact.md" });
    if (!before.ok) throw before.error;
    if (before.value.mode !== "artifact") throw new Error("expected artifact mode");
    expect(before.value.edges[0]?.staleness).toBe("current");

    const stamped = await recordProvenance(vault, {
      tool: "vault_write",
      file: "pricing/metric.md",
      agent: AGENT,
      action: "update",
      body_changed: false,
      frontmatter_diff: { updated: { before: "2026-07-16", after: "2026-07-17" } },
    });
    if (!stamped.ok) throw stamped.error;

    const after = await vaultStaleness(vault, { artifact: "pricing/artifact.md" });
    if (!after.ok) throw after.error;
    if (after.value.mode !== "artifact") throw new Error("expected artifact mode");
    expect(after.value.edges[0]?.staleness).toBe("pending-compatible");
    expect(after.value.summary.pending_broken).toBe(0);
  }, 60_000);

  it("vault_read serves carry the broken state: result surface and read log", async () => {
    await seedNeighborhood(vault);
    await changeMetricBody(vault);

    const read = await vaultRead(vault, "pricing/artifact.md");
    expect(read.ok).toBe(true);
    if (!read.ok) throw read.error;
    expect(read.value.upstream_staleness?.pending_broken).toBe(1);
    expect(read.value.upstream_staleness?.hidden_pending).toBe("none");
    expect(read.value.upstream_staleness?.banner).toContain("changed incompatibly");

    // A doc with no compiled upstream edges reports nothing.
    const unitRead = await vaultRead(vault, "pricing/metric.md");
    if (!unitRead.ok) throw unitRead.error;
    expect(unitRead.value.upstream_staleness).toBeNull();

    const log = await readReadLog(vault);
    if (!log.ok) throw log.error;
    const serve = log.value.filter(
      (e) => e.file === "pricing/artifact.md" && e.tool === "vault_read",
    );
    expect(serve[serve.length - 1]?.broken_upstream).toBe(1);
  }, 60_000);

  it("the vault-global report computes the broken-read rate over instrumented serves", async () => {
    await seedNeighborhood(vault);
    await changeMetricBody(vault);
    await vaultRead(vault, "pricing/artifact.md"); // broken serve
    await vaultRead(vault, "pricing/metric.md"); // clean serve

    const report = await vaultStaleness(vault, {});
    expect(report.ok).toBe(true);
    if (!report.ok) throw report.error;
    if (report.value.mode !== "report") throw new Error("expected report mode");
    expect(report.value.window_days).toBe(30);
    expect(report.value.serves).toBeGreaterThanOrEqual(2);
    expect(report.value.broken_serves).toBeGreaterThanOrEqual(1);
    expect(report.value.broken_read_rate).toBeGreaterThan(0);
    expect(report.value.by_tool.vault_read?.broken_serves).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("omits edges to unreadable units and coarsens them into hidden_pending", async () => {
    await seedNeighborhood(vault);
    // A pricing artifact compiled from a competitive-intel unit.
    const secret = await vaultWrite(vault, {
      path: "competitive-intel/secret-unit.md",
      body: "# Secret\n",
      frontmatter: frontmatter({ title: "Secret", collection: "competitive-intel" }),
      agent: AGENT,
    });
    if (!secret.ok) throw secret.error;
    await vaultRead(vault, "competitive-intel/secret-unit.md", undefined, "run-3");
    const consumer = await vaultWrite(vault, {
      path: "pricing/consumer2.md",
      body: "# Consumer\n",
      frontmatter: frontmatter({ title: "Consumer", provenance: "synthesized" }),
      agent: AGENT,
      run_id: "run-3",
    });
    if (!consumer.ok) throw consumer.error;
    const changed = await vaultWrite(vault, {
      path: "competitive-intel/secret-unit.md",
      body: "# Secret\n\nchanged\n",
      frontmatter: frontmatter({ title: "Secret", collection: "competitive-intel" }),
      agent: AGENT,
    });
    if (!changed.ok) throw changed.error;

    const pricingOnly = {
      user: "human:narrow",
      roleName: "pricing-only",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };
    const gated = await vaultStaleness(vault, { artifact: "pricing/consumer2.md" }, pricingOnly);
    expect(gated.ok).toBe(true);
    if (!gated.ok) throw gated.error;
    if (gated.value.mode !== "artifact") throw new Error("expected artifact mode");
    expect(gated.value.edges).toEqual([]);
    expect(gated.value.hidden_pending).toBe("some");
    expect(gated.value.summary.pending_broken).toBe(0);
  }, 60_000);

  it("an unreadable anchor reports exactly like a nonexistent one", async () => {
    await seedNeighborhood(vault);
    await changeMetricBody(vault);

    const intelOnly = {
      user: "human:narrow",
      roleName: "intel-only",
      role: { read: ["competitive-intel"], write: [], promote: false, ratify: false },
    };
    const hidden = await vaultStaleness(vault, { artifact: "pricing/artifact.md" }, intelOnly);
    const ghost = await vaultStaleness(vault, { artifact: "pricing/ghost.md" }, intelOnly);
    expect(hidden.ok && ghost.ok).toBe(true);
    if (!hidden.ok || !ghost.ok) return;
    if (hidden.value.mode !== "artifact" || ghost.value.mode !== "artifact") {
      throw new Error("expected artifact mode");
    }
    expect(hidden.value.edges).toEqual([]);
    expect(hidden.value.hidden_pending).toBe("none");
    expect({ ...hidden.value, artifact: "x" }).toEqual({ ...ghost.value, artifact: "x" });
  }, 60_000);

  it("rejects bad arguments", async () => {
    const badDays = await vaultStaleness(vault, { days: -1 });
    expect(badDays.ok).toBe(false);
    const both = await vaultStaleness(vault, { artifact: "pricing/metric.md", days: 7 });
    expect(both.ok).toBe(false);
    const emptyArtifact = await vaultStaleness(vault, { artifact: "  " });
    expect(emptyArtifact.ok).toBe(false);
  });
});
