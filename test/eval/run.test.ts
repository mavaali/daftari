import { describe, expect, it } from "vitest";
import type { LlmClient } from "../../src/eval/llm.js";
import { runAnswerer } from "../../src/eval/run.js";
import type { EvalRun, Question, QuestionSet } from "../../src/eval/types.js";

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

  it("returns err when the answerer call fails (incomplete branch)", async () => {
    // A client whose tool loop fails exercises the !ok path: the pair is
    // recorded incomplete and the error is surfaced (run aborts).
    const failing: LlmClient = {
      ...mockClient(),
      completeWithTools: async () => ({
        ok: false,
        error: { kind: "llm", message: "answerer exploded", retryable: false },
      }),
    };
    const r = await runAnswerer(sampleQs, "/tmp/fake-vault", failing, {
      k: 2,
      model: "claude-sonnet-fake",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("llm");
  });

  it("persist is called after each completed (q,k) pair", async () => {
    const saved: EvalRun[] = [];
    const r = await runAnswerer(sampleQs, "/tmp/fake-vault", mockClient(), {
      k: 2,
      model: "claude-sonnet-fake",
      persist: async (run) => {
        // structuredClone so each snapshot is captured independently — `runs`
        // mutates in place across iterations.
        saved.push(structuredClone(run));
      },
    });
    expect(r.ok).toBe(true);
    // One persist per completed (q,k) pair: k=2, one question → 2.
    expect(saved.length).toBe(2);
    const last = saved[saved.length - 1];
    expect(last.runs["0:0"].status).toBe("complete");
    expect(last.runs["0:1"].status).toBe("complete");
  });

  it("persist captures partial progress before a failure", async () => {
    // Client succeeds on the first call, fails on the second. With k=2 the
    // first (0:0) completes and (0:1) fails — proving partial progress is
    // saved before the error, i.e. the run is resumable.
    let calls = 0;
    const flaky: LlmClient = {
      ...mockClient(),
      completeWithTools: async () => {
        calls++;
        if (calls === 1) {
          return {
            ok: true,
            value: {
              text: "X is foo [a.md]",
              input_tokens: 1,
              output_tokens: 1,
              stop_reason: "end_turn",
              tool_calls: [],
            },
          };
        }
        return {
          ok: false,
          error: { kind: "llm", message: "answerer exploded", retryable: false },
        };
      },
    };
    const saved: EvalRun[] = [];
    const r = await runAnswerer(sampleQs, "/tmp/fake-vault", flaky, {
      k: 2,
      model: "claude-sonnet-fake",
      persist: async (run) => {
        saved.push(structuredClone(run));
      },
    });
    expect(r.ok).toBe(false);
    const last = saved[saved.length - 1];
    expect(last.runs["0:0"].status).toBe("complete");
    expect(last.runs["0:1"].status).toBe("incomplete");
  });
});
