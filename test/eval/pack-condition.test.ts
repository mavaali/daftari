import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CompleteOpts, LlmClient } from "../../src/eval/llm.js";
import { runPackAnswerer } from "../../src/eval/pack-condition.js";
import type { EvalRun, Question, QuestionSet } from "../../src/eval/types.js";
import { reindexVault } from "../../src/search/reindex.js";
import { vaultContext } from "../../src/tools/context.js";

const sampleQs: QuestionSet = {
  id: "qs-pack-1",
  vault_hash: "h",
  seed: "s",
  timestamp: "t",
  subgraph: { seed_doc: "a.md", nodes: ["a.md"], edges: [] },
  questions: [
    {
      id: "q1",
      tier: "retrieval",
      question: "widget launch plan",
      expected_answer: "the widget launches in Q1",
      expected_sources: ["notes/a.md"],
      origin: "generated",
    },
  ] as Question[],
  generator_model: "g",
  prompt_version: 1,
  tier_counts_requested: { retrieval: 1, cross_reference: 0, contradiction: 0 },
  tier_counts_produced: { retrieval: 1, cross_reference: 0, contradiction: 0 },
};

function mockLlm(onComplete?: (opts: CompleteOpts) => void): LlmClient {
  return {
    complete: async (opts) => {
      onComplete?.(opts);
      return {
        ok: true,
        value: {
          text: "the widget launches in Q1 [notes/a.md]",
          input_tokens: 7,
          output_tokens: 3,
          stop_reason: "end_turn",
        },
      };
    },
    completeJson: async () => ({
      ok: false,
      error: { kind: "llm", message: "not used", retryable: false },
    }),
    completeWithTools: async () => ({
      ok: false,
      error: { kind: "llm", message: "the pack condition must never call this", retryable: false },
    }),
  };
}

describe("runPackAnswerer", () => {
  let vault: string;

  beforeAll(async () => {
    vault = mkdtempSync(join(tmpdir(), "daftari-pack-condition-"));
    mkdirSync(join(vault, "notes"), { recursive: true });
    writeFileSync(
      join(vault, "notes", "a.md"),
      "---\ntitle: A\ncollection: notes\ndomain: product\nstatus: canonical\n" +
        "confidence: high\ncreated: 2026-01-01\nupdated: 2026-01-01\ntags: []\n---\n\n" +
        "widget launch plan ".repeat(20),
    );
    const reindexed = await reindexVault(vault);
    if (!reindexed.ok) throw reindexed.error;
  }, 60_000);

  afterAll(() => {});

  it("produces a zero-tool-call Trace carrying pack metadata", async () => {
    const r = await runPackAnswerer(sampleQs, vault, mockLlm(), {
      k: 1,
      model: "fake",
      budget: 4000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.condition).toBe("pack");
    expect(r.value.pack_budget).toBe(4000);
    const pr = r.value.runs["0:0"];
    expect(pr.status).toBe("complete");
    if (pr.status !== "complete") return;
    expect(pr.trace.tool_calls).toEqual([]);
    expect(pr.trace.total_tool_calls).toBe(0);
    expect(pr.trace.pack).toBeTruthy();
    expect(typeof pr.trace.pack?.estimated_tokens).toBe("number");
    expect(Array.isArray(pr.trace.pack?.included_paths)).toBe(true);
  });

  it("the brief handed to the LLM is byte-identical to vaultContext's own return", async () => {
    let seenUser = "";
    const r = await runPackAnswerer(
      sampleQs,
      vault,
      mockLlm((opts) => {
        seenUser = opts.user;
      }),
      { k: 1, model: "fake", budget: 4000 },
    );
    expect(r.ok).toBe(true);
    const direct = await vaultContext(
      vault,
      { task: sampleQs.questions[0].question, budget: 4000 },
      undefined,
    );
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(seenUser).toBe(direct.value.brief);
  });

  it("resume skips already-complete (q,k) pairs", async () => {
    const seeded = await runPackAnswerer(sampleQs, vault, mockLlm(), {
      k: 2,
      model: "fake",
      budget: 4000,
    });
    if (!seeded.ok) throw new Error("seed failed");
    const partial: EvalRun = {
      ...seeded.value,
      runs: {
        "0:0": seeded.value.runs["0:0"],
        "0:1": {
          question_id: "q1",
          question_index: 0,
          k_index: 1,
          status: "incomplete",
          trace: null,
        },
      },
    };
    let calls = 0;
    const r = await runPackAnswerer(
      sampleQs,
      vault,
      mockLlm(() => {
        calls++;
      }),
      { k: 2, model: "fake", budget: 4000, resumeFrom: partial },
    );
    expect(r.ok).toBe(true);
    expect(calls).toBe(1); // only the incomplete pair re-ran
  });
});
