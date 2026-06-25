// answerquality-lib.mjs
// Pure, DB-free helpers for the chunk-BM25 answer-quality ablation.
// No imports from dist/ here — keep this unit-testable in isolation.

// Deterministic PRNG (mulberry32). Seeded so the whole experiment reproduces.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher–Yates with a seeded PRNG. Returns a new array; input untouched.
export function shuffleSeeded(arr, seed) {
  const out = [...arr];
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Stratified deterministic sample.
// - single stratum: relevantDays.length === 1
// - multi stratum: grouped by relevantDays.length into buckets; round-robin
//   across buckets, each bucket capped at `multiBucketCap`, until nMulti filled.
// Returns records tagged with `stratum: "single" | "multi"`. Throws if the pool
// can't satisfy the requested counts (fail loud, don't silently under-sample).
export function stratifiedSample(records, { nSingle, nMulti, multiBucketCap, seed }) {
  const single = records.filter((r) => (r.qa.relevantDays?.length ?? 0) === 1);
  const multi = records.filter((r) => (r.qa.relevantDays?.length ?? 0) > 1);

  const pickedSingle = shuffleSeeded(single, seed).slice(0, nSingle);
  if (pickedSingle.length < nSingle)
    throw new Error(`single pool too small: have ${single.length}, need ${nSingle}`);

  const buckets = new Map();
  for (const r of multi) {
    const L = r.qa.relevantDays.length;
    if (!buckets.has(L)) buckets.set(L, []);
    buckets.get(L).push(r);
  }
  const lens = [...buckets.keys()].sort((a, b) => a - b);
  const queues = new Map(lens.map((L) => [L, shuffleSeeded(buckets.get(L), seed + L)]));
  const takenPerBucket = new Map(lens.map((L) => [L, 0]));

  const pickedMulti = [];
  let progressed = true;
  while (pickedMulti.length < nMulti && progressed) {
    progressed = false;
    for (const L of lens) {
      if (pickedMulti.length >= nMulti) break;
      if (takenPerBucket.get(L) >= multiBucketCap) continue;
      const q = queues.get(L);
      const idx = takenPerBucket.get(L);
      if (idx < q.length) {
        pickedMulti.push(q[idx]);
        takenPerBucket.set(L, idx + 1);
        progressed = true;
      }
    }
  }
  if (pickedMulti.length < nMulti)
    throw new Error(
      `multi pool too small under cap=${multiBucketCap}: got ${pickedMulti.length}, need ${nMulti}`,
    );

  return [
    ...pickedSingle.map((r) => ({ ...r, stratum: "single" })),
    ...pickedMulti.map((r) => ({ ...r, stratum: "multi" })),
  ];
}
