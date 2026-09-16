// Retrieval-only ranking metrics — recall@k, MRR, nDCG@k — over a ranked
// list of document paths and a ground-truth relevant set. Pure math, no I/O.
//
// Distinct from `src/eval/score.ts`, which grades LLM-synthesized answers.
// These functions score the ranking itself (what `vault_search` returns)
// against a known-relevant-path set, independent of any generation step —
// the retrieval-only measurement gap named in
// docs/superpowers/results/2026-06-21-recall-bench-baseline.md.
//
// A query with an empty relevant set has no well-defined score; every
// per-query function returns `null` for that case rather than 0 or 1, so
// callers can exclude it from an aggregate mean without it silently
// dragging the average down (same convention as
// integrations/recall-bench/recall-runner.mjs's `recall()` helper).

// recall@k: fraction of the relevant set that appears within the top k
// ranked results.
export function recallAtK(ranked: string[], relevant: string[], k: number): number | null {
  if (relevant.length === 0) return null;
  const top = new Set(ranked.slice(0, k));
  const hit = relevant.filter((path) => top.has(path)).length;
  return hit / relevant.length;
}

// Reciprocal rank: 1 / (rank of the first relevant result), 0 if none of
// the relevant set appears anywhere in `ranked`. Mean over queries gives
// MRR.
export function reciprocalRank(ranked: string[], relevant: string[]): number | null {
  if (relevant.length === 0) return null;
  const relevantSet = new Set(relevant);
  const idx = ranked.findIndex((path) => relevantSet.has(path));
  return idx === -1 ? 0 : 1 / (idx + 1);
}

// nDCG@k with binary relevance: DCG@k = sum over ranked[0..k) of
// (1 if relevant else 0) / log2(rank + 1), normalized by the ideal DCG
// (all relevant docs, up to k, ranked first).
export function ndcgAtK(ranked: string[], relevant: string[], k: number): number | null {
  if (relevant.length === 0) return null;
  const relevantSet = new Set(relevant);
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (relevantSet.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  for (let i = 0; i < Math.min(k, relevant.length); i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? null : dcg / idcg;
}

// Mean of a per-query metric, excluding null (undefined-relevance) queries.
// Returns null if every query was excluded.
export function meanOf(values: (number | null)[]): number | null {
  const defined = values.filter((v): v is number => v !== null);
  if (defined.length === 0) return null;
  return defined.reduce((a, b) => a + b, 0) / defined.length;
}
