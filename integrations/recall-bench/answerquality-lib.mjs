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

export function composite({ correctness, completeness, hallucination }) {
  return correctness + completeness + hallucination;
}

// Percentile bootstrap over PAIRED per-question deltas (same question, both arms).
// Resample WITH replacement n times, take the mean each iter, return the
// alpha/2 and 1-alpha/2 percentiles. Seeded → reproducible.
export function pairedBootstrapCI(deltas, { iters = 2000, seed = 1, alpha = 0.05 }) {
  const n = deltas.length;
  const mean = n ? deltas.reduce((a, b) => a + b, 0) / n : 0;
  if (n === 0) return { mean: 0, lo: 0, hi: 0 };
  const rnd = mulberry32(seed);
  const means = new Array(iters);
  for (let it = 0; it < iters; it++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += deltas[Math.floor(rnd() * n)];
    means[it] = s / n;
  }
  means.sort((a, b) => a - b);
  const q = (p) => means[Math.min(iters - 1, Math.max(0, Math.floor(p * iters)))];
  return { mean, lo: q(alpha / 2), hi: q(1 - alpha / 2) };
}

export function assembleContext(rankedPaths, bestChunkByPath, docContentByPath, { fallbackChars }, opts = {}) {
  const parts = [];
  const sources = [];
  for (const path of rankedPaths) {
    let body = bestChunkByPath.get(path);
    let source = "chunk";
    if (body == null) {
      body = (docContentByPath.get(path) ?? "").slice(0, fallbackChars);
      source = "fallback";
    }
    parts.push(`[source: ${path}]\n${body}`);
    sources.push({ path, source });
  }
  const text = parts.join("\n\n---\n\n");
  if (opts.detailed) return { text, totalChars: text.length, sources };
  return text;
}

export function answererPrompt(context, question) {
  return [
    "You are answering a question using ONLY the provided context excerpts.",
    "Rules:",
    "- Use only the context below. Do not use outside knowledge.",
    "- If the context does not contain the answer, say exactly: \"The provided context does not contain the answer.\"",
    "- Be concise. Cite the [source: …] path(s) you used.",
    "",
    "CONTEXT:",
    context,
    "",
    `QUESTION: ${question}`,
    "",
    "ANSWER:",
  ].join("\n");
}

export const JUDGE_SCHEMA = {
  type: "object",
  required: ["correctness", "completeness", "hallucination", "reasoning"],
  properties: {
    correctness: { type: "integer", minimum: 0, maximum: 3 },
    completeness: { type: "integer", minimum: 0, maximum: 2 },
    hallucination: { type: "integer", minimum: 0, maximum: 1 }, // 1 = no hallucination (clean)
    reasoning: { type: "string" },
  },
};

export function judgePrompt(question, referenceAnswer, candidateAnswer) {
  return [
    "You are grading a candidate answer against a reference answer. Grade blind and strictly.",
    "Scoring axes (integers):",
    "- correctness 0–3: does the candidate state the correct fact(s) from the reference? (3=fully correct, 0=wrong/absent)",
    "- completeness 0–2: does it cover what the reference covers? (2=complete, 0=missing the point)",
    "- hallucination 0–1: 1 if the candidate adds NO unsupported/contradictory claims; 0 if it fabricates.",
    "",
    `QUESTION: ${question}`,
    `REFERENCE ANSWER: ${referenceAnswer}`,
    `CANDIDATE ANSWER: ${candidateAnswer}`,
  ].join("\n");
}
