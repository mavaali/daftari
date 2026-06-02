import { describe, expect, it } from "vitest";
import type { LlmClient } from "../../src/eval/llm.js";
import { runAnswerer } from "../../src/eval/run.js";
import type { Question, QuestionSet } from "../../src/eval/types.js";

const sampleQs: QuestionSet = {
  id: "qs-1",
  vault_hash: "h",
  seed: "s",
  timestamp: "t",
  subgraph: { seed_doc: "a.md", nodes: ["a.md"], edges: [] },
  questions: [
    {
      id: "q1",
      tier: "retrieval",
      question: "what is X?",
      expected_answer: "X is foo",
      expected_sources: ["a.md"],
      origin: "generated",
    },
  ] as Question[],
  generator_model: "g",
  prompt_version: 1,
  tier_counts_requested: { retrieval: 1, cross_reference: 0, contradiction: 0 },
  tier_counts_produced: { retrieval: 1, cross_reference: 0, contradiction: 0 },
};

function mockClient(): LlmClient {
  return {
    complete: async () => ({
      ok: true,
      value: { text: "ok", input_tokens: 1, output_tokens: 1, stop_reason: "end_turn" },
    }),
    completeJson: async () => ({
      ok: false,
      error: { kind: "llm", message: "not used", retryable: false },
    }),
    completeWithTools: async () => ({
      ok: true,
      value: {
        text: "X is foo [a.md]",
        input_tokens: 10,
        output_tokens: 5,
        stop_reason: "end_turn",
        tool_calls: [
          { tool: "vault_read", input: { path: "a.md" }, output: "body", latency_ms: 3 },
        ],
      },
    }),
  };
}

describe("runAnswerer", () => {
  it("runs each question × k times and returns keyed results", async () => {
    const r = await runAnswerer(sampleQs, "/tmp/fake-vault", mockClient(), {
      k: 2,
      model: "claude-sonnet-fake",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.k).toBe(2);
      expect(Object.keys(r.value.runs).sort()).toEqual(["0:0", "0:1"]);
      for (const key of ["0:0", "0:1"]) {
        const pr = r.value.runs[key];
        expect(pr.status).toBe("complete");
        expect(pr.trace?.tool_calls.length).toBe(1);
      }
    }
  });

  it("supports resume — does not re-run completed (q,k) pairs", async () => {
    const seeded = await runAnswerer(sampleQs, "/tmp/fake-vault", mockClient(), {
      k: 2,
      model: "claude-sonnet-fake",
    });
    if (!seeded.ok) throw new Error("seed failed");
    // Keep 0:0 complete; force 0:1 incomplete.
    const partial = {
      ...seeded.value,
      runs: {
        "0:0": seeded.value.runs["0:0"],
        "0:1": {
          question_id: "q1",
          question_index: 0,
          k_index: 1,
          status: "incomplete" as const,
          trace: null,
        },
      },
    };
    let calls = 0;
    const client: LlmClient = {
      ...mockClient(),
      completeWithTools: async () => {
        calls++;
        return {
          ok: true,
          value: {
            text: "X is foo [a.md]",
            input_tokens: 0,
            output_tokens: 0,
            stop_reason: "end_turn",
            tool_calls: [],
          },
        };
      },
    };
    const r = await runAnswerer(sampleQs, "/tmp/fake-vault", client, {
      k: 2,
      model: "claude-sonnet-fake",
      resumeFrom: partial,
    });
    expect(r.ok).toBe(true);
    expect(calls).toBe(1); // only the incomplete pair re-ran
  });
});
