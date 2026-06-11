import { describe, expect, it } from "vitest";
import { generateQuestions } from "../../src/eval/generate.js";
import type { LlmClient } from "../../src/eval/llm.js";
import type { Subgraph } from "../../src/eval/subgraph.js";

const fakeSubgraph: Subgraph = {
  seed_doc: "a.md",
  nodes: [
    { path: "a.md", body: "A body with [link](b.md)", frontmatter: {} },
    { path: "b.md", body: "B body referencing a.md", frontmatter: { sources: ["a.md"] } },
  ],
  edges: [
    { from: "a.md", to: "b.md", kind: "link" },
    { from: "b.md", to: "a.md", kind: "sources" },
  ],
  code_nodes: [],
};

function mockClient(canned: unknown): LlmClient {
  return {
    complete: async () => ({
      ok: true,
      value: { text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" },
    }),
    completeJson: async () => ({
      ok: true,
      value: {
        parsed: canned,
        input_tokens: 0,
        output_tokens: 0,
        stop_reason: "end_turn",
        text: "",
      },
    }),
    completeWithTools: async () => ({
      ok: true,
      value: {
        text: "",
        input_tokens: 0,
        output_tokens: 0,
        stop_reason: "end_turn",
        tool_calls: [],
      },
    }),
  };
}

// A sequenced mock returns a different canned payload on each successive
// `completeJson` call and exposes a call counter, so a test can assert how many
// times the generator was invoked (first call + at most one top-up).
function sequencedMock(responses: unknown[]): { client: LlmClient; calls: () => number } {
  let i = 0;
  const client: LlmClient = {
    complete: async () => ({
      ok: true,
      value: { text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" },
    }),
    completeJson: async () => {
      const parsed = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return {
        ok: true,
        value: { parsed, input_tokens: 0, output_tokens: 0, stop_reason: "end_turn", text: "" },
      };
    },
    completeWithTools: async () => ({
      ok: true,
      value: {
        text: "",
        input_tokens: 0,
        output_tokens: 0,
        stop_reason: "end_turn",
        tool_calls: [],
      },
    }),
  };
  return { client, calls: () => i };
}

describe("generateQuestions", () => {
  it("filters questions whose sources are not in subgraph", async () => {
    const canned = {
      questions: [
        { tier: "retrieval", question: "q1", expected_answer: "ans1", expected_sources: ["a.md"] },
        {
          tier: "retrieval",
          question: "q2",
          expected_answer: "ans2",
          expected_sources: ["nonexistent.md"],
        },
      ],
    };
    const r = await generateQuestions(fakeSubgraph, mockClient(canned), {
      n: 6,
      model: "claude-sonnet-fake",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.questions.length).toBe(1);
      expect(r.value.questions[0].expected_sources).toEqual(["a.md"]);
    }
  });

  it("respects tier counts when LLM produces enough", async () => {
    const canned = {
      questions: [
        { tier: "retrieval", question: "r1", expected_answer: "ans", expected_sources: ["a.md"] },
        { tier: "retrieval", question: "r2", expected_answer: "ans", expected_sources: ["a.md"] },
        {
          tier: "cross_reference",
          question: "x1",
          expected_answer: "ans",
          expected_sources: ["a.md"],
        },
        {
          tier: "cross_reference",
          question: "x2",
          expected_answer: "ans",
          expected_sources: ["a.md"],
        },
        {
          tier: "contradiction",
          question: "c1",
          expected_answer: "ans",
          expected_sources: ["a.md"],
        },
        {
          tier: "contradiction",
          question: "c2",
          expected_answer: "ans",
          expected_sources: ["a.md"],
        },
      ],
    };
    const r = await generateQuestions(fakeSubgraph, mockClient(canned), {
      n: 6,
      model: "claude-sonnet-fake",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tier_counts_produced.retrieval).toBe(2);
      expect(r.value.tier_counts_produced.cross_reference).toBe(2);
      expect(r.value.tier_counts_produced.contradiction).toBe(2);
    }
  });

  it("tops up an under-produced tier with exactly one extra call", async () => {
    const first = {
      questions: [
        { tier: "retrieval", question: "r1", expected_answer: "ans", expected_sources: ["a.md"] },
        { tier: "retrieval", question: "r2", expected_answer: "ans", expected_sources: ["a.md"] },
      ],
    };
    const topUp = {
      questions: [
        {
          tier: "cross_reference",
          question: "x1",
          expected_answer: "ans",
          expected_sources: ["a.md"],
        },
        {
          tier: "cross_reference",
          question: "x2",
          expected_answer: "ans",
          expected_sources: ["a.md"],
        },
        {
          tier: "contradiction",
          question: "c1",
          expected_answer: "ans",
          expected_sources: ["a.md"],
        },
        {
          tier: "contradiction",
          question: "c2",
          expected_answer: "ans",
          expected_sources: ["a.md"],
        },
      ],
    };
    const { client, calls } = sequencedMock([first, topUp]);
    const r = await generateQuestions(fakeSubgraph, client, { n: 6, model: "claude-sonnet-fake" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tier_counts_produced.retrieval).toBe(2);
      expect(r.value.tier_counts_produced.cross_reference).toBe(2);
      // fakeSubgraph has no tension edges, so augmentation adds 0 contradictions.
      expect(r.value.tier_counts_produced.contradiction).toBe(2);
    }
    expect(calls()).toBe(2); // first generation + exactly one top-up
  });

  it("caps top-up at 1 and accepts remaining imbalance", async () => {
    const first = {
      questions: [
        { tier: "retrieval", question: "r1", expected_answer: "ans", expected_sources: ["a.md"] },
        { tier: "retrieval", question: "r2", expected_answer: "ans", expected_sources: ["a.md"] },
      ],
    };
    // Still short after the single top-up: one cross_reference, no contradiction.
    const topUp = {
      questions: [
        {
          tier: "cross_reference",
          question: "x1",
          expected_answer: "ans",
          expected_sources: ["a.md"],
        },
      ],
    };
    const { client, calls } = sequencedMock([first, topUp]);
    const r = await generateQuestions(fakeSubgraph, client, { n: 6, model: "claude-sonnet-fake" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tier_counts_produced.retrieval).toBe(2);
      expect(r.value.tier_counts_produced.cross_reference).toBe(1);
      expect(r.value.tier_counts_produced.contradiction).toBe(0);
    }
    expect(calls()).toBe(2); // capped: NOT 3
  });

  it("never lets a code node leak into expected_sources (#121 generator guard)", async () => {
    // A subgraph that reached a code file via a describes edge. Code nodes are
    // grader context only — they must never be citable as an expected source.
    const sg: Subgraph = {
      seed_doc: "a.md",
      nodes: [{ path: "a.md", body: "documents login", frontmatter: {} }],
      edges: [{ from: "a.md", to: "src/login.ts", kind: "describes" }],
      code_nodes: [{ path: "src/login.ts", body: "export function login() {}", frontmatter: {} }],
    };
    // The model (wrongly) tries to cite the code path; one valid question cites a.md.
    const canned = {
      questions: [
        {
          tier: "retrieval",
          question: "what does login take?",
          expected_answer: "a token",
          expected_sources: ["src/login.ts"],
        },
        {
          tier: "retrieval",
          question: "what does the guide document?",
          expected_answer: "the login flow",
          expected_sources: ["a.md"],
        },
      ],
    };
    const r = await generateQuestions(sg, mockClient(canned), { n: 3, model: "m" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The code-citing question is dropped; no surviving question cites the code path.
    for (const q of r.value.questions) {
      expect(q.expected_sources).not.toContain("src/login.ts");
    }
    expect(r.value.questions.some((q) => q.expected_sources.includes("a.md"))).toBe(true);
  });
});
