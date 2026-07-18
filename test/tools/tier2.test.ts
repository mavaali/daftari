import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeEdge } from "../../src/curation/edges.js";
import { DEFAULT_TENSION_STATUS, listTensions } from "../../src/curation/tension.js";
import { vaultStaleness } from "../../src/tools/edge-staleness.js";
import { vaultTier2Queue, vaultTier2Verdict } from "../../src/tools/tier2.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:compiler";
const JUDGE = "agent:semantic-judge";

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

// pricing/metric.md with a declared dependent (citer) and an earned
// dependent (earned-dep, a real document with a derives_from edge whose
// lastRederived predates every write — so it is pending from the start).
async function seed(vault: string): Promise<void> {
  const unit = await vaultWrite(vault, {
    path: "pricing/metric.md",
    body: "# Metric\n\nvalue: 40\n",
    frontmatter: frontmatter(),
    agent: AGENT,
  });
  if (!unit.ok) throw unit.error;

  const citer = await vaultWrite(vault, {
    path: "pricing/citer.md",
    body: "# Citer\n\nThe Metric value anchors this note.\n",
    frontmatter: frontmatter({ title: "Citer", sources: ["pricing/metric.md"] }),
    agent: AGENT,
  });
  if (!citer.ok) throw citer.error;

  const dep = await vaultWrite(vault, {
    path: "pricing/earned-dep.md",
    body: "# Earned\n\nDerived downstream of the metric.\n",
    frontmatter: frontmatter({ title: "Earned", provenance: "synthesized" }),
    agent: AGENT,
  });
  if (!dep.ok) throw dep.error;

  const earned = await observeEdge(vault, {
    fromPath: "pricing/earned-dep.md",
    toPath: "pricing/metric.md",
    observedBy: "agent:curation-loop",
    blind: false,
    at: "2026-07-01T00:00:00Z",
  });
  if (!earned.ok) throw earned.error;
}

async function changeMetric(vault: string, value: number): Promise<void> {
  const updated = await vaultWrite(vault, {
    path: "pricing/metric.md",
    body: `# Metric\n\nvalue: ${value}\n`,
    frontmatter: frontmatter(),
    agent: AGENT,
  });
  if (!updated.ok) throw updated.error;
}

describe("tier-2 queue and verdicts (#232)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("queues the residual with constrained inputs, and verdicts drain it", async () => {
    await seed(vault);
    await changeMetric(vault, 60);

    const queue = await vaultTier2Queue(vault, {});
    expect(queue.ok).toBe(true);
    if (!queue.ok) throw queue.error;
    const pairs = queue.value.items.map((i) => `${i.artifact}|${i.edge_class}`);
    expect(pairs).toContain("pricing/citer.md|declared");
    expect(pairs).toContain("pricing/earned-dep.md|earned");

    const citerItem = queue.value.items.find((i) => i.artifact === "pricing/citer.md");
    expect(citerItem?.unit).toBe("pricing/metric.md");
    expect(citerItem?.changed_fields).toContain("body");
    expect(citerItem?.field_changes.body).toEqual({ before: null, after: null });
    expect(citerItem?.usage_span).toContain("The Metric value anchors this note.");
    expect(citerItem?.question).toContain("vault_tier2_verdict");

    // still-valid drains the declared pair...
    const valid = await vaultTier2Verdict(vault, {
      artifact: "pricing/citer.md",
      unit: "pricing/metric.md",
      verdict: "still-valid",
      reasoning: "the citer only references the metric's existence, not its value",
      agent: JUDGE,
    });
    expect(valid.ok).toBe(true);
    if (!valid.ok) throw valid.error;
    expect(valid.value.tension_id).toBeNull();

    const after = await vaultTier2Queue(vault, {});
    if (!after.ok) throw after.error;
    expect(after.value.items.map((i) => i.artifact)).not.toContain("pricing/citer.md");

    // ...and the staleness surface reads the verdict.
    const staleness = await vaultStaleness(vault, { artifact: "pricing/citer.md" });
    if (!staleness.ok) throw staleness.error;
    if (staleness.value.mode !== "artifact") throw new Error("expected artifact mode");
    expect(staleness.value.edges[0]?.staleness).toBe("pending-compatible");
    expect(staleness.value.edges[0]?.reason).toContain("tier-2");

    // A second judgment on the same covered pair has nothing pending.
    const again = await vaultTier2Verdict(vault, {
      artifact: "pricing/citer.md",
      unit: "pricing/metric.md",
      verdict: "still-valid",
      reasoning: "duplicate",
      agent: JUDGE,
    });
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.error.message).toContain("no pending semantic review");
  }, 60_000);

  it("a broken verdict logs a typed tension and flips staleness to pending-broken", async () => {
    await seed(vault);
    await changeMetric(vault, 60);

    const broken = await vaultTier2Verdict(vault, {
      artifact: "pricing/earned-dep.md",
      unit: "pricing/metric.md",
      verdict: "broken",
      tension_kind: "factual",
      claim_artifact: "downstream analysis assumes value 40",
      claim_unit: "the metric now reads 60",
      reasoning: "the derived doc bakes in the old value",
      agent: JUDGE,
    });
    expect(broken.ok).toBe(true);
    if (!broken.ok) throw broken.error;
    expect(broken.value.tension_id).toBeTruthy();
    expect(broken.value.recorded.edge_class).toBe("earned");

    const tensions = await listTensions(vault, DEFAULT_TENSION_STATUS);
    if (!tensions.ok) throw tensions.error;
    const logged = tensions.value.find((t) => t.id === broken.value.tension_id);
    expect(logged?.kind).toBe("factual");
    expect(logged?.sourceA).toBe("pricing/earned-dep.md");
    expect(logged?.sourceB).toBe("pricing/metric.md");

    const staleness = await vaultStaleness(vault, { artifact: "pricing/earned-dep.md" });
    if (!staleness.ok) throw staleness.error;
    if (staleness.value.mode !== "artifact") throw new Error("expected artifact mode");
    const earnedRow = staleness.value.edges.find((e) => e.edge_class === "earned");
    expect(earnedRow?.staleness).toBe("pending-broken");
    expect(earnedRow?.reason).toContain(String(broken.value.tension_id));
  }, 60_000);

  it("a newer unit change re-queues a judged pair — verdicts cover one change only", async () => {
    await seed(vault);
    await changeMetric(vault, 60);
    const valid = await vaultTier2Verdict(vault, {
      artifact: "pricing/citer.md",
      unit: "pricing/metric.md",
      verdict: "still-valid",
      reasoning: "holds for 60",
      agent: JUDGE,
    });
    if (!valid.ok) throw valid.error;

    await changeMetric(vault, 80);
    const queue = await vaultTier2Queue(vault, { unit: "pricing/metric.md" });
    if (!queue.ok) throw queue.error;
    expect(queue.value.items.map((i) => i.artifact)).toContain("pricing/citer.md");
  }, 60_000);

  it("hides pairs outside the caller's read scope, verdicts included", async () => {
    await seed(vault);
    await changeMetric(vault, 60);

    const intelOnly = {
      user: "human:narrow",
      roleName: "intel-only",
      role: { read: ["competitive-intel"], write: [], promote: false, ratify: false },
    };
    const queue = await vaultTier2Queue(vault, {}, intelOnly);
    expect(queue.ok).toBe(true);
    if (!queue.ok) return;
    expect(queue.value.items).toEqual([]);

    // A verdict on an unreadable pair is refused with the SAME error a pair
    // with nothing pending produces — no existence signal.
    const hidden = await vaultTier2Verdict(
      vault,
      {
        artifact: "pricing/citer.md",
        unit: "pricing/metric.md",
        verdict: "still-valid",
        reasoning: "x",
        agent: JUDGE,
      },
      intelOnly,
    );
    const ghost = await vaultTier2Verdict(
      vault,
      {
        artifact: "pricing/ghost.md",
        unit: "pricing/metric.md",
        verdict: "still-valid",
        reasoning: "x",
        agent: JUDGE,
      },
      intelOnly,
    );
    expect(hidden.ok || ghost.ok).toBe(false);
    if (hidden.ok || ghost.ok) return;
    expect(hidden.error.message.replace("pricing/citer.md", "pricing/ghost.md")).toBe(
      ghost.error.message,
    );
  }, 60_000);

  it("validates verdict arguments", async () => {
    await seed(vault);
    await changeMetric(vault, 60);

    const noKind = await vaultTier2Verdict(vault, {
      artifact: "pricing/citer.md",
      unit: "pricing/metric.md",
      verdict: "broken",
      reasoning: "x",
      agent: JUDGE,
    });
    expect(noKind.ok).toBe(false);
    if (!noKind.ok) expect(noKind.error.message).toContain("tension_kind");

    const strayKind = await vaultTier2Verdict(vault, {
      artifact: "pricing/citer.md",
      unit: "pricing/metric.md",
      verdict: "still-valid",
      tension_kind: "factual",
      reasoning: "x",
      agent: JUDGE,
    });
    expect(strayKind.ok).toBe(false);

    const badVerdict = await vaultTier2Verdict(vault, {
      artifact: "pricing/citer.md",
      unit: "pricing/metric.md",
      verdict: "maybe",
      reasoning: "x",
      agent: JUDGE,
    });
    expect(badVerdict.ok).toBe(false);
  }, 60_000);
});
