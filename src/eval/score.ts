// src/eval/score.ts
// Aggregation of per-(question, k) grades into the headline tier-weighted
// score. Pure math. The LLM grader is added in Task 10; this v1 only
// computes scores from already-graded inputs.

import {
  type Grade,
  type Question,
  type Score,
  TIER_WEIGHT,
  TIERS,
  type Tier,
  type TierScore,
  type Trace,
} from "./types.js";

export interface AggregateOptions {
  // Per-(question_id, k_index) trace lookup for efficiency metrics.
  traces: Map<string, Trace>;
}

// Maps verdict to numeric value; null means excluded from aggregate.
const VERDICT_VALUE: Record<Grade["verdict"], number | null> = {
  yes: 1.0,
  partial: 0.5,
  no: 0.0,
  ungraded: null,
};

export function aggregateScore(
  grades: Grade[],
  questions: Question[],
  opts: AggregateOptions,
): Score {
  const byTier: Record<Tier, TierScore> = blankByTier();

  // Group grades by question_id without non-null assertions.
  const byQuestion = new Map<string, Grade[]>();
  for (const grade of grades) {
    pushTo(byQuestion, grade.question_id, grade);
  }

  for (const tier of TIERS) {
    const tierQuestions = questions.filter((q) => q.tier === tier);
    const perQuestionMeans: number[] = [];
    const efficiencyHits: number[] = [];

    for (const q of tierQuestions) {
      // Only include grades with a numeric verdict value (excludes ungraded).
      const qGrades = (byQuestion.get(q.id) ?? []).filter((grade) => {
        const val = VERDICT_VALUE[grade.verdict];
        return val !== null;
      });
      if (qGrades.length === 0) continue;

      const values = qGrades.map((grade) => {
        // Safe: we already filtered nulls above.
        const val = VERDICT_VALUE[grade.verdict];
        return val !== null ? val : 0;
      });
      const mean = avg(values);
      perQuestionMeans.push(mean);

      for (const grade of qGrades) {
        const val = VERDICT_VALUE[grade.verdict];
        if (val !== null && val > 0) {
          const t = opts.traces.get(`${grade.question_id}:${grade.k_index}`);
          if (t) efficiencyHits.push(t.total_tool_calls);
        }
      }
    }

    byTier[tier] = {
      mean: perQuestionMeans.length > 0 ? avg(perQuestionMeans) : 0,
      std: perQuestionMeans.length > 0 ? stddev(perQuestionMeans) : 0,
      n: perQuestionMeans.length,
      trace_efficiency: efficiencyHits.length > 0 ? avg(efficiencyHits) : 0,
    };
  }

  // Weighted aggregate: sum(weight * tier_mean * tier_n) / sum(weight * tier_n)
  let num = 0;
  let denom = 0;
  for (const tier of TIERS) {
    const w = TIER_WEIGHT[tier];
    const ts = byTier[tier];
    num += w * ts.mean * ts.n;
    denom += w * ts.n;
  }
  const score = denom > 0 ? num / denom : 0;

  const scoreStd =
    denom > 0
      ? Math.sqrt(
          TIERS.reduce((acc, t) => {
            const w = TIER_WEIGHT[t];
            const ts = byTier[t];
            return acc + ((w * ts.n) / denom) * ts.std ** 2;
          }, 0),
        )
      : 0;

  return {
    score,
    score_std: scoreStd,
    by_tier: byTier,
    models: { generator: "", answerer: "", grader: "" },
    prompt_version: 0,
    spec_version: 0,
    questions_id: "",
    results_id: "",
    vault_hash: "",
    k: 0,
    n: 0,
    timestamp: "",
  };
}

function blankByTier(): Record<Tier, TierScore> {
  return {
    retrieval: { mean: 0, std: 0, n: 0, trace_efficiency: 0 },
    cross_reference: { mean: 0, std: 0, n: 0, trace_efficiency: 0 },
    contradiction: { mean: 0, std: 0, n: 0, trace_efficiency: 0 },
  };
}

// Appends `value` to the array at `key`, creating the array on first use.
// Mirrors the pushTo pattern from subgraph.ts to avoid non-null assertions.
function pushTo<V>(m: Map<string, V[]>, key: string, value: V): void {
  const arr = m.get(key);
  if (arr) {
    arr.push(value);
  } else {
    m.set(key, [value]);
  }
}

function avg(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = avg(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length);
}
