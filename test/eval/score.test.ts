import { describe, expect, it } from "vitest";
import type { LlmClient } from "../../src/eval/llm.js";
import { aggregateScore, gradeAnswer } from "../../src/eval/score.js";
import type { Grade, Question, Tier, Trace } from "../../src/eval/types.js";

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
function tr(totalToolCalls: number): Trace {
  return {
    tool_calls: [],
    final_answer: "",
    total_tool_calls: totalToolCalls,
    input_tokens: 0,
    output_tokens: 0,
    wall_ms: 0,
    stop_reason: "end_turn",
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

  it("tier std is the population stddev of per-question means", () => {
    // Two retrieval questions: one all-correct (mean 1.0), one all-wrong
    // (mean 0.0). Per-question means [1.0, 0.0] → tier mean 0.5, population
    // std = sqrt(((1-0.5)² + (0-0.5)²)/2) = 0.5.
    const qs = [q("retrieval", 0), q("retrieval", 1)];
    const grades = [g(qs[0], 0, "yes"), g(qs[0], 1, "yes"), g(qs[1], 0, "no"), g(qs[1], 1, "no")];
    const s = aggregateScore(grades, qs, { traces: new Map() });
    expect(s.by_tier.retrieval.mean).toBeCloseTo(0.5);
    expect(s.by_tier.retrieval.std).toBeCloseTo(0.5);
    expect(s.by_tier.retrieval.n).toBe(2);
  });

  it("trace_efficiency averages tool calls over correct/partial runs only", () => {
    // One question, three runs: yes(4 calls), partial(2 calls), no(100 calls).
    // Only value>0 runs (yes, partial) count → efficiency = (4+2)/2 = 3.
    const qs = [q("retrieval", 0)];
    const grades = [g(qs[0], 0, "yes"), g(qs[0], 1, "partial"), g(qs[0], 2, "no")];
    const traces = new Map<string, Trace>([
      [`${qs[0].id}:0`, tr(4)],
      [`${qs[0].id}:1`, tr(2)],
      [`${qs[0].id}:2`, tr(100)], // a 'no' run — must be excluded from efficiency
    ]);
    const s = aggregateScore(grades, qs, { traces });
    expect(s.by_tier.retrieval.trace_efficiency).toBeCloseTo(3);
  });
});

function graderClient(verdict: "yes" | "partial" | "no"): LlmClient {
  return {
    complete: async () => ({
      ok: true,
      value: { text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" },
    }),
    completeJson: async () => ({
      ok: true,
      value: {
        parsed: { correct: verdict, reasoning: "test" },
        text: "",
        input_tokens: 0,
        output_tokens: 0,
        stop_reason: "end_turn",
      },
    }),
    completeWithTools: async () => ({
      ok: false,
      error: { kind: "llm", message: "n/a", retryable: false },
    }),
  };
}

describe("gradeAnswer", () => {
  it("maps yes/partial/no LLM verdict to Grade", async () => {
    const q = {
      id: "q1",
      tier: "retrieval" as const,
      question: "?",
      expected_answer: "a",
      expected_sources: ["a.md"],
      origin: "generated" as const,
    };
    const trace = {
      tool_calls: [],
      final_answer: "x",
      total_tool_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      wall_ms: 0,
      stop_reason: "end_turn",
    };
    const r = await gradeAnswer(q, 0, 0, trace, graderClient("partial"), {
      model: "claude-sonnet-fake",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.verdict).toBe("partial");
  });

  it("marks question ungraded if grader returns malformed JSON", async () => {
    const q = {
      id: "q1",
      tier: "retrieval" as const,
      question: "?",
      expected_answer: "a",
      expected_sources: ["a.md"],
      origin: "generated" as const,
    };
    const trace = {
      tool_calls: [],
      final_answer: "x",
      total_tool_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      wall_ms: 0,
      stop_reason: "end_turn",
    };
    const badClient: LlmClient = {
      complete: async () => ({
        ok: true,
        value: { text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" },
      }),
      completeJson: async () => ({
        ok: true,
        value: {
          parsed: { not_what_we_want: true },
          text: "",
          input_tokens: 0,
          output_tokens: 0,
          stop_reason: "end_turn",
        },
      }),
      completeWithTools: async () => ({
        ok: false,
        error: { kind: "llm", message: "n/a", retryable: false },
      }),
    };
    const r = await gradeAnswer(q, 0, 0, trace, badClient, { model: "claude-sonnet-fake" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.verdict).toBe("ungraded");
  });

  it("extracts [path.md] citations from the answer into the grader prompt", async () => {
    const q = {
      id: "q1",
      tier: "retrieval" as const,
      question: "?",
      expected_answer: "a",
      expected_sources: ["a.md"],
      origin: "generated" as const,
    };
    const trace = {
      tool_calls: [],
      final_answer: "X is foo [a.md] and also [b.md]",
      total_tool_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      wall_ms: 0,
      stop_reason: "end_turn",
    };
    let capturedUser = "";
    const capturing: LlmClient = {
      complete: async () => ({
        ok: true,
        value: { text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" },
      }),
      completeJson: async (opts) => {
        capturedUser = opts.user;
        return {
          ok: true,
          value: {
            parsed: { correct: "yes", reasoning: "" },
            text: "",
            input_tokens: 0,
            output_tokens: 0,
            stop_reason: "end_turn",
          },
        };
      },
      completeWithTools: async () => ({
        ok: false,
        error: { kind: "llm", message: "n/a", retryable: false },
      }),
    };
    const r = await gradeAnswer(q, 0, 0, trace, capturing, { model: "claude-sonnet-fake" });
    expect(r.ok).toBe(true);
    // extractCitations pulled both [a.md] and [b.md] and they were joined into
    // the {{CITED_SOURCES}} slot of the grader prompt.
    expect(capturedUser).toContain("a.md, b.md");
  });
});
