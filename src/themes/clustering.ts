// Clustering primitives for vault_themes.
//
// All functions are pure. The k-means implementation is hand-rolled (no
// new dependency) and seeded by a caller-supplied RNG so the same vault
// produces the same themes across runs.
//
// Input vectors are L2-normalised by the caller, so Euclidean distance on
// the unit sphere is equivalent to cosine distance (1 - cos θ). We use
// squared Euclidean inside k-means because it is monotonic with Euclidean
// distance and avoids per-iteration sqrt work.
//
// Two distinct quality scores live here and must not be confused:
//   - silhouetteScore: the internal k-picker. Mean over all points of
//     (b - a) / max(a, b) where a is mean intra-cluster distance and b is
//     mean nearest-other-cluster distance. Higher = better separation.
//   - clusterCoherence: the per-theme number returned in the tool output.
//     Mean pairwise cosine similarity inside one cluster. Higher = tighter.

// --- Seeded RNG ------------------------------------------------------------

// Mulberry32: a 32-bit, single-state PRNG. Cheap, deterministic, sufficient
// for clustering's stochastic init. Returns numbers in [0, 1). Seed 0 still
// produces a valid (constant-free) sequence because the increment 0x6D2B79F5
// keeps the state moving.
export function seededRng(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Vector math -----------------------------------------------------------

// In-place is tempting but every caller wants a fresh array; allocating
// here avoids surprise mutations.
export function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) {
    const x = vec[i] as number;
    norm += x * x;
  }
  if (norm === 0) return new Float32Array(vec);
  const inv = 1 / Math.sqrt(norm);
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    out[i] = (vec[i] as number) * inv;
  }
  return out;
}

// Mean-pool a document's chunk vectors into one vector, then L2-normalise so
// the result lives on the unit sphere (cosine semantics).
// Returns null when there is nothing to pool or the pooled vector is zero.
export function meanPoolL2(vectors: Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0]?.length ?? 0;
  if (dim === 0) return null;
  const sum = new Float32Array(dim);
  let kept = 0;
  for (const v of vectors) {
    if (v.length !== dim) continue;
    kept += 1;
    for (let i = 0; i < dim; i++) sum[i] = (sum[i] as number) + (v[i] as number);
  }
  if (kept === 0) return null;
  for (let i = 0; i < dim; i++) sum[i] = (sum[i] as number) / kept;
  // If the mean is the zero vector, l2Normalize returns zeros — surface that
  // as null so downstream callers skip the document.
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const x = sum[i] as number;
    norm += x * x;
  }
  if (norm === 0) return null;
  return l2Normalize(sum);
}

function squaredEuclidean(a: Float32Array, b: Float32Array): number {
  let acc = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] as number) - (b[i] as number);
    acc += d * d;
  }
  return acc;
}

function cosineSimilarityNormalized(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

// Euclidean distance on the unit sphere is monotonic with cosine distance.
// We expose it as the public distance for silhouette so the score is on the
// same scale callers expect.
function euclideanDistance(a: Float32Array, b: Float32Array): number {
  return Math.sqrt(squaredEuclidean(a, b));
}

// --- k-means++ initialisation ---------------------------------------------

// Picks k initial centroid INDICES from `data` using the k-means++ rule:
// the first centroid is uniform-random; each subsequent centroid is sampled
// with probability proportional to D(x)^2, where D(x) is the squared distance
// from x to the nearest already-chosen centroid.
//
// Falls back to a uniform draw if the weighted total is zero (degenerate
// data with all duplicates) so we always return k distinct indices when
// k ≤ data.length.
export function kmeansPlusPlusInit(data: Float32Array[], k: number, rng: () => number): number[] {
  const n = data.length;
  if (k <= 0 || n === 0) return [];
  const seeds: number[] = [];
  const taken = new Set<number>();

  // First centroid: uniform-random.
  const firstIdx = Math.floor(rng() * n);
  const first = firstIdx >= n ? n - 1 : firstIdx;
  seeds.push(first);
  taken.add(first);

  // For each remaining slot, compute D(x)^2 for every point against the
  // closest already-picked centroid and sample one index weighted by D^2.
  const dSquared = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    dSquared[i] = squaredEuclidean(data[i] as Float32Array, data[first] as Float32Array);
  }

  while (seeds.length < Math.min(k, n)) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (!taken.has(i)) total += dSquared[i] as number;
    }
    let chosen = -1;
    if (total === 0) {
      // All untaken points coincide with an existing centroid (or there are
      // duplicates). Pick the first untaken index uniformly so we still
      // return k distinct seeds.
      for (let i = 0; i < n; i++) {
        if (!taken.has(i)) {
          chosen = i;
          break;
        }
      }
    } else {
      let target = rng() * total;
      for (let i = 0; i < n; i++) {
        if (taken.has(i)) continue;
        target -= dSquared[i] as number;
        if (target <= 0) {
          chosen = i;
          break;
        }
      }
      if (chosen === -1) {
        // Numeric drift across the loop; pick the last untaken candidate.
        for (let i = n - 1; i >= 0; i--) {
          if (!taken.has(i)) {
            chosen = i;
            break;
          }
        }
      }
    }
    if (chosen === -1) break;
    seeds.push(chosen);
    taken.add(chosen);

    // Update each point's D^2 to the nearest of the (now larger) centroid set.
    const chosenVec = data[chosen] as Float32Array;
    for (let i = 0; i < n; i++) {
      const d = squaredEuclidean(data[i] as Float32Array, chosenVec);
      if (d < (dSquared[i] as number)) dSquared[i] = d;
    }
  }

  return seeds;
}

// --- k-means (Lloyd's iterations) -----------------------------------------

export interface KMeansResult {
  assignments: number[]; // length == data.length, each value in [0, k')
  centroids: Float32Array[]; // length == k' (k clamped to data.length)
  iterations: number;
}

// Standard Lloyd's iterations until assignments stabilise or `maxIter` is
// reached. k is clamped to data.length: clustering 4 documents into 10
// groups is undefined; instead we just return at most data.length clusters.
export function kmeans(
  data: Float32Array[],
  k: number,
  rng: () => number,
  maxIter: number,
): KMeansResult {
  const n = data.length;
  if (n === 0) return { assignments: [], centroids: [], iterations: 0 };
  const effectiveK = Math.max(1, Math.min(k, n));
  const dim = (data[0] as Float32Array).length;

  const seedIdxs = kmeansPlusPlusInit(data, effectiveK, rng);
  let centroids: Float32Array[] = seedIdxs.map((i) => {
    const src = data[i] as Float32Array;
    const copy = new Float32Array(src.length);
    for (let j = 0; j < src.length; j++) copy[j] = src[j] as number;
    return copy;
  });

  const assignments = new Array<number>(n).fill(0);
  let iterations = 0;

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    let changed = false;
    // Assign step.
    for (let i = 0; i < n; i++) {
      const point = data[i] as Float32Array;
      let bestC = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let c = 0; c < centroids.length; c++) {
        const d = squaredEuclidean(point, centroids[c] as Float32Array);
        if (d < bestD) {
          bestD = d;
          bestC = c;
        }
      }
      if (assignments[i] !== bestC) {
        assignments[i] = bestC;
        changed = true;
      }
    }
    // Update step.
    const sums = Array.from({ length: centroids.length }, () => new Float32Array(dim));
    const counts = new Array<number>(centroids.length).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i] as number;
      counts[c] = (counts[c] as number) + 1;
      const sum = sums[c] as Float32Array;
      const point = data[i] as Float32Array;
      for (let d = 0; d < dim; d++) sum[d] = (sum[d] as number) + (point[d] as number);
    }
    const newCentroids: Float32Array[] = [];
    for (let c = 0; c < centroids.length; c++) {
      const count = counts[c] as number;
      if (count === 0) {
        // Empty cluster: keep the previous centroid in place rather than
        // re-seeding. Re-seeding mid-run would defeat determinism.
        newCentroids.push(centroids[c] as Float32Array);
        continue;
      }
      const sum = sums[c] as Float32Array;
      const next = new Float32Array(dim);
      for (let d = 0; d < dim; d++) next[d] = (sum[d] as number) / count;
      newCentroids.push(next);
    }
    centroids = newCentroids;
    if (!changed) break;
  }

  // Final assignment pass on the converged centroids so callers don't see
  // a stale assignment vector from before the last update step.
  for (let i = 0; i < n; i++) {
    const point = data[i] as Float32Array;
    let bestC = 0;
    let bestD = Number.POSITIVE_INFINITY;
    for (let c = 0; c < centroids.length; c++) {
      const d = squaredEuclidean(point, centroids[c] as Float32Array);
      if (d < bestD) {
        bestD = d;
        bestC = c;
      }
    }
    assignments[i] = bestC;
  }

  return { assignments, centroids, iterations };
}

// --- Silhouette (k-picker) ------------------------------------------------

// Mean silhouette over all points. For each point i:
//   a(i) = mean distance from i to other points in the same cluster
//   b(i) = min over other clusters C of (mean distance from i to points in C)
//   s(i) = (b - a) / max(a, b)
// Singleton clusters contribute 0. With only one cluster the score is 0
// (no contrast).
export function silhouetteScore(data: Float32Array[], assignments: number[]): number {
  const n = data.length;
  if (n === 0 || n !== assignments.length) return 0;
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const c = assignments[i] as number;
    const list = clusters.get(c);
    if (list) list.push(i);
    else clusters.set(c, [i]);
  }
  if (clusters.size < 2) return 0;

  let total = 0;
  for (let i = 0; i < n; i++) {
    const ci = assignments[i] as number;
    const own = clusters.get(ci);
    if (!own || own.length <= 1) {
      // Singleton: silhouette defined as 0.
      continue;
    }
    // a(i): mean distance to other own-cluster members.
    let aSum = 0;
    let aCount = 0;
    for (const j of own) {
      if (j === i) continue;
      aSum += euclideanDistance(data[i] as Float32Array, data[j] as Float32Array);
      aCount += 1;
    }
    const a = aSum / aCount;
    // b(i): min over other clusters of mean distance.
    let b = Number.POSITIVE_INFINITY;
    for (const [cj, members] of clusters) {
      if (cj === ci) continue;
      let s = 0;
      for (const j of members) {
        s += euclideanDistance(data[i] as Float32Array, data[j] as Float32Array);
      }
      const mean = s / members.length;
      if (mean < b) b = mean;
    }
    const denom = Math.max(a, b);
    if (denom === 0) continue;
    total += (b - a) / denom;
  }
  return total / n;
}

// --- Coherence (per-theme score) ------------------------------------------

// Mean pairwise cosine similarity inside one cluster. Vectors are assumed
// L2-normalised, so cosine reduces to a dot product. Range is [-1, 1] in
// general; for unit-sphere embeddings produced by sentence-transformers it
// tends to fall in [0, 1].
export function clusterCoherence(vectors: Float32Array[]): number {
  if (vectors.length === 0) return 0;
  if (vectors.length === 1) return 1;
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      total += cosineSimilarityNormalized(vectors[i] as Float32Array, vectors[j] as Float32Array);
      pairs += 1;
    }
  }
  if (pairs === 0) return 0;
  return total / pairs;
}

// --- k-sweep --------------------------------------------------------------

export interface PickKResult {
  k: number;
  silhouette: number;
  assignments: number[];
  centroids: Float32Array[];
}

// Deterministic stride sample of `cap` indices out of [0, n). Evenly spaced
// rather than random so the same input always yields the same sample — the
// silhouette k-picker must stay reproducible (#58 moves it from ~3.5k doc
// vectors to ~44k chunk vectors, where the O(n²) full score is ~2B pairs).
export function strideSample(n: number, cap: number): number[] {
  if (cap <= 0 || n <= 0) return [];
  if (n <= cap) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  const step = n / cap;
  for (let i = 0; i < cap; i++) out.push(Math.floor(i * step));
  return out;
}

// Runs k-means for each k in `candidates`, computes silhouette, and returns
// the run with the highest score. Candidates are clamped to data.length and
// deduped; this is what handles the "tiny vault" edge case — if the user
// requested k ∈ {10, 15, 20, 25} but only has 8 documents, we end up running
// k-means at k=8 and stop.
//
// `silhouetteCap` bounds the silhouette computation (not the clustering) to a
// stride sample of that many points; 0/undefined scores the full set. The
// k-means itself always runs on all of `data` — only the k-quality metric is
// sampled, because silhouette is O(n²) and the sweep would otherwise dominate
// the tool's latency on chunk-scale inputs (#58).
export function pickK(
  data: Float32Array[],
  candidates: number[],
  rng: () => number,
  maxIter: number,
  silhouetteCap?: number,
): PickKResult {
  const n = data.length;
  const seen = new Set<number>();
  const ks: number[] = [];
  for (const c of candidates) {
    const clamped = Math.max(1, Math.min(c, n));
    if (!seen.has(clamped)) {
      seen.add(clamped);
      ks.push(clamped);
    }
  }
  if (ks.length === 0) ks.push(Math.min(1, n));

  const sampleIdx = silhouetteCap && n > silhouetteCap ? strideSample(n, silhouetteCap) : null;

  let best: PickKResult | null = null;
  for (const k of ks) {
    const { assignments, centroids } = kmeans(data, k, rng, maxIter);
    const score = sampleIdx
      ? silhouetteScore(
          sampleIdx.map((i) => data[i] as Float32Array),
          sampleIdx.map((i) => assignments[i] as number),
        )
      : silhouetteScore(data, assignments);
    if (!best || score > best.silhouette) {
      best = { k, silhouette: score, assignments, centroids };
    }
  }
  // `best` is non-null because ks has at least one entry.
  return best as PickKResult;
}

// --- Per-doc theme distributions (#58) ------------------------------------

// One document's membership in one cluster: the fraction of the doc's
// chunks assigned there. Weights over a doc's memberships sum to 1 before
// thresholding.
export interface DocMembership {
  cluster: number;
  weight: number;
}

// Aggregates CHUNK-level cluster assignments into per-document theme
// distributions. This is the representation fix #58 asks for: a long
// synthesis doc whose halves live in two regions of the embedding space has
// its chunks split across two clusters, so it gets weight in both — where
// mean-pooling collapsed it to a single point that landed in neither.
//
// `chunkDoc[i]` maps chunk i to its document index. A cluster keeps a doc's
// membership when its weight is at least `minFraction` — the guard against
// chunk-level granularity (#58's "phantom theme" concern: a one-chunk aside
// about pricing inside a ten-chunk moonshot doc is 0.1 of the doc and is
// dropped, not reported as membership). The argmax cluster is ALWAYS kept
// (ties break to the lower cluster index), so every doc has at least one
// membership regardless of how thinly its chunks spread. Each doc's
// memberships are ordered weight-desc (ties: lower cluster index).
export function membershipDistributions(
  chunkAssignments: number[],
  chunkDoc: number[],
  docCount: number,
  minFraction: number,
): DocMembership[][] {
  const chunkTotals = new Array<number>(docCount).fill(0);
  const weights = new Map<number, Map<number, number>>(); // doc → cluster → chunks
  for (let i = 0; i < chunkAssignments.length; i++) {
    const doc = chunkDoc[i] as number;
    if (doc < 0 || doc >= docCount) continue;
    const cluster = chunkAssignments[i] as number;
    chunkTotals[doc] = (chunkTotals[doc] as number) + 1;
    let byCluster = weights.get(doc);
    if (!byCluster) {
      byCluster = new Map<number, number>();
      weights.set(doc, byCluster);
    }
    byCluster.set(cluster, (byCluster.get(cluster) ?? 0) + 1);
  }

  const out: DocMembership[][] = [];
  for (let doc = 0; doc < docCount; doc++) {
    const total = chunkTotals[doc] as number;
    const byCluster = weights.get(doc);
    if (!byCluster || total === 0) {
      out.push([]);
      continue;
    }
    let primary = -1;
    let primaryCount = -1;
    for (const [cluster, count] of byCluster) {
      if (count > primaryCount || (count === primaryCount && cluster < primary)) {
        primary = cluster;
        primaryCount = count;
      }
    }
    const memberships: DocMembership[] = [];
    for (const [cluster, count] of byCluster) {
      const weight = count / total;
      if (cluster === primary || weight >= minFraction) {
        memberships.push({ cluster, weight });
      }
    }
    memberships.sort((a, b) => b.weight - a.weight || a.cluster - b.cluster);
    out.push(memberships);
  }
  return out;
}
