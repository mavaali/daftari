import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { CONSOLIDATE_AGENT } from "../../src/consolidate/constants.js";
import { recordProvenance } from "../../src/curation/provenance.js";
import { addTension, listTensions, resolveTension } from "../../src/curation/tension.js";
import {
  curationTools,
  vaultLint,
  vaultProvenance,
  vaultTensionBlast,
  vaultTensionClusters,
  vaultTensionLog,
  vaultTensionResolve,
} from "../../src/tools/curation.js";

const LINT_VAULT = resolve("test/fixtures/lint-vault");

describe("curation tools", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-curation-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  describe("vault_lint", () => {
    it("runs every check and totals the findings", async () => {
      const result = await vaultLint(LINT_VAULT, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.filter).toBeNull();
      expect(result.value.totalFindings).toBe(8);
      expect(Object.keys(result.value.checks)).toHaveLength(10);
    });

    it("narrows the report to a single check when filtered", async () => {
      const result = await vaultLint(LINT_VAULT, { filter: "orphanFiles" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.filter).toBe("orphanFiles");
      expect(Object.keys(result.value.checks)).toEqual(["orphanFiles"]);
      expect(result.value.totalFindings).toBe(1);
    });

    it("rejects an unknown filter", async () => {
      const result = await vaultLint(LINT_VAULT, { filter: "nonsense" });
      expect(result.ok).toBe(false);
    });

    it("tool result carries coverageEquity (unfiltered)", async () => {
      const result = await vaultLint(LINT_VAULT, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.coverageEquity).toBeDefined();
      expect(result.value.coverageEquity.directionResolution).toBeDefined();
    });

    it("tool result carries coverageEquity (filtered)", async () => {
      const result = await vaultLint(LINT_VAULT, { filter: "orphanFiles" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.coverageEquity).toBeDefined();
      expect(result.value.coverageEquity.actionMix).toBeDefined();
    });

    it("tool result carries reviewThroughput, unfiltered and filtered (#236 QW2)", async () => {
      const unfiltered = await vaultLint(LINT_VAULT, {});
      expect(unfiltered.ok).toBe(true);
      if (!unfiltered.ok) return;
      expect(unfiltered.value.reviewThroughput.lifetime).toBeDefined();
      const filtered = await vaultLint(LINT_VAULT, { filter: "orphanFiles" });
      expect(filtered.ok).toBe(true);
      if (!filtered.ok) return;
      expect(filtered.value.reviewThroughput.lifetime).toBeDefined();
    });
  });

  describe("vault_tension_log", () => {
    it("logs a tension and persists it as unresolved", async () => {
      const result = await vaultTensionLog(vault, {
        title: "Capacity model disagreement",
        sourceA: "pricing/a.md",
        claimA: "pooled is cheaper at scale",
        sourceB: "pricing/b.md",
        claimB: "consumption is cheaper at scale",
        agent: "agent:claude-code",
        kind: "factual",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("unresolved");
      expect(result.value.loggedBy).toBe("agent:claude-code");
      expect(result.value.kind).toBe("factual");

      const logged = await listTensions(vault);
      expect(logged.ok && logged.value).toHaveLength(1);
    });

    it("rejects a tension missing a required field", async () => {
      const result = await vaultTensionLog(vault, {
        title: "Incomplete",
        sourceA: "pricing/a.md",
        agent: "agent:claude-code",
        kind: "factual",
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("vault_tension_clusters", () => {
    it("returns zero clusters when nothing has been logged", async () => {
      const result = await vaultTensionClusters(vault, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.cluster_count).toBe(0);
      expect(result.value.clusters).toEqual([]);
    });

    it("groups two transitively-connected tensions into one cluster", async () => {
      await vaultTensionLog(vault, {
        title: "t1",
        sourceA: "a.md",
        claimA: "A",
        sourceB: "b.md",
        claimB: "B",
        agent: "agent:claude-code",
        kind: "factual",
      });
      await vaultTensionLog(vault, {
        title: "t2",
        sourceA: "b.md",
        claimA: "B",
        sourceB: "c.md",
        claimB: "C",
        agent: "agent:claude-code",
        kind: "interpretive",
      });

      const result = await vaultTensionClusters(vault, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.cluster_count).toBe(1);
      const [cluster] = result.value.clusters;
      expect(cluster?.documents).toEqual(["a.md", "b.md", "c.md"]);
      expect(cluster?.id).toMatch(/^cluster:[0-9a-f]{8}$/);
      expect(cluster?.tension_count).toBe(2);
    });

    it("drops accepted-resolution tensions from cluster scope", async () => {
      const logged = await vaultTensionLog(vault, {
        title: "stable",
        sourceA: "a.md",
        claimA: "A",
        sourceB: "b.md",
        claimB: "B",
        agent: "agent:claude-code",
        kind: "interpretive",
      });
      expect(logged.ok).toBe(true);
      if (!logged.ok) return;
      await resolveTension(vault, logged.value.id as string, {
        resolved_at: "2026-05-15T00:00:00Z",
        resolved_by: "human:mihir",
        kind: "accepted",
      });

      const result = await vaultTensionClusters(vault, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.cluster_count).toBe(0);
    });

    it("registers vault_tension_clusters as a read-only MCP tool", () => {
      const def = curationTools.find((t) => t.name === "vault_tension_clusters");
      expect(def).toBeDefined();
      expect(def?.annotations?.readOnlyHint).toBe(true);
      // No required arguments — accepts an empty object.
      expect((def?.inputSchema as { required?: unknown }).required).toBeUndefined();
    });
  });

  describe("vault_tension_blast", () => {
    it("rejects calls that supply neither document nor cluster_id", async () => {
      const result = await vaultTensionBlast(vault, {});
      expect(result.ok).toBe(false);
    });

    it("rejects calls that supply both document and cluster_id", async () => {
      const result = await vaultTensionBlast(vault, {
        document: "a.md",
        cluster_id: "cluster:00000000",
      });
      expect(result.ok).toBe(false);
    });

    it("registers vault_tension_blast as a read-only MCP tool", () => {
      const def = curationTools.find((t) => t.name === "vault_tension_blast");
      expect(def).toBeDefined();
      expect(def?.annotations?.readOnlyHint).toBe(true);
      // Neither argument is required at the schema level — the exactly-one-of
      // constraint is enforced in the handler so the error message stays
      // consolidated and informative.
      expect((def?.inputSchema as { required?: unknown }).required).toBeUndefined();
    });
  });

  describe("vault_provenance", () => {
    it("returns the write history for a single file, oldest first", async () => {
      await recordProvenance(vault, {
        timestamp: "2026-05-01T00:00:00.000Z",
        tool: "vault_write",
        file: "pricing/a.md",
        agent: "agent:claude-code",
        action: "create",
      });
      await recordProvenance(vault, {
        timestamp: "2026-05-02T00:00:00.000Z",
        tool: "vault_write",
        file: "pricing/b.md",
        agent: "agent:claude-code",
        action: "create",
      });
      await recordProvenance(vault, {
        timestamp: "2026-05-03T00:00:00.000Z",
        tool: "vault_promote",
        file: "pricing/a.md",
        agent: "human:mihir",
        action: "promote",
      });

      const result = await vaultProvenance(vault, { filePath: "pricing/a.md" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.count).toBe(2);
      expect(result.value.history.map((e) => e.action)).toEqual(["create", "promote"]);
    });

    it("returns an empty history for a file with no recorded writes", async () => {
      const result = await vaultProvenance(vault, { filePath: "pricing/x.md" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.count).toBe(0);
    });

    it("rejects a missing filePath", async () => {
      const result = await vaultProvenance(vault, {});
      expect(result.ok).toBe(false);
    });

    it("denies history for a file in a collection the role cannot read", async () => {
      await recordProvenance(vault, {
        timestamp: "2026-05-01T00:00:00.000Z",
        tool: "vault_write",
        file: "pricing/a.md",
        agent: "agent:claude-code",
        action: "create",
        frontmatter_diff: { confidence: { from: "low", to: "high" } },
      });
      const otherCollection = {
        user: "agent:reader",
        roleName: "reader",
        role: { read: ["competitive-intel"], write: [], promote: false, ratify: false },
      };
      const result = await vaultProvenance(vault, { filePath: "pricing/a.md" }, otherCollection);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("access denied");
    });

    it("derives the gated collection from frontmatter, not the path segment", async () => {
      // Doc lives under pricing/ but declares collection: competitive-intel.
      // The frontmatter collection is authoritative for the RBAC gate.
      mkdirSync(join(vault, "pricing"), { recursive: true });
      writeFileSync(
        join(vault, "pricing", "cross.md"),
        "---\ntitle: Cross\ncollection: competitive-intel\nstatus: draft\n---\n# Cross\n",
      );
      await recordProvenance(vault, {
        timestamp: "2026-05-01T00:00:00.000Z",
        tool: "vault_write",
        file: "pricing/cross.md",
        agent: "agent:claude-code",
        action: "create",
      });

      // A reader of the path-segment collection (pricing) is denied...
      const pricingReader = {
        user: "agent:reader",
        roleName: "reader",
        role: { read: ["pricing"], write: [], promote: false, ratify: false },
      };
      const denied = await vaultProvenance(vault, { filePath: "pricing/cross.md" }, pricingReader);
      expect(denied.ok).toBe(false);

      // ...while a reader of the real (frontmatter) collection is allowed.
      const ciReader = {
        user: "agent:reader",
        roleName: "reader",
        role: { read: ["competitive-intel"], write: [], promote: false, ratify: false },
      };
      const allowed = await vaultProvenance(vault, { filePath: "pricing/cross.md" }, ciReader);
      expect(allowed.ok).toBe(true);
    });

    it("returns history for a file in a collection the role can read", async () => {
      await recordProvenance(vault, {
        timestamp: "2026-05-01T00:00:00.000Z",
        tool: "vault_write",
        file: "pricing/a.md",
        agent: "agent:claude-code",
        action: "create",
      });
      const pricingReader = {
        user: "agent:reader",
        roleName: "reader",
        role: { read: ["pricing"], write: [], promote: false, ratify: false },
      };
      const result = await vaultProvenance(vault, { filePath: "pricing/a.md" }, pricingReader);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.count).toBe(1);
    });
  });

  describe("tension RBAC alignment (#212)", () => {
    const pricingOnly: AccessContext = {
      user: "t",
      roleName: "analyst",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };
    const both: AccessContext = {
      user: "t",
      roleName: "lead",
      role: { read: ["pricing", "intel"], write: [], promote: false, ratify: false },
    };

    async function seedCrossTension(v: string) {
      mkdirSync(join(v, "pricing"), { recursive: true });
      mkdirSync(join(v, "intel"), { recursive: true });
      writeFileSync(join(v, "pricing/a.md"), "---\ntitle: A\n---\nbody a");
      writeFileSync(join(v, "pricing/b.md"), "---\ntitle: B\n---\nbody b");
      writeFileSync(join(v, "intel/c.md"), "---\ntitle: C\n---\nbody c");
      const t1 = await addTension(v, {
        title: "in-pricing",
        kind: "factual",
        sourceA: "pricing/a.md",
        claimA: "x",
        sourceB: "pricing/b.md",
        claimB: "y",
        loggedBy: "test",
      });
      const t2 = await addTension(v, {
        title: "cross",
        kind: "factual",
        sourceA: "pricing/a.md",
        claimA: "x",
        sourceB: "intel/c.md",
        claimB: "z",
        loggedBy: "test",
      });
      if (!t1.ok || !t2.ok) throw new Error("seed failed");
      return { t1: t1.value, t2: t2.value };
    }

    it("clusters: hidden tensions are absent from members AND counts", async () => {
      await seedCrossTension(vault);
      const restricted = await vaultTensionClusters(vault, {}, pricingOnly);
      expect(restricted.ok).toBe(true);
      if (!restricted.ok) return;
      const docs = restricted.value.clusters.flatMap((c) => c.documents);
      expect(docs).not.toContain("intel/c.md");
      // Only the in-pricing tension remains: exactly one cluster of the pair.
      expect(restricted.value.clusters).toHaveLength(1);
      expect(restricted.value.clusters[0]?.documents.sort()).toEqual([
        "pricing/a.md",
        "pricing/b.md",
      ]);
      // Spec case 6's "absent from counts": the surviving cluster counts only
      // the visible tension.
      expect(restricted.value.clusters[0]?.tension_count).toBe(1);

      const full = await vaultTensionClusters(vault, {}, both);
      expect(full.ok).toBe(true);
      if (!full.ok) return;
      expect(full.value.clusters.flatMap((c) => c.documents)).toContain("intel/c.md");
    });

    it("blast: unreadable explicit doc is denied by path, before existence", async () => {
      await seedCrossTension(vault);
      const denied = await vaultTensionBlast(vault, { document: "intel/c.md" }, pricingOnly);
      expect(denied.ok).toBe(false);
      if (denied.ok) return;
      expect(denied.error.message).toContain("access denied");
      expect(denied.error.message).toContain("intel/c.md");
      // Purely input-derived: a NONEXISTENT doc in an unreadable collection
      // gets the identical denial shape, not "not found".
      const ghost = await vaultTensionBlast(vault, { document: "intel/ghost.md" }, pricingOnly);
      expect(ghost.ok).toBe(false);
      if (ghost.ok) return;
      expect(ghost.error.message).toContain("access denied");
      expect(ghost.error.message).not.toContain("not found");
    });

    it("blast: hidden tensions do not seed cluster membership", async () => {
      await seedCrossTension(vault);
      const res = await vaultTensionBlast(vault, { document: "pricing/a.md" }, pricingOnly);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.cluster_documents).not.toContain("intel/c.md");
    });

    it("log: denied naming only the caller-supplied path; both-sides and no-RBAC log fine", async () => {
      mkdirSync(join(vault, "pricing"), { recursive: true });
      mkdirSync(join(vault, "intel"), { recursive: true });
      const argsFor = (b: string) => ({
        title: "t",
        kind: "factual",
        sourceA: "pricing/a.md",
        claimA: "x",
        sourceB: b,
        claimB: "y",
        agent: "test",
      });
      const denied = await vaultTensionLog(vault, argsFor("intel/c.md"), pricingOnly);
      expect(denied.ok).toBe(false);
      if (denied.ok) return;
      expect(denied.error.message).toBe(
        "access denied: role 'analyst' cannot log a tension naming 'intel/c.md'",
      );
      expect(await vaultTensionLog(vault, argsFor("intel/c.md"), both)).toMatchObject({ ok: true });
      expect(await vaultTensionLog(vault, argsFor("intel/d.md"))).toMatchObject({ ok: true });
    });

    it("resolve: invisible tension is indistinguishable from nonexistent, even for loop-authored", async () => {
      const { t2 } = await seedCrossTension(vault);
      // Loop-authored invisible entry: the ordering pin. A non-ratify,
      // one-sided caller must get NOT-FOUND, not the ratify error.
      const loop = await addTension(vault, {
        title: "loop cross",
        kind: "factual",
        sourceA: "pricing/a.md",
        claimA: "x",
        sourceB: "intel/c.md",
        claimB: "z",
        loggedBy: CONSOLIDATE_AGENT,
      });
      if (!loop.ok) throw loop.error;

      const resolution = { kind: "accepted" } as const;
      const invisible = await vaultTensionResolve(
        vault,
        { id: t2.id, kind: resolution.kind },
        pricingOnly,
      );
      const nonexistent = await vaultTensionResolve(
        vault,
        { id: "tension-99999", kind: resolution.kind },
        pricingOnly,
      );
      expect(invisible.ok).toBe(false);
      expect(nonexistent.ok).toBe(false);
      if (invisible.ok || nonexistent.ok) return;
      // String equality with the id swapped: the denial carries zero extra info.
      expect(invisible.error.message).toBe(`tension not found: ${t2.id}`);
      expect(nonexistent.error.message).toBe("tension not found: tension-99999");

      const loopInvisible = await vaultTensionResolve(
        vault,
        { id: loop.value.id, kind: resolution.kind },
        pricingOnly,
      );
      expect(loopInvisible.ok).toBe(false);
      if (loopInvisible.ok) return;
      expect(loopInvisible.error.message).toBe(`tension not found: ${loop.value.id}`);
      expect(loopInvisible.error.message).not.toContain("ratify");

      // Visible + loop-authored still requires ratify (existing rule intact).
      const loopVisible = await addTension(vault, {
        title: "loop in-pricing",
        kind: "factual",
        sourceA: "pricing/a.md",
        claimA: "x",
        sourceB: "pricing/b.md",
        claimB: "y",
        loggedBy: CONSOLIDATE_AGENT,
      });
      if (!loopVisible.ok) throw loopVisible.error;
      const ratifyDenied = await vaultTensionResolve(
        vault,
        { id: loopVisible.value.id, kind: resolution.kind },
        pricingOnly,
      );
      expect(ratifyDenied.ok).toBe(false);
      if (ratifyDenied.ok) return;
      expect(ratifyDenied.error.message).toContain("cannot resolve a loop-authored tension");
    });
  });

  describe("edge-graph existence disclosure (#217)", () => {
    const pricingOnly: AccessContext = {
      user: "t",
      roleName: "analyst",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };
    const both: AccessContext = {
      user: "t",
      roleName: "lead",
      role: { read: ["pricing", "intel"], write: [], promote: false, ratify: false },
    };

    // pricing/a.md is cited by one readable doc and one hidden doc.
    function seedBlastGraph(v: string) {
      mkdirSync(join(v, "pricing"), { recursive: true });
      mkdirSync(join(v, "intel"), { recursive: true });
      writeFileSync(join(v, "pricing/a.md"), "---\ntitle: A\n---\nbody a");
      writeFileSync(
        join(v, "pricing/c.md"),
        "---\ntitle: C\nsources:\n  - pricing/a.md\n---\nbody c",
      );
      writeFileSync(
        join(v, "intel/h.md"),
        "---\ntitle: H\nsources:\n  - pricing/a.md\n---\nbody h",
      );
    }

    it("blast: downstream list omits unreadable docs; counts and depth follow", async () => {
      seedBlastGraph(vault);
      const res = await vaultTensionBlast(vault, { document: "pricing/a.md" }, pricingOnly);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.downstream.map((d) => d.path)).toEqual(["pricing/c.md"]);
      expect(res.value.primary_blast).toBe(1);
      expect(res.value.advisory_blast).toBe(0);
      expect(res.value.hidden_downstream).toBe("some");
    });

    it("blast: full-read and no-RBAC callers see everything, hidden_downstream 'none'", async () => {
      seedBlastGraph(vault);
      for (const access of [both, undefined]) {
        const res = await vaultTensionBlast(vault, { document: "pricing/a.md" }, access);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        expect(res.value.downstream.map((d) => d.path).sort()).toEqual([
          "intel/h.md",
          "pricing/c.md",
        ]);
        expect(res.value.primary_blast).toBe(2);
        expect(res.value.hidden_downstream).toBe("none");
      }
    });

    it("lint: findings compute from the caller's vantage — hidden docs absent", async () => {
      mkdirSync(join(vault, "pricing"), { recursive: true });
      mkdirSync(join(vault, "intel"), { recursive: true });
      writeFileSync(join(vault, "pricing/a.md"), "---\ntitle: A\n---\nbody a");
      writeFileSync(join(vault, "intel/c.md"), "---\ntitle: C\n---\nbody c");

      const res = await vaultLint(vault, {}, pricingOnly);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.checks.orphanFiles?.map((f) => f.path)).toEqual(["pricing/a.md"]);
      const allPaths = Object.values(res.value.checks)
        .flat()
        .map((f) => f.path);
      expect(allPaths).not.toContain("intel/c.md");
      expect(res.value.totalFindings).toBe(allPaths.length);
    });

    it("lint: tensionHealth stays vault-global under RBAC (documented acceptance)", async () => {
      await (async () => {
        mkdirSync(join(vault, "pricing"), { recursive: true });
        mkdirSync(join(vault, "intel"), { recursive: true });
        writeFileSync(join(vault, "pricing/a.md"), "---\ntitle: A\n---\nbody a");
        writeFileSync(join(vault, "intel/c.md"), "---\ntitle: C\n---\nbody c");
        const t = await addTension(vault, {
          title: "cross",
          kind: "factual",
          sourceA: "pricing/a.md",
          claimA: "x",
          sourceB: "intel/c.md",
          claimB: "z",
          loggedBy: "test",
        });
        if (!t.ok) throw t.error;
      })();

      const res = await vaultLint(vault, {}, pricingOnly);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // Counts only, no paths — the accepted global aggregate (decision C).
      expect(res.value.tensionHealth.total).toBe(1);
    });
  });
});
