// Phase 2 of the tension graph plan (2026-05-31): connected-component clusters
// over the tension log, with content-addressed cluster IDs.
//
// The cluster computation operates over live contested regions only — see the
// spec's "Cluster scope" section. Resolved tensions (`resolved: true`) and
// stable-acknowledged disagreements (`resolution.kind: accepted`) are not
// edges in the cluster graph and contribute nothing to membership.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTension, resolveTension, type TensionEntry } from "../../src/curation/tension.js";
import {
  computeTensionClusters,
  loadTensionClusters,
} from "../../src/curation/tension-clusters.js";

const NOW = new Date("2026-06-01T00:00:00Z");

// Synthetic-entry helper for pure-function tests. Mirrors the buildEntry
// helper in tension.test.ts.
const buildEntry = (overrides: Partial<TensionEntry>): TensionEntry => ({
  id: "tension-001",
  date: "2026-05-01",
  title: "t",
  kind: "factual",
  sourceA: "a.md",
  claimA: "A",
  sourceB: "b.md",
  claimB: "B",
  status: "unresolved",
  loggedBy: "agent:claude-code",
  resolved: false,
  ...overrides,
});

describe("computeTensionClusters", () => {
  it("returns an empty result when no tensions are in scope", () => {
    const result = computeTensionClusters([], NOW);
    expect(result.cluster_count).toBe(0);
    expect(result.clusters).toEqual([]);
  });

  it("forms two disjoint clusters from two disconnected tensions (A↔B, C↔D)", () => {
    const tensions = [
      buildEntry({ id: "tension-001", sourceA: "a.md", sourceB: "b.md" }),
      buildEntry({ id: "tension-002", sourceA: "c.md", sourceB: "d.md" }),
    ];
    const result = computeTensionClusters(tensions, NOW);
    expect(result.cluster_count).toBe(2);
    const sizes = result.clusters.map((c) => c.size).sort();
    expect(sizes).toEqual([2, 2]);
    const allDocs = result.clusters.flatMap((c) => c.documents).sort();
    expect(allDocs).toEqual(["a.md", "b.md", "c.md", "d.md"]);
  });

  it("forms one cluster from two tensions sharing a node (A↔B, B↔C)", () => {
    const tensions = [
      buildEntry({ id: "tension-001", sourceA: "a.md", sourceB: "b.md" }),
      buildEntry({ id: "tension-002", sourceA: "b.md", sourceB: "c.md" }),
    ];
    const result = computeTensionClusters(tensions, NOW);
    expect(result.cluster_count).toBe(1);
    const [cluster] = result.clusters;
    expect(cluster?.documents).toEqual(["a.md", "b.md", "c.md"]);
    expect(cluster?.size).toBe(3);
  });

  it("forms one cluster from three tensions bridging two disjoint pairs", () => {
    // A↔B, C↔D, then B↔C merges them into {A,B,C,D}.
    const tensions = [
      buildEntry({ id: "tension-001", sourceA: "a.md", sourceB: "b.md" }),
      buildEntry({ id: "tension-002", sourceA: "c.md", sourceB: "d.md" }),
      buildEntry({ id: "tension-003", sourceA: "b.md", sourceB: "c.md" }),
    ];
    const result = computeTensionClusters(tensions, NOW);
    expect(result.cluster_count).toBe(1);
    const [cluster] = result.clusters;
    expect(cluster?.documents).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(cluster?.tension_count).toBe(3);
  });

  it("excludes resolved-corrected tensions from cluster formation", () => {
    // A↔B is corrected (closed); C↔D is unresolved. Only {C,D} clusters.
    const tensions = [
      buildEntry({
        id: "tension-001",
        sourceA: "a.md",
        sourceB: "b.md",
        resolved: true,
        resolution: {
          resolved_at: "2026-05-15T00:00:00Z",
          resolved_by: "mihir",
          kind: "corrected",
        },
      }),
      buildEntry({ id: "tension-002", sourceA: "c.md", sourceB: "d.md" }),
    ];
    const result = computeTensionClusters(tensions, NOW);
    expect(result.cluster_count).toBe(1);
    const [cluster] = result.clusters;
    expect(cluster?.documents).toEqual(["c.md", "d.md"]);
    // a.md/b.md are not in any cluster.
    const allDocs = result.clusters.flatMap((c) => c.documents);
    expect(allDocs).not.toContain("a.md");
    expect(allDocs).not.toContain("b.md");
  });

  it("excludes accepted-resolution tensions from cluster formation", () => {
    // A↔B is accepted (stable disagreement); C↔D is unresolved. Only {C,D} clusters.
    const tensions = [
      buildEntry({
        id: "tension-001",
        sourceA: "a.md",
        sourceB: "b.md",
        kind: "interpretive",
        resolved: true,
        resolution: {
          resolved_at: "2026-05-15T00:00:00Z",
          resolved_by: "mihir",
          kind: "accepted",
        },
      }),
      buildEntry({ id: "tension-002", sourceA: "c.md", sourceB: "d.md" }),
    ];
    const result = computeTensionClusters(tensions, NOW);
    expect(result.cluster_count).toBe(1);
    const [cluster] = result.clusters;
    expect(cluster?.documents).toEqual(["c.md", "d.md"]);
    const allDocs = result.clusters.flatMap((c) => c.documents);
    expect(allDocs).not.toContain("a.md");
    expect(allDocs).not.toContain("b.md");
  });

  it("includes unspecified-kind tensions in cluster formation and tallies them under 'unspecified'", () => {
    // A legacy entry's `kind` doesn't affect scope — only resolution state does.
    const tensions = [
      buildEntry({
        id: "tension-001",
        sourceA: "a.md",
        sourceB: "b.md",
        kind: "unspecified",
      }),
    ];
    const result = computeTensionClusters(tensions, NOW);
    expect(result.cluster_count).toBe(1);
    const [cluster] = result.clusters;
    expect(cluster?.documents).toEqual(["a.md", "b.md"]);
    expect(cluster?.kinds.unspecified).toBe(1);
  });

  // --- Content-addressed ID stability (Gap 3) -----------------------------

  it("produces identical cluster IDs across runs on unchanged membership", () => {
    const tensions = [
      buildEntry({ id: "tension-001", sourceA: "a.md", sourceB: "b.md" }),
      buildEntry({ id: "tension-002", sourceA: "b.md", sourceB: "c.md" }),
    ];
    const first = computeTensionClusters(tensions, NOW);
    const second = computeTensionClusters(tensions, NOW);
    expect(first.clusters[0]?.id).toBeDefined();
    expect(first.clusters[0]?.id).toBe(second.clusters[0]?.id);
    expect(first.clusters[0]?.id).toMatch(/^cluster:[0-9a-f]{8}$/);
  });

  it("changes the cluster ID when a new tension expands the cluster's membership", () => {
    // {A,B,C} → add A↔D → {A,B,C,D}. Same logical region, different members,
    // different ID (the correct semantic per Gap 3).
    const before = computeTensionClusters(
      [
        buildEntry({ id: "tension-001", sourceA: "a.md", sourceB: "b.md" }),
        buildEntry({ id: "tension-002", sourceA: "b.md", sourceB: "c.md" }),
      ],
      NOW,
    );
    const after = computeTensionClusters(
      [
        buildEntry({ id: "tension-001", sourceA: "a.md", sourceB: "b.md" }),
        buildEntry({ id: "tension-002", sourceA: "b.md", sourceB: "c.md" }),
        buildEntry({ id: "tension-003", sourceA: "a.md", sourceB: "d.md" }),
      ],
      NOW,
    );
    expect(before.clusters[0]?.size).toBe(3);
    expect(after.clusters[0]?.size).toBe(4);
    expect(before.clusters[0]?.id).not.toBe(after.clusters[0]?.id);
  });

  it("gives a merged cluster an ID that matches neither predecessor's", () => {
    // {A,B} and {C,D} separately; then B↔C merges them.
    const before = computeTensionClusters(
      [
        buildEntry({ id: "tension-001", sourceA: "a.md", sourceB: "b.md" }),
        buildEntry({ id: "tension-002", sourceA: "c.md", sourceB: "d.md" }),
      ],
      NOW,
    );
    const after = computeTensionClusters(
      [
        buildEntry({ id: "tension-001", sourceA: "a.md", sourceB: "b.md" }),
        buildEntry({ id: "tension-002", sourceA: "c.md", sourceB: "d.md" }),
        buildEntry({ id: "tension-003", sourceA: "b.md", sourceB: "c.md" }),
      ],
      NOW,
    );
    expect(before.cluster_count).toBe(2);
    expect(after.cluster_count).toBe(1);
    const mergedId = after.clusters[0]?.id;
    const predecessorIds = before.clusters.map((c) => c.id);
    expect(mergedId).toBeDefined();
    expect(predecessorIds).not.toContain(mergedId);
  });

  it("treats a single tension as a cluster of size 2 (the minimum)", () => {
    // A tension always connects two distinct documents, so the smallest
    // possible cluster has exactly two members. A solo node is impossible.
    const result = computeTensionClusters(
      [buildEntry({ id: "tension-001", sourceA: "a.md", sourceB: "b.md" })],
      NOW,
    );
    expect(result.cluster_count).toBe(1);
    expect(result.clusters[0]?.size).toBe(2);
    expect(result.clusters[0]?.documents).toEqual(["a.md", "b.md"]);
  });

  // --- Field correctness on a hand-built fixture --------------------------

  it("reports size, documents (sorted), tension_count, kinds tally, and age fields", () => {
    const tensions = [
      buildEntry({
        id: "tension-001",
        sourceA: "z/c.md",
        sourceB: "a/b.md",
        kind: "factual",
        date: "2026-04-15", // 47 days before NOW
      }),
      buildEntry({
        id: "tension-002",
        sourceA: "a/b.md",
        sourceB: "m/m.md",
        kind: "interpretive",
        date: "2026-05-29", // 3 days before NOW
      }),
    ];
    const result = computeTensionClusters(tensions, NOW);
    expect(result.cluster_count).toBe(1);
    const [cluster] = result.clusters;
    expect(cluster?.size).toBe(3);
    // ASCII-sorted: "a/b.md" < "m/m.md" < "z/c.md".
    expect(cluster?.documents).toEqual(["a/b.md", "m/m.md", "z/c.md"]);
    expect(cluster?.tension_count).toBe(2);
    expect(cluster?.kinds.factual).toBe(1);
    expect(cluster?.kinds.interpretive).toBe(1);
    expect(cluster?.oldest_tension_age_days).toBe(47);
    expect(cluster?.newest_tension_age_days).toBe(3);
  });

  it("counts every in-scope tension across the cluster, including parallel edges through a hub doc", () => {
    // Hub.md participates in three tensions, each to a different other doc.
    const tensions = [
      buildEntry({ id: "tension-001", sourceA: "hub.md", sourceB: "a.md" }),
      buildEntry({ id: "tension-002", sourceA: "hub.md", sourceB: "b.md" }),
      buildEntry({ id: "tension-003", sourceA: "hub.md", sourceB: "c.md" }),
    ];
    const result = computeTensionClusters(tensions, NOW);
    expect(result.cluster_count).toBe(1);
    expect(result.clusters[0]?.size).toBe(4);
    expect(result.clusters[0]?.tension_count).toBe(3);
  });

  it("sorts clusters by size descending, breaking ties by id ASCII ascending", () => {
    const tensions = [
      // Cluster X: 3 members {x1, x2, x3}.
      buildEntry({ id: "tension-001", sourceA: "x1.md", sourceB: "x2.md" }),
      buildEntry({ id: "tension-002", sourceA: "x2.md", sourceB: "x3.md" }),
      // Cluster Y: 2 members {y1, y2}.
      buildEntry({ id: "tension-003", sourceA: "y1.md", sourceB: "y2.md" }),
      // Cluster Z: 2 members {z1, z2}.
      buildEntry({ id: "tension-004", sourceA: "z1.md", sourceB: "z2.md" }),
    ];
    const result = computeTensionClusters(tensions, NOW);
    expect(result.cluster_count).toBe(3);
    // Size 3 first; then the two size-2 clusters in id-ASCII order.
    expect(result.clusters[0]?.size).toBe(3);
    expect(result.clusters[1]?.size).toBe(2);
    expect(result.clusters[2]?.size).toBe(2);
    const id1 = result.clusters[1]?.id ?? "";
    const id2 = result.clusters[2]?.id ?? "";
    expect(id1 < id2).toBe(true);
  });
});

describe("loadTensionClusters (vault wrapper)", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-clusters-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("returns an empty result when no tensions are logged", async () => {
    const result = await loadTensionClusters(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cluster_count).toBe(0);
    expect(result.value.clusters).toEqual([]);
  });

  it("clusters the live tension graph end-to-end", async () => {
    await addTension(vault, {
      title: "t1",
      sourceA: "a.md",
      claimA: "A",
      sourceB: "b.md",
      claimB: "B",
      loggedBy: "agent:claude-code",
      kind: "factual",
    });
    await addTension(vault, {
      title: "t2",
      sourceA: "b.md",
      claimA: "B",
      sourceB: "c.md",
      claimB: "C",
      loggedBy: "agent:claude-code",
      kind: "interpretive",
    });
    const result = await loadTensionClusters(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cluster_count).toBe(1);
    expect(result.value.clusters[0]?.documents).toEqual(["a.md", "b.md", "c.md"]);
    expect(result.value.clusters[0]?.tension_count).toBe(2);
  });

  it("excludes accepted-resolution tensions when loading from the vault", async () => {
    // Log one tension, resolve it as accepted; expect zero clusters.
    const logged = await addTension(vault, {
      title: "stable",
      sourceA: "a.md",
      claimA: "A",
      sourceB: "b.md",
      claimB: "B",
      loggedBy: "agent:claude-code",
      kind: "interpretive",
    });
    expect(logged.ok).toBe(true);
    if (!logged.ok) return;
    await resolveTension(vault, logged.value.id as string, {
      resolved_at: "2026-05-15T00:00:00Z",
      resolved_by: "human:mihir",
      kind: "accepted",
    });
    const result = await loadTensionClusters(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cluster_count).toBe(0);
  });
});
