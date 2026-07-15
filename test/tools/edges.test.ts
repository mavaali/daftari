import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { observeEdge } from "../../src/curation/edges.js";
import { listTensions } from "../../src/curation/tension.js";
import { vaultEdgeContest, vaultEdgeObserve, vaultEdges } from "../../src/tools/edges.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:curation-loop";
const GUEST: AccessContext = { user: "guest", roleName: "guest", role: null };

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "A Note",
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
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

async function seed(vault: string, path: string): Promise<void> {
  const written = await vaultWrite(vault, {
    path,
    body: `# A Note\n\nBody of ${path}.\n`,
    frontmatter: frontmatter(),
    agent: "agent:seed",
  });
  if (!written.ok) throw written.error;
}

describe("vault_edge_observe", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("records an observation and returns the collapsed edge", async () => {
    await seed(vault, "pricing/a.md");
    await seed(vault, "pricing/b.md");
    const result = await vaultEdgeObserve(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/b.md",
      observed_by: AGENT,
      blind: true,
      varied_axis: "prompt",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("candidate");
    expect(result.value.kSurvived).toBe(0); // birth is not a survival
  }, 60_000);

  it("rejects an edge whose endpoint document does not exist", async () => {
    await seed(vault, "pricing/a.md");
    const result = await vaultEdgeObserve(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/ghost.md",
      observed_by: AGENT,
      blind: true,
    });
    expect(result.ok).toBe(false);
  }, 60_000);

  it("rejects a self-edge", async () => {
    await seed(vault, "pricing/a.md");
    const result = await vaultEdgeObserve(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/a.md",
      observed_by: AGENT,
      blind: true,
    });
    expect(result.ok).toBe(false);
  }, 60_000);

  it("rejects a self-edge disguised by a path alias", async () => {
    await seed(vault, "pricing/a.md");
    const result = await vaultEdgeObserve(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/../pricing/a.md",
      observed_by: AGENT,
      blind: true,
    });
    expect(result.ok).toBe(false);
  }, 60_000);

  it("canonicalizes aliased paths onto one edge (no phantom twins)", async () => {
    await seed(vault, "pricing/a.md");
    await seed(vault, "pricing/b.md");
    const first = await vaultEdgeObserve(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/b.md",
      observed_by: AGENT,
      blind: false,
    });
    expect(first.ok).toBe(true);
    const aliased = await vaultEdgeObserve(vault, {
      from_path: "./pricing/a.md",
      to_path: "pricing/../pricing/b.md",
      observed_by: AGENT,
      blind: true,
      varied_axis: "model",
    });
    expect(aliased.ok).toBe(true);
    if (!aliased.ok) return;
    // The aliased observation landed on the SAME edge, not a twin.
    expect(aliased.value.observations).toBe(2);

    const all = await vaultEdges(vault, {});
    expect(all.ok && all.value.total).toBe(1);
    expect(all.ok && all.value.edges[0]?.fromPath).toBe("pricing/a.md");
  }, 60_000);

  it("rejects an endpoint that escapes the vault", async () => {
    await seed(vault, "pricing/a.md");
    const result = await vaultEdgeObserve(vault, {
      from_path: "pricing/a.md",
      to_path: "../outside.md",
      observed_by: AGENT,
      blind: true,
    });
    expect(result.ok).toBe(false);
  }, 60_000);

  it("rejects a missing blind flag and an unknown axis", async () => {
    await seed(vault, "pricing/a.md");
    await seed(vault, "pricing/b.md");
    const noBlind = await vaultEdgeObserve(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/b.md",
      observed_by: AGENT,
    });
    expect(noBlind.ok).toBe(false);
    const badAxis = await vaultEdgeObserve(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/b.md",
      observed_by: AGENT,
      blind: true,
      varied_axis: "vibes",
    });
    expect(badAxis.ok).toBe(false);
  }, 60_000);

  it("denies the guest role", async () => {
    const result = await vaultEdgeObserve(
      vault,
      { from_path: "a.md", to_path: "b.md", observed_by: AGENT, blind: true },
      GUEST,
    );
    expect(result.ok).toBe(false);
  });
});

describe("vault_edge_contest", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("revokes the edge and logs a tension", async () => {
    await seed(vault, "pricing/a.md");
    await seed(vault, "pricing/b.md");
    await vaultEdgeObserve(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/b.md",
      observed_by: AGENT,
      blind: true,
      varied_axis: "model",
    });

    const result = await vaultEdgeContest(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/b.md",
      contested_by: AGENT,
      reason: "re-derivation produced a contradicting claim",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.edge.status).toBe("revoked");
    expect(result.value.tension_id).toMatch(/^tension-\d+$/);

    const tensions = await listTensions(vault);
    expect(tensions.ok).toBe(true);
    if (!tensions.ok) return;
    const entry = tensions.value.find((t) => t.id === result.value.tension_id);
    expect(entry?.title).toContain("pricing/a.md");
    expect(entry?.kind).toBe("factual");
    expect(entry?.claimB).toContain("contradicting claim");
  }, 60_000);

  it("errors on an unknown edge and writes no tension", async () => {
    const before = await listTensions(vault);
    const baseline = before.ok ? before.value.length : 0;

    const result = await vaultEdgeContest(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/b.md",
      contested_by: AGENT,
      reason: "x",
    });
    expect(result.ok).toBe(false);

    const after = await listTensions(vault);
    expect(after.ok && after.value.length).toBe(baseline);
  });

  it("errors on an already-revoked edge", async () => {
    await seed(vault, "pricing/a.md");
    await seed(vault, "pricing/b.md");
    await vaultEdgeObserve(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/b.md",
      observed_by: AGENT,
      blind: false,
    });
    const first = await vaultEdgeContest(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/b.md",
      contested_by: AGENT,
      reason: "x",
    });
    expect(first.ok).toBe(true);
    const again = await vaultEdgeContest(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/b.md",
      contested_by: AGENT,
      reason: "y",
    });
    expect(again.ok).toBe(false);
  }, 60_000);

  it("denies the guest role", async () => {
    const result = await vaultEdgeContest(
      vault,
      { from_path: "a.md", to_path: "b.md", contested_by: AGENT, reason: "x" },
      GUEST,
    );
    expect(result.ok).toBe(false);
  });

  it("records decided_by_principal from access.user on the contest tension", async () => {
    await seed(vault, "pricing/a.md");
    await seed(vault, "pricing/b.md");
    await vaultEdgeObserve(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/b.md",
      observed_by: AGENT,
      blind: true,
      varied_axis: "model",
    });

    const ratifyAccess: AccessContext = {
      user: "agent:curation-loop",
      roleName: "curator",
      role: { read: ["*"], write: ["*"], promote: false, ratify: true },
    };

    const result = await vaultEdgeContest(
      vault,
      {
        from_path: "pricing/a.md",
        to_path: "pricing/b.md",
        contested_by: AGENT,
        reason: "re-derivation produced a contradicting claim",
      },
      ratifyAccess,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const tensions = await listTensions(vault);
    expect(tensions.ok).toBe(true);
    if (!tensions.ok) return;
    const entry = tensions.value.find((t) => t.id === result.value.tension_id);
    expect(entry?.decidedByPrincipal).toBe("agent:curation-loop");
  }, 60_000);
});

describe("vault_edges", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("lists and filters edges", async () => {
    await seed(vault, "pricing/a.md");
    await seed(vault, "pricing/b.md");
    await seed(vault, "pricing/c.md");
    await vaultEdgeObserve(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/b.md",
      observed_by: AGENT,
      blind: true,
      varied_axis: "prompt",
    });
    await vaultEdgeObserve(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/c.md",
      observed_by: AGENT,
      blind: false,
    });
    await vaultEdgeContest(vault, {
      from_path: "pricing/a.md",
      to_path: "pricing/c.md",
      contested_by: AGENT,
      reason: "failed",
    });

    const all = await vaultEdges(vault, {});
    expect(all.ok && all.value.total).toBe(2);

    const revoked = await vaultEdges(vault, { status: "revoked" });
    expect(revoked.ok && revoked.value.total).toBe(1);
    expect(revoked.ok && revoked.value.edges[0]?.toPath).toBe("pricing/c.md");

    const toB = await vaultEdges(vault, { to_path: "pricing/b.md" });
    expect(toB.ok && toB.value.total).toBe(1);

    const fromA = await vaultEdges(vault, { from_path: "pricing/a.md" });
    expect(fromA.ok && fromA.value.total).toBe(2);

    const badStatus = await vaultEdges(vault, { status: "nonsense" });
    expect(badStatus.ok).toBe(false);
  }, 60_000);

  it("denies the guest role", async () => {
    const result = await vaultEdges(vault, {}, GUEST);
    expect(result.ok).toBe(false);
  });

  // Symmetric-edge consumer audit (Task 9): a direction-unconfirmed edge must
  // stay VISIBLE as an undirected relationship in the listing — vault_edges does
  // not walk edges directionally, so it lists it and exposes directionVerdict,
  // never silently dropping it or treating from→to as a trusted premise link.
  it("lists a direction-symmetric edge and exposes its directionVerdict", async () => {
    await seed(vault, "pricing/a.md");
    await seed(vault, "pricing/b.md");
    const sym = await observeEdge(vault, {
      fromPath: "pricing/a.md",
      toPath: "pricing/b.md",
      observedBy: AGENT,
      blind: true,
      axis: "prompt",
      premiseVote: "symmetric",
    });
    expect(sym.ok).toBe(true);

    const all = await vaultEdges(vault, {});
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.total).toBe(1);
    const edge = all.value.edges[0];
    expect(edge?.fromPath).toBe("pricing/a.md");
    expect(edge?.toPath).toBe("pricing/b.md");
    expect(edge?.directionVerdict).toBe("symmetric");
  }, 60_000);
});

describe("vault_edges — existence disclosure (#217)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  const pricingOnly: AccessContext = {
    user: "t",
    roleName: "analyst",
    role: { read: ["pricing"], write: [], promote: false, ratify: false },
  };

  async function seedIn(v: string, path: string, collection: string): Promise<void> {
    const written = await vaultWrite(v, {
      path,
      body: `# A Note\n\nBody of ${path}.\n`,
      frontmatter: frontmatter({ collection }),
      agent: "agent:seed",
    });
    if (!written.ok) throw written.error;
  }

  it("omits edges with an endpoint in an unreadable collection", async () => {
    await seedIn(vault, "pricing/a.md", "pricing");
    await seedIn(vault, "pricing/b.md", "pricing");
    await seedIn(vault, "intel/c.md", "intel");
    for (const toPath of ["pricing/b.md", "intel/c.md"]) {
      const obs = await vaultEdgeObserve(vault, {
        from_path: "pricing/a.md",
        to_path: toPath,
        observed_by: AGENT,
        blind: true,
        varied_axis: "prompt",
      });
      expect(obs.ok).toBe(true);
    }

    const restricted = await vaultEdges(vault, {}, pricingOnly);
    expect(restricted.ok).toBe(true);
    if (!restricted.ok) return;
    expect(restricted.value.total).toBe(1);
    expect(restricted.value.edges.map((e) => e.toPath)).toEqual(["pricing/b.md"]);

    // No access context ⇒ the full listing, as before.
    const full = await vaultEdges(vault, {});
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.value.total).toBe(2);
  }, 60_000);
});
