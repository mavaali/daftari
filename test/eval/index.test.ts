// CLI-boundary behavior of `daftari eval` (#102): exit-code semantics for
// bad --resume ids, --max-nodes validation, and IO write failures surfacing
// as runtime (3) rather than config (2).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The generate path constructs a real client at the module boundary; canned
// completions keep these tests offline. Tests that exit before the client is
// used (resume/flag validation) share the same mock harmlessly.
vi.mock("../../src/eval/llm.js", () => ({
  createAnthropicClient: () => ({
    complete: async () => ({
      ok: true,
      value: { text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" },
    }),
    completeJson: async () => ({
      ok: true,
      value: {
        parsed: { questions: [] },
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
  }),
}));

// The write-failure test needs generation to SUCCEED before the artifact
// write throws; a canned subgraph keeps it independent of vault indexing.
vi.mock("../../src/eval/subgraph.js", () => ({
  sampleSubgraph: async () => ({
    ok: true,
    value: {
      seed_doc: "a.md",
      nodes: [{ path: "a.md", body: "A body", frontmatter: {} }],
      edges: [],
      code_nodes: [],
    },
  }),
}));

import { runEval } from "../../src/eval/index.js";
import { writeQuestionSet } from "../../src/eval/storage.js";
import type { QuestionSet } from "../../src/eval/types.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

function minimalQuestionSet(id: string): QuestionSet {
  return {
    id,
    vault_hash: "abc",
    seed: "s",
    timestamp: "2026-01-01T00:00:00Z",
    subgraph: { seed_doc: "a.md", nodes: ["a.md"], edges: [] },
    questions: [],
    generator_model: "m",
    prompt_version: "test",
    tier_counts_requested: { retrieval: 0, cross_reference: 0, contradiction: 0 },
    tier_counts_produced: { retrieval: 0, cross_reference: 0, contradiction: 0 },
  };
}

describe("daftari eval CLI (#102)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let outSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    errSpy.mockRestore();
    outSpy.mockRestore();
  });

  function stderrText(): string {
    return errSpy.mock.calls.map((c) => String(c[0])).join("");
  }

  it("errors (exit 2) on a --resume id that does not exist instead of starting fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daftari-eval-"));
    try {
      const qs = minimalQuestionSet("qs-1");
      await writeQuestionSet(dir, qs);
      const code = await runEval([
        "run",
        "--vault",
        dir,
        "--questions",
        "qs-1",
        "--resume",
        "no-such-results-id",
      ]);
      expect(code).toBe(2);
      expect(stderrText()).toContain("--resume no-such-results-id");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-positive --max-nodes with a config error", async () => {
    const code = await runEval(["generate", "--vault", ".", "--max-nodes", "0"]);
    expect(code).toBe(2);
    expect(stderrText()).toContain("--max-nodes must be a positive integer");
  });

  it("surfaces an artifact write failure as runtime exit 3, not config 2", async () => {
    const vault = makeTempVault();
    try {
      // Block the eval artifact tree: a FILE where the directory must go
      // makes writeQuestionSet's mkdir throw after generation succeeded.
      mkdirSync(join(vault, ".daftari"), { recursive: true });
      writeFileSync(join(vault, ".daftari", "eval"), "not a directory");
      const code = await runEval(["generate", "--vault", vault, "--n", "3"]);
      expect(code).toBe(3);
      expect(stderrText()).toContain("failed to write question set");
    } finally {
      cleanupVault(vault);
    }
  });
});
