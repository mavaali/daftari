import { describe, expect, it } from "vitest";
import {
  clusterCoherence,
  kmeans,
  kmeansPlusPlusInit,
  l2Normalize,
  meanPoolL2,
  membershipDistributions,
  pickK,
  seededRng,
  silhouetteScore,
  strideSample,
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

describe("strideSample", () => {
  it("returns all indices when n <= cap", () => {
    expect(strideSample(3, 5)).toEqual([0, 1, 2]);
    expect(strideSample(5, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns exactly cap evenly-spaced indices when n > cap, deterministically", () => {
    const a = strideSample(1000, 10);
    const b = strideSample(1000, 10);
    expect(a).toEqual(b);
    expect(a).toHaveLength(10);
    // Strictly increasing and in range.
    for (let i = 0; i < a.length; i++) {
      const idx = a[i] as number;
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(1000);
      if (i > 0) expect(idx).toBeGreaterThan(a[i - 1] as number);
    }
  });

  it("returns empty for a zero cap or empty input", () => {
    expect(strideSample(0, 5)).toEqual([]);
    expect(strideSample(5, 0)).toEqual([]);
  });
});

describe("pickK with a silhouette sample cap", () => {
  it("stays deterministic and picks a valid k when the cap kicks in", () => {
    const data: Float32Array[] = [];
    for (let i = 0; i < 30; i++) data.push(l2Normalize(v(1, 0.01 * i)));
    for (let i = 0; i < 30; i++) data.push(l2Normalize(v(-1, 0.01 * i)));
    for (let i = 0; i < 30; i++) data.push(l2Normalize(v(0.01 * i, 1)));
    const a = pickK(data, [2, 3, 4], seededRng(21), 50, 20);
    const b = pickK(data, [2, 3, 4], seededRng(21), 50, 20);
    expect(a.k).toBe(b.k);
    expect(a.assignments).toEqual(b.assignments);
    // The clustering itself still covers every point — only the k-score
    // was sampled.
    expect(a.assignments).toHaveLength(data.length);
  });
});

describe("membershipDistributions (#58)", () => {
  // The acceptance-criteria case: a synthetic "two-region" document. Doc 0
  // has five chunks, three assigned to cluster 0 and two to cluster 1 — the
  // long synthesis note whose halves live in different embedding regions.
  it("gives a two-region doc membership in both themes with 0.6/0.4 weights", () => {
    const chunkAssignments = [0, 0, 0, 1, 1];
    const chunkDoc = [0, 0, 0, 0, 0];
    const [doc0] = membershipDistributions(chunkAssignments, chunkDoc, 1, 0.25);
    expect(doc0).toEqual([
      { cluster: 0, weight: 0.6 },
      { cluster: 1, weight: 0.4 },
    ]);
  });

  it("drops a one-chunk aside below the threshold — no phantom membership", () => {
    // Ten chunks: nine in cluster 2, one stray in cluster 5 (the aside).
    const chunkAssignments = [2, 2, 2, 2, 2, 2, 2, 2, 2, 5];
    const chunkDoc = new Array(10).fill(0);
    const [doc0] = membershipDistributions(chunkAssignments, chunkDoc, 1, 0.25);
    expect(doc0).toEqual([{ cluster: 2, weight: 0.9 }]);
  });

  it("always keeps the argmax cluster even when every weight is sub-threshold", () => {
    // Five chunks across five clusters: every weight is 0.2 < 0.25, but the
    // doc must still land somewhere. Ties break to the lower cluster index.
    const chunkAssignments = [4, 3, 2, 1, 0];
    const chunkDoc = new Array(5).fill(0);
    const [doc0] = membershipDistributions(chunkAssignments, chunkDoc, 1, 0.25);
    expect(doc0).toEqual([{ cluster: 0, weight: 0.2 }]);
  });

  it("orders memberships weight-desc with deterministic ties", () => {
    // Doc 0: clusters 1 and 3 at equal weight — lower cluster index first.
    const chunkAssignments = [3, 1, 3, 1];
    const chunkDoc = [0, 0, 0, 0];
    const [doc0] = membershipDistributions(chunkAssignments, chunkDoc, 1, 0.25);
    expect(doc0).toEqual([
      { cluster: 1, weight: 0.5 },
      { cluster: 3, weight: 0.5 },
    ]);
  });

  it("aggregates independently per doc and returns [] for a chunkless doc", () => {
    // Doc 0: all chunks in cluster 0. Doc 1: split 1/1 across clusters 0,1.
    // Doc 2: no chunks at all.
    const chunkAssignments = [0, 0, 0, 1];
    const chunkDoc = [0, 0, 1, 1];
    const result = membershipDistributions(chunkAssignments, chunkDoc, 3, 0.25);
    expect(result[0]).toEqual([{ cluster: 0, weight: 1 }]);
    expect(result[1]).toEqual([
      { cluster: 0, weight: 0.5 },
      { cluster: 1, weight: 0.5 },
    ]);
    expect(result[2]).toEqual([]);
  });
});
