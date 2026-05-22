import { describe, expect, it } from "vitest";
import {
  clusterCoherence,
  kmeans,
  kmeansPlusPlusInit,
  l2Normalize,
  meanPoolL2,
  pickK,
  seededRng,
  selectSecondaryMemberships,
  silhouetteScore,
} from "../../src/themes/clustering.js";

// Helper: build a Float32Array from a number[]
function v(...nums: number[]): Float32Array {
  return new Float32Array(nums);
}

describe("seededRng", () => {
  it("returns the same sequence for the same seed", () => {
    const a = seededRng(42);
    const b = seededRng(42);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it("returns different sequences for different seeds", () => {
    const a = seededRng(1);
    const b = seededRng(2);
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("yields values in [0, 1)", () => {
    const r = seededRng(99);
    for (let i = 0; i < 100; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("meanPoolL2", () => {
  it("returns the mean of N chunk vectors, then L2-normalised", () => {
    const a = v(1, 0, 0);
    const b = v(0, 1, 0);
    const pooled = meanPoolL2([a, b]);
    expect(pooled).not.toBeNull();
    if (!pooled) return;
    // Raw mean is (0.5, 0.5, 0). After L2 normalisation, norm == 1.
    const norm = Math.hypot(pooled[0] ?? 0, pooled[1] ?? 0, pooled[2] ?? 0);
    expect(norm).toBeCloseTo(1, 6);
    // The two non-zero components are equal.
    expect(pooled[0]).toBeCloseTo(pooled[1] ?? 0, 6);
    expect(pooled[2]).toBeCloseTo(0, 6);
  });

  it("returns the L2-normalised vector unchanged when N == 1", () => {
    const pooled = meanPoolL2([v(3, 4, 0)]);
    expect(pooled).not.toBeNull();
    if (!pooled) return;
    expect(pooled[0]).toBeCloseTo(0.6, 6);
    expect(pooled[1]).toBeCloseTo(0.8, 6);
    const norm = Math.hypot(pooled[0] ?? 0, pooled[1] ?? 0, pooled[2] ?? 0);
    expect(norm).toBeCloseTo(1, 6);
  });

  it("returns null for an empty input", () => {
    expect(meanPoolL2([])).toBeNull();
  });

  it("returns null when all input vectors are zero", () => {
    expect(meanPoolL2([v(0, 0, 0), v(0, 0, 0)])).toBeNull();
  });
});

describe("l2Normalize", () => {
  it("scales a non-zero vector to unit length", () => {
    const out = l2Normalize(v(3, 4));
    expect(out[0]).toBeCloseTo(0.6, 6);
    expect(out[1]).toBeCloseTo(0.8, 6);
  });

  it("returns the zero vector unchanged", () => {
    const out = l2Normalize(v(0, 0, 0));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(0);
  });
});

describe("kmeansPlusPlusInit", () => {
  it("returns k distinct seed indices", () => {
    const data = [v(1, 0), v(0, 1), v(-1, 0), v(0, -1), v(2, 2), v(-2, -2)];
    const seeds = kmeansPlusPlusInit(data, 3, seededRng(1));
    expect(seeds.length).toBe(3);
    expect(new Set(seeds).size).toBe(3);
  });

  it("is deterministic for the same seed", () => {
    const data = [v(1, 0), v(0, 1), v(-1, 0), v(0, -1), v(2, 2), v(-2, -2)];
    const a = kmeansPlusPlusInit(data, 3, seededRng(7));
    const b = kmeansPlusPlusInit(data, 3, seededRng(7));
    expect(a).toEqual(b);
  });
});

describe("kmeans", () => {
  // Three well-separated clusters in 2D, L2-normalised so the test stays in
  // the same cosine regime as the production code.
  function threeClusters(): Float32Array[] {
    const points: Float32Array[] = [];
    // Cluster A: around (1, 0)
    points.push(l2Normalize(v(1, 0.01)));
    points.push(l2Normalize(v(1, -0.02)));
    points.push(l2Normalize(v(0.99, 0.05)));
    points.push(l2Normalize(v(1.01, -0.03)));
    // Cluster B: around (-1, 0)
    points.push(l2Normalize(v(-1, 0.02)));
    points.push(l2Normalize(v(-0.98, -0.03)));
    points.push(l2Normalize(v(-1.02, 0.04)));
    points.push(l2Normalize(v(-1, -0.01)));
    // Cluster C: around (0, 1)
    points.push(l2Normalize(v(0.02, 1)));
    points.push(l2Normalize(v(-0.03, 0.99)));
    points.push(l2Normalize(v(0.01, 1.02)));
    points.push(l2Normalize(v(-0.04, 1.01)));
    return points;
  }

  it("assigns every point to a cluster in [0, k)", () => {
    const data = threeClusters();
    const { assignments } = kmeans(data, 3, seededRng(11), 50);
    expect(assignments.length).toBe(data.length);
    for (const a of assignments) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(3);
    }
  });

  it("recovers three clear clusters", () => {
    const data = threeClusters();
    const { assignments } = kmeans(data, 3, seededRng(11), 50);
    // Points 0..3 share a label, 4..7 share a label, 8..11 share a label.
    expect(new Set(assignments.slice(0, 4)).size).toBe(1);
    expect(new Set(assignments.slice(4, 8)).size).toBe(1);
    expect(new Set(assignments.slice(8, 12)).size).toBe(1);
    expect(new Set(assignments).size).toBe(3);
  });

  it("is deterministic for the same seed", () => {
    const data = threeClusters();
    const a = kmeans(data, 3, seededRng(13), 50);
    const b = kmeans(data, 3, seededRng(13), 50);
    expect(a.assignments).toEqual(b.assignments);
    // Centroids identical too.
    expect(a.centroids.length).toBe(b.centroids.length);
    for (let i = 0; i < a.centroids.length; i++) {
      const ca = a.centroids[i];
      const cb = b.centroids[i];
      expect(ca).toBeDefined();
      expect(cb).toBeDefined();
      if (!ca || !cb) continue;
      for (let j = 0; j < ca.length; j++) {
        expect(ca[j]).toBeCloseTo(cb[j] ?? 0, 6);
      }
    }
  });

  it("clamps k to data.length when k > data.length", () => {
    const data = [l2Normalize(v(1, 0)), l2Normalize(v(0, 1))];
    const result = kmeans(data, 5, seededRng(1), 50);
    // No more than 2 distinct clusters can exist.
    expect(new Set(result.assignments).size).toBeLessThanOrEqual(2);
    expect(result.centroids.length).toBeLessThanOrEqual(2);
  });
});

describe("silhouetteScore", () => {
  it("scores well-separated clusters higher than mixed ones", () => {
    const sep = [
      l2Normalize(v(1, 0.01)),
      l2Normalize(v(1, -0.02)),
      l2Normalize(v(-1, 0.01)),
      l2Normalize(v(-1, -0.02)),
    ];
    const sepAssign = [0, 0, 1, 1];

    const mixed = [
      l2Normalize(v(1, 0)),
      l2Normalize(v(-1, 0)),
      l2Normalize(v(1, 0.01)),
      l2Normalize(v(-1, 0.01)),
    ];
    const mixedAssign = [0, 0, 1, 1];

    const sepScore = silhouetteScore(sep, sepAssign);
    const mixedScore = silhouetteScore(mixed, mixedAssign);
    expect(sepScore).toBeGreaterThan(mixedScore);
  });

  it("returns 0 when only one cluster exists", () => {
    const data = [l2Normalize(v(1, 0)), l2Normalize(v(0, 1))];
    const score = silhouetteScore(data, [0, 0]);
    expect(score).toBe(0);
  });
});

describe("clusterCoherence", () => {
  it("scores near-identical vectors near 1.0", () => {
    const vectors = [l2Normalize(v(1, 0.001)), l2Normalize(v(1, -0.001)), l2Normalize(v(1, 0.002))];
    const coherence = clusterCoherence(vectors);
    expect(coherence).toBeGreaterThan(0.99);
  });

  it("scores scattered vectors much lower", () => {
    const vectors = [l2Normalize(v(1, 0)), l2Normalize(v(0, 1)), l2Normalize(v(-1, 0))];
    const coherence = clusterCoherence(vectors);
    // Mean pairwise cosine of orthogonal/opposite vectors is well below 0.5.
    expect(coherence).toBeLessThan(0.5);
  });

  it("returns 1.0 for a single-vector cluster (no pairs to compare)", () => {
    const vectors = [l2Normalize(v(1, 0))];
    expect(clusterCoherence(vectors)).toBe(1);
  });

  it("returns 0 for an empty cluster", () => {
    expect(clusterCoherence([])).toBe(0);
  });
});

describe("pickK", () => {
  it("selects a k from the candidate range and reports its silhouette", () => {
    // Three clean clusters in 2D.
    const data: Float32Array[] = [];
    for (let i = 0; i < 4; i++) data.push(l2Normalize(v(1, 0.01 * i)));
    for (let i = 0; i < 4; i++) data.push(l2Normalize(v(-1, 0.01 * i)));
    for (let i = 0; i < 4; i++) data.push(l2Normalize(v(0.01 * i, 1)));

    const result = pickK(data, [2, 3, 4], seededRng(17), 50);
    expect([2, 3, 4]).toContain(result.k);
    expect(result.silhouette).toBeGreaterThanOrEqual(0);
    // 3 is the natural answer here.
    expect(result.k).toBe(3);
  });

  it("clamps candidate k to data.length", () => {
    const data = [l2Normalize(v(1, 0)), l2Normalize(v(-1, 0))];
    const result = pickK(data, [5, 8], seededRng(1), 50);
    expect(result.k).toBeLessThanOrEqual(data.length);
  });

  it("is deterministic for the same seed", () => {
    const data: Float32Array[] = [];
    for (let i = 0; i < 4; i++) data.push(l2Normalize(v(1, 0.01 * i)));
    for (let i = 0; i < 4; i++) data.push(l2Normalize(v(-1, 0.01 * i)));
    for (let i = 0; i < 4; i++) data.push(l2Normalize(v(0.01 * i, 1)));
    const a = pickK(data, [2, 3, 4], seededRng(21), 50);
    const b = pickK(data, [2, 3, 4], seededRng(21), 50);
    expect(a.k).toBe(b.k);
    expect(a.assignments).toEqual(b.assignments);
  });
});

describe("selectSecondaryMemberships", () => {
  // Two centroids, well-separated. Three docs:
  //   doc 0: clearly belongs to centroid 0 (sim 0 ≈ 1, sim 1 ≈ 0).
  //   doc 1: clearly belongs to centroid 1.
  //   doc 2: a "cross-cutting" doc midway between the two — its sim to
  //          centroid 0 (its primary) is close to its sim to centroid 1.
  function twoClusterFixture(): {
    vectors: Float32Array[];
    centroids: Float32Array[];
    assignments: number[];
  } {
    const c0 = l2Normalize(v(1, 0));
    const c1 = l2Normalize(v(-1, 0));
    return {
      vectors: [
        l2Normalize(v(1, 0.01)), // doc 0: dead-on c0
        l2Normalize(v(-1, 0.01)), // doc 1: dead-on c1
        l2Normalize(v(0.5, 0.866)), // doc 2: 60deg from c0, 120deg from c1
      ],
      centroids: [c0, c1],
      assignments: [0, 1, 0],
    };
  }

  it("flags a cross-cutting doc as a secondary member of the other cluster", () => {
    // Build a fixture where doc 2's similarity to its primary and to the
    // other cluster are both meaningful (above the minimum) AND within
    // delta of each other. Pick coordinates explicitly so the math is
    // transparent.
    const c0 = l2Normalize(v(1, 0));
    const c1 = l2Normalize(v(0, 1));
    const doc0 = l2Normalize(v(1, 0.05)); // ~1 with c0, ~0.05 with c1
    const doc1 = l2Normalize(v(0.05, 1)); // ~0.05 with c0, ~1 with c1
    const doc2 = l2Normalize(v(0.8, 0.7)); // ~0.75 with c0, ~0.65 with c1 (cross-cutting)
    const result = selectSecondaryMemberships([doc0, doc1, doc2], [0, 1, 0], [c0, c1], {
      delta: 0.2,
      minSimilarity: 0.4,
      maxPerDoc: 2,
    });
    // Doc 2 (primary 0) should appear as a secondary of cluster 1.
    const secondsOfCluster1 = result.get(1) ?? [];
    expect(secondsOfCluster1.map((s) => s.docIndex)).toContain(2);
  });

  it("does not flag a strongly-aligned doc as a secondary anywhere", () => {
    const fx = twoClusterFixture();
    const result = selectSecondaryMemberships(fx.vectors, fx.assignments, fx.centroids, {
      delta: 0.05,
      minSimilarity: 0.5,
      maxPerDoc: 2,
    });
    // Doc 0 is essentially identical to its primary centroid and orthogonal
    // to the other — should never be a secondary.
    for (const [, list] of result) {
      expect(list.map((s) => s.docIndex)).not.toContain(0);
    }
  });

  it("does not list a doc as a secondary of its own primary cluster", () => {
    const fx = twoClusterFixture();
    const result = selectSecondaryMemberships(fx.vectors, fx.assignments, fx.centroids, {
      delta: 0.5,
      minSimilarity: 0,
      maxPerDoc: 5,
    });
    // Each entry in cluster C's secondaries must have its primary != C.
    for (const [cluster, list] of result) {
      for (const item of list) {
        expect(fx.assignments[item.docIndex]).not.toBe(cluster);
      }
    }
  });

  it("respects the maxPerDoc cap", () => {
    // Build 4 centroids and one doc roughly equidistant from all of them.
    // Without a cap, the doc would join 3 secondaries; with cap=1, only one.
    const c0 = l2Normalize(v(1, 0, 0, 0));
    const c1 = l2Normalize(v(0, 1, 0, 0));
    const c2 = l2Normalize(v(0, 0, 1, 0));
    const c3 = l2Normalize(v(0, 0, 0, 1));
    const doc = l2Normalize(v(0.5, 0.5, 0.5, 0.5));
    const result = selectSecondaryMemberships(
      [doc],
      [0], // primary = c0
      [c0, c1, c2, c3],
      { delta: 0.5, minSimilarity: 0, maxPerDoc: 1 },
    );
    let total = 0;
    for (const [, list] of result) {
      for (const item of list) if (item.docIndex === 0) total += 1;
    }
    expect(total).toBe(1);
  });

  it("orders each cluster's secondaries by similarity desc", () => {
    // Cluster 1 receives two secondaries with distinct similarities; the
    // returned list must be sorted desc by sim.
    const c0 = l2Normalize(v(1, 0));
    const c1 = l2Normalize(v(0, 1));
    const docA = l2Normalize(v(0.9, 0.4)); // primary 0; sim to c1 ≈ 0.4
    const docB = l2Normalize(v(0.7, 0.7)); // primary 0; sim to c1 ≈ 0.7
    const docC = l2Normalize(v(0.1, 1)); // primary 1
    const result = selectSecondaryMemberships([docA, docB, docC], [0, 0, 1], [c0, c1], {
      delta: 1,
      minSimilarity: 0,
      maxPerDoc: 5,
    });
    const seconds = result.get(1) ?? [];
    expect(seconds.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < seconds.length; i++) {
      const a = seconds[i - 1];
      const b = seconds[i];
      if (!a || !b) continue;
      expect(a.sim).toBeGreaterThanOrEqual(b.sim);
    }
  });
});
