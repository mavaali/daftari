import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultConsumes } from "../../src/tools/consumes.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:compiler";

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Synthesis",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-07-01",
    provenance: "synthesized",
    sources: [],
    superseded_by: null,
    ttl_days: null,
    tags: [],
    ...overrides,
  };
}

describe("vault_consumes (#233)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("end-to-end: run-correlated reads then a write mint the compiled input set", async () => {
    // The run reads two units...
    const r1 = await vaultRead(vault, "pricing/helios-consumption-pricing.md", undefined, "run-42");
    expect(r1.ok).toBe(true);
    const r2 = await vaultRead(
      vault,
      "pricing/serverless-cost-predictability.md",
      undefined,
      "run-42",
    );
    expect(r2.ok).toBe(true);

    // ...then writes an artifact under the same run id.
    const written = await vaultWrite(vault, {
      path: "pricing/synthesis.md",
      body: "# Synthesis\n\nDerived from the two pricing docs.\n",
      frontmatter: frontmatter(),
      agent: AGENT,
      run_id: "run-42",
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw written.error;

    // Forward: the artifact's compiled input set.
    const forward = await vaultConsumes(vault, { artifact: "pricing/synthesis.md" });
    expect(forward.ok).toBe(true);
    if (!forward.ok) throw forward.error;
    expect(forward.value.direction).toBe("forward");
    expect(forward.value.edges.map((e) => e.unit).sort()).toEqual([
      "pricing/helios-consumption-pricing.md",
      "pricing/serverless-cost-predictability.md",
    ]);
    expect(forward.value.edges[0]?.edge_type).toBe("whole-doc-read");
    expect(forward.value.edges[0]?.run_id).toBe("run-42");

    // Reverse: the unit's dependents.
    const reverse = await vaultConsumes(vault, {
      unit: "pricing/helios-consumption-pricing.md",
    });
    expect(reverse.ok).toBe(true);
    if (!reverse.ok) throw reverse.error;
    expect(reverse.value.direction).toBe("reverse");
    expect(reverse.value.edges.map((e) => e.artifact)).toEqual(["pricing/synthesis.md"]);
  }, 60_000);

  it("an uninstrumented write mints no edges; a re-compile supersedes", async () => {
    // No run_id anywhere: no read log, no edges.
    const plain = await vaultWrite(vault, {
      path: "pricing/plain.md",
      body: "# Plain\n",
      frontmatter: frontmatter({ title: "Plain" }),
      agent: AGENT,
    });
    expect(plain.ok).toBe(true);
    const none = await vaultConsumes(vault, { artifact: "pricing/plain.md" });
    expect(none.ok && none.value.total).toBe(0);

    // First compile of the artifact consumes unit A; the second consumes B.
    await vaultRead(vault, "pricing/helios-consumption-pricing.md", undefined, "run-1");
    await vaultWrite(vault, {
      path: "pricing/evolving.md",
      body: "# v1\n",
      frontmatter: frontmatter({ title: "Evolving" }),
      agent: AGENT,
      run_id: "run-1",
    });
    await vaultRead(vault, "pricing/serverless-cost-predictability.md", undefined, "run-2");
    await vaultWrite(vault, {
      path: "pricing/evolving.md",
      body: "# v2\n",
      frontmatter: frontmatter({ title: "Evolving" }),
      agent: AGENT,
      run_id: "run-2",
    });

    const current = await vaultConsumes(vault, { artifact: "pricing/evolving.md" });
    expect(current.ok).toBe(true);
    if (!current.ok) return;
    expect(current.value.edges.map((e) => e.unit)).toEqual([
      "pricing/serverless-cost-predictability.md",
    ]);

    // include_history returns the superseded compile group too.
    const history = await vaultConsumes(vault, {
      artifact: "pricing/evolving.md",
      include_history: true,
    });
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value.edges.map((e) => e.unit).sort()).toEqual([
      "pricing/helios-consumption-pricing.md",
      "pricing/serverless-cost-predictability.md",
    ]);
  }, 60_000);

  it("omits edges whose endpoints the caller cannot read (#217, both-sides)", async () => {
    // The run reads a unit in competitive-intel, writes into pricing.
    await vaultRead(vault, "competitive-intel/vega-insight-positioning.md", undefined, "run-7");
    await vaultWrite(vault, {
      path: "pricing/cross.md",
      body: "# Cross\n",
      frontmatter: frontmatter({ title: "Cross" }),
      agent: AGENT,
      run_id: "run-7",
    });

    const pricingOnly = {
      user: "human:narrow",
      roleName: "pricing-only",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };
    const gated = await vaultConsumes(vault, { artifact: "pricing/cross.md" }, pricingOnly);
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;
    // The edge's unit endpoint is unreadable: omitted entirely, total follows.
    expect(gated.value.edges).toEqual([]);
    expect(gated.value.total).toBe(0);

    const full = {
      user: "human:broad",
      roleName: "everything",
      role: { read: ["*"], write: [], promote: false, ratify: false },
    };
    const open = await vaultConsumes(vault, { artifact: "pricing/cross.md" }, full);
    expect(open.ok && open.value.total).toBe(1);
  }, 60_000);

  it("denied reads are never recorded as inputs", async () => {
    const noIntel = {
      user: "agent:narrow",
      roleName: "pricing-only",
      role: { read: ["pricing"], write: ["pricing"], promote: false, ratify: false },
    };
    const denied = await vaultRead(
      vault,
      "competitive-intel/vega-insight-positioning.md",
      noIntel,
      "run-8",
    );
    expect(denied.ok).toBe(false);
    const allowed = await vaultRead(
      vault,
      "pricing/helios-consumption-pricing.md",
      noIntel,
      "run-8",
    );
    expect(allowed.ok).toBe(true);

    await vaultWrite(
      vault,
      {
        path: "pricing/honest.md",
        body: "# Honest\n",
        frontmatter: frontmatter({ title: "Honest" }),
        agent: "agent:narrow",
        run_id: "run-8",
      },
      noIntel,
    );

    const forward = await vaultConsumes(vault, { artifact: "pricing/honest.md" });
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    expect(forward.value.edges.map((e) => e.unit)).toEqual([
      "pricing/helios-consumption-pricing.md",
    ]);
  }, 60_000);

  it("rejects zero or two anchors", async () => {
    const neither = await vaultConsumes(vault, {});
    expect(neither.ok).toBe(false);
    const both = await vaultConsumes(vault, { artifact: "a.md", unit: "b.md" });
    expect(both.ok).toBe(false);
  });
});
