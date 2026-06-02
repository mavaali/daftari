// End-to-end pipeline against the sample-vault fixture with a mocked LLM.
// Exercises subgraph → generate → run → score composed together — the unit
// tests cover each stage in isolation; this locks their integration.
//
// The fixture is copied to a temp dir (keeping .daftari/tensions.md so the
// augmentation path is reachable) and reindexed, because the checked-in
// index.db is intentionally stale. The generator mock cites a real subgraph
// node so questions survive the source-in-subgraph filter and the full
// pipeline runs every time (the empty-after-filter degenerate path is covered
// by the generate unit tests).
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { generateQuestions } from "../../src/eval/generate.js";
import type { LlmClient } from "../../src/eval/llm.js";
import { runAnswerer } from "../../src/eval/run.js";
import { aggregateScore, gradeAnswer } from "../../src/eval/score.js";
import { sampleSubgraph } from "../../src/eval/subgraph.js";
import { vaultReindex } from "../../src/tools/search.js";

// Generator cites `citePath` (a real subgraph node) so the question survives
// the source-in-subgraph filter; grader always returns "yes".
function mockClient(citePath: string): LlmClient {
  return {
    complete: async () => ({
      ok: true,
      value: { text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" },
    }),
    completeJson: async (opts) => {
      if ((opts.user ?? "").includes("Subgraph docs")) {
        return {
          ok: true,
          value: {
            text: "",
            input_tokens: 0,
            output_tokens: 0,
            stop_reason: "end_turn",
            parsed: {
              questions: [
                {
                  tier: "retrieval",
                  question: "What does this document describe?",
                  expected_answer: "It describes the document's subject matter.",
                  expected_sources: [citePath],
                },
              ],
            },
          },
        };
      }
      return {
        ok: true,
        value: {
          text: "",
          input_tokens: 0,
          output_tokens: 0,
          stop_reason: "end_turn",
          parsed: { correct: "yes", reasoning: "ok" },
        },
      };
    },
    completeWithTools: async () => ({
      ok: true,
      value: {
        text: `the answer [${citePath}]`,
        input_tokens: 0,
        output_tokens: 0,
        stop_reason: "end_turn",
        tool_calls: [],
      },
    }),
  };
}

describe("eval e2e (mocked LLM)", () => {
  it("runs subgraph → generate → run → score end-to-end against the fixture", async () => {
    const vault = await mkdtemp(join(tmpdir(), "daftari-e2e-"));
    try {
      // Copy the fixture (keep .daftari/tensions.md; drop the fixture's own
      // .git so the temp dir isn't mistaken for a repo), then rebuild the index.
      await cp(resolve(__dirname, "../fixtures/sample-vault"), vault, {
        recursive: true,
        filter: (src) => !src.includes(`${sep}.git`),
      });
      const reindex = await vaultReindex(vault);
      expect(reindex.ok).toBe(true);

      const sg = await sampleSubgraph(vault, "e2e-seed", { maxNodes: 4 });
      expect(sg.ok).toBe(true);
      if (!sg.ok) return;
      expect(sg.value.nodes.length).toBeGreaterThanOrEqual(1);

      const citePath = sg.value.nodes[0].path;
      const client = mockClient(citePath);

      const qs = await generateQuestions(sg.value, client, {
        n: 3,
        model: "mock",
        vaultHash: "h",
        seed: "e2e-seed",
      });
      expect(qs.ok).toBe(true);
      if (!qs.ok) return;
      expect(qs.value.questions.length).toBeGreaterThan(0);

      const run = await runAnswerer(qs.value, vault, client, { k: 1, model: "mock" });
      expect(run.ok).toBe(true);
      if (!run.ok) return;
      expect(Object.keys(run.value.runs).length).toBe(qs.value.questions.length);

      // Grade every completed run, then aggregate.
      const grades = [];
      const traces = new Map();
      for (const pr of Object.values(run.value.runs)) {
        if (pr.status !== "complete") continue;
        const q = qs.value.questions[pr.question_index];
        if (!q) continue;
        const g = await gradeAnswer(q, pr.question_index, pr.k_index, pr.trace, client, {
          model: "mock",
        });
        if (g.ok) {
          grades.push(g.value);
          traces.set(`${q.id}:${pr.k_index}`, pr.trace);
        }
      }
      const score = aggregateScore(grades, qs.value.questions, { traces });
      // Grader returned "yes" for everything → perfect score.
      expect(score.score).toBeCloseTo(1.0);
      expect(Number.isNaN(score.score)).toBe(false);
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  }, 60_000);
});
