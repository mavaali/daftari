import { describe, expect, it } from "vitest";
import { aggregateScore } from "../../src/eval/score.js";
import type { Grade, Question, Tier } from "../../src/eval/types.js";

function q(tier: Tier, i: number): Question {
  return {
    id: `q-${tier}-${i}`,
    tier,
    question: `q${i}`,
    expected_answer: "a",
    expected_sources: ["a.md"],
    origin: "generated",
  };
}
function g(question: Question, k: number, v: "yes" | "partial" | "no" | "ungraded"): Grade {
  return {
    question_id: question.id,
    question_index: 0,
    k_index: k,
    verdict: v,
    reasoning: "",
    grader_model: "claude-sonnet-fake",
  };
}

describe("aggregateScore", () => {
  it("all-perfect → 1.0", () => {
    const qs = [q("retrieval", 0), q("cross_reference", 0), q("contradiction", 0)];
    const grades = qs.flatMap((qq) => [g(qq, 0, "yes"), g(qq, 1, "yes")]);
    const s = aggregateScore(grades, qs, { traces: new Map() });
    expect(s.score).toBeCloseTo(1.0);
  });

  it("all-zero → 0.0", () => {
    const qs = [q("retrieval", 0), q("cross_reference", 0), q("contradiction", 0)];
    const grades = qs.flatMap((qq) => [g(qq, 0, "no"), g(qq, 1, "no")]);
    const s = aggregateScore(grades, qs, { traces: new Map() });
    expect(s.score).toBeCloseTo(0.0);
  });

  it("tier weighting: 1×1 + 2×1 + 3×1 over 6 = 1.0; halve contradiction → 5/6", () => {
    const qs = [q("retrieval", 0), q("cross_reference", 0), q("contradiction", 0)];
    const grades = [
      g(qs[0], 0, "yes"),
      g(qs[0], 1, "yes"),
      g(qs[1], 0, "yes"),
      g(qs[1], 1, "yes"),
      g(qs[2], 0, "yes"),
      g(qs[2], 1, "no"),
    ];
    const s = aggregateScore(grades, qs, { traces: new Map() });
    expect(s.score).toBeCloseTo(0.75);
  });

  it("missing tier → handled gracefully (no NaN)", () => {
    const qs = [q("retrieval", 0)];
    const grades = [g(qs[0], 0, "yes"), g(qs[0], 1, "yes")];
    const s = aggregateScore(grades, qs, { traces: new Map() });
    expect(Number.isNaN(s.score)).toBe(false);
    expect(s.by_tier.cross_reference.n).toBe(0);
  });

  it("ungraded excluded from aggregate", () => {
    const qs = [q("retrieval", 0)];
    const grades = [g(qs[0], 0, "ungraded"), g(qs[0], 1, "yes")];
    const s = aggregateScore(grades, qs, { traces: new Map() });
    expect(s.by_tier.retrieval.mean).toBeCloseTo(1.0);
    expect(s.by_tier.retrieval.n).toBe(1);
  });
});
