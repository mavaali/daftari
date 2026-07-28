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
import { readResults, writeQuestionSet, writeResults } from "../../src/eval/storage.js";
import type { EvalRun, QuestionSet } from "../../src/eval/types.js";
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

  it("treats a corrupted --resume file as a runtime failure (exit 3), not config", async () => {
    // The results file EXISTS but cannot be read back — e.g. truncated by a
    // crash during a prior incremental persist. That is an I/O failure, not
    // a typo'd id: exit 3, matching every sibling artifact-read failure.
    const dir = mkdtempSync(join(tmpdir(), "daftari-eval-"));
    try {
      await writeQuestionSet(dir, minimalQuestionSet("qs-1"));
      const resultsDir = join(dir, ".daftari", "eval", "results");
      mkdirSync(resultsDir, { recursive: true });
      writeFileSync(join(resultsDir, "truncated-run.json"), "{ not valid json");
      const code = await runEval([
        "run",
        "--vault",
        dir,
        "--questions",
        "qs-1",
        "--resume",
        "truncated-run",
      ]);
      expect(code).toBe(3);
      expect(stderrText()).toContain("--resume truncated-run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-positive --max-nodes with a config error", async () => {
    const code = await runEval(["generate", "--vault", ".", "--max-nodes", "0"]);
    expect(code).toBe(2);
    expect(stderrText()).toContain("--max-nodes must be a positive integer");
  });

  it("scores a truncated results file as PARTIAL — never-attempted runs count against the planned grid", async () => {
    // A process killed between incremental persists leaves NO entry for the
    // remaining (question, k) pairs — not even "incomplete". The coverage
    // denominator must be the planned questions × k grid, or a sliver of a
    // run scores as `graded N/N` with no warning.
    const dir = mkdtempSync(join(tmpdir(), "daftari-eval-"));
    try {
      const qs = minimalQuestionSet("qs-1");
      qs.questions = [
        {
          id: "q1",
          tier: "retrieval",
          question: "how many tiers?",
          expected_answer: "3",
          expected_sources: ["a.md"],
          origin: "generated",
        },
      ];
      await writeQuestionSet(dir, qs);
      const run: EvalRun = {
        id: "run-1",
        questions_id: "qs-1",
        answerer_model: "m",
        prompt_version: 1,
        timestamp: "2026-01-01T00:00:00Z",
        k: 2,
        runs: {}, // killed before any pair persisted
      };
      await writeResults(dir, run);
      const code = await runEval(["score", "--vault", dir, "--results", "run-1"]);
      expect(code).toBe(0);
      const out = outSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("graded 0/2 runs");
      expect(stderrText()).toContain("score is PARTIAL");
      expect(stderrText()).toContain("2 never-attempted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

// Transport selection (--transport / DAFTARI_LLM_TRANSPORT): the same rules
// as daftari sleep/consolidate, gated per stage as a config error (exit 2).
describe("daftari eval --transport", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let outSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.DAFTARI_LLM_TRANSPORT;
    errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.DAFTARI_LLM_TRANSPORT;
    errSpy.mockRestore();
    outSpy.mockRestore();
  });

  function stderrText(): string {
    return errSpy.mock.calls.map((c) => String(c[0])).join("");
  }

  it("exits 2 when --transport openrouter is given without OPENROUTER_API_KEY", async () => {
    const code = await runEval(["run", "--transport", "openrouter", "--questions", "qs-x"]);
    expect(code).toBe(2);
    expect(stderrText()).toContain("OPENROUTER_API_KEY required");
  });

  it("exits 2 on a malformed --transport value instead of billing a default", async () => {
    const code = await runEval(["run", "--transport", "openroutr", "--questions", "qs-x"]);
    expect(code).toBe(2);
    expect(stderrText()).toContain("unknown LLM transport");
  });

  it("keeps the historical anthropic-default message when no key is set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const code = await runEval(["run", "--questions", "qs-x"]);
    expect(code).toBe(2);
    expect(stderrText()).toContain("ANTHROPIC_API_KEY required");
  });

  it("honors the DAFTARI_LLM_TRANSPORT env fallback", async () => {
    process.env.DAFTARI_LLM_TRANSPORT = "openrouter";
    const code = await runEval(["score", "--results", "r-x"]);
    expect(code).toBe(2);
    expect(stderrText()).toContain("OPENROUTER_API_KEY required");
  });
});

// spec 2026-07-26-context-packs-progressive-disclosure-design.md, final plan
// Phase 3.4/3.5/C8: --condition/--budget/--max-tool-calls CLI wiring, run-id
// minting, and the --resume mismatch guard. Every run here uses an empty
// question set, so runAnswerer/runPackAnswerer's loop bodies never execute —
// these tests exercise only the CLI's flag parsing, id minting, and metadata
// persistence, not the answerer loops themselves (covered in
// test/eval/{run,pack-condition}.test.ts).
describe("daftari eval run --condition / --max-tool-calls (Phase 3.4)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let outSpy: ReturnType<typeof vi.spyOn>;
  let dir: string;

  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    outSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    dir = mkdtempSync(join(tmpdir(), "daftari-eval-condition-"));
    await writeQuestionSet(dir, minimalQuestionSet("qs-cond"));
  });

  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    errSpy.mockRestore();
    outSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  function stdoutText(): string {
    return outSpy.mock.calls.map((c) => String(c[0])).join("");
  }
  function stderrText(): string {
    return errSpy.mock.calls.map((c) => String(c[0])).join("");
  }

  it("rejects an invalid --condition value (exit 2)", async () => {
    const code = await runEval([
      "run",
      "--vault",
      dir,
      "--questions",
      "qs-cond",
      "--condition",
      "bogus",
    ]);
    expect(code).toBe(2);
    expect(stderrText()).toContain("--condition must be 'tools' or 'pack'");
  });

  it("default (uncapped tools) mints the historical id shape and persists condition: 'tools'", async () => {
    const code = await runEval(["run", "--vault", dir, "--questions", "qs-cond"]);
    expect(code).toBe(0);
    const id = stdoutText().match(/wrote results (\S+)/)?.[1];
    expect(id).toBeTruthy();
    expect(id).not.toContain("-tools-c");
    expect(id).not.toContain("-pack-b");
    const read = await readResults(dir, id as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.condition).toBe("tools");
    expect(read.value.max_tool_calls).toBeUndefined();
  });

  it("--max-tool-calls mints a '-tools-c{N}' id and persists max_tool_calls", async () => {
    const code = await runEval([
      "run",
      "--vault",
      dir,
      "--questions",
      "qs-cond",
      "--max-tool-calls",
      "6",
    ]);
    expect(code).toBe(0);
    const id = stdoutText().match(/wrote results (\S+)/)?.[1];
    expect(id).toContain("-tools-c6-");
    const read = await readResults(dir, id as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.condition).toBe("tools");
    expect(read.value.max_tool_calls).toBe(6);
  });

  it("--condition pack mints a '-pack-b{budget}' id and persists condition/pack_budget", async () => {
    const code = await runEval([
      "run",
      "--vault",
      dir,
      "--questions",
      "qs-cond",
      "--condition",
      "pack",
      "--budget",
      "3000",
    ]);
    expect(code).toBe(0);
    const id = stdoutText().match(/wrote results (\S+)/)?.[1];
    expect(id).toContain("-pack-b3000-");
    const read = await readResults(dir, id as string);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.condition).toBe("pack");
    expect(read.value.pack_budget).toBe(3000);
  });

  it("--resume refuses (exit 2) when the persisted condition does not match --condition", async () => {
    const first = await runEval([
      "run",
      "--vault",
      dir,
      "--questions",
      "qs-cond",
      "--condition",
      "pack",
    ]);
    expect(first).toBe(0);
    const id = stdoutText().match(/wrote results (\S+)/)?.[1] as string;
    errSpy.mockClear();
    outSpy.mockClear();
    const second = await runEval([
      "run",
      "--vault",
      dir,
      "--questions",
      "qs-cond",
      "--condition",
      "tools",
      "--resume",
      id,
    ]);
    expect(second).toBe(2);
    expect(stderrText()).toContain("persisted condition 'pack' does not match --condition 'tools'");
  });

  it("--resume refuses (exit 2) when the persisted --max-tool-calls does not match", async () => {
    const first = await runEval([
      "run",
      "--vault",
      dir,
      "--questions",
      "qs-cond",
      "--max-tool-calls",
      "6",
    ]);
    expect(first).toBe(0);
    const id = stdoutText().match(/wrote results (\S+)/)?.[1] as string;
    errSpy.mockClear();
    outSpy.mockClear();
    const second = await runEval([
      "run",
      "--vault",
      dir,
      "--questions",
      "qs-cond",
      "--max-tool-calls",
      "3",
      "--resume",
      id,
    ]);
    expect(second).toBe(2);
    expect(stderrText()).toContain("does not match --max-tool-calls 3");
  });

  it("--resume refuses (exit 2) when the persisted pack budget does not match", async () => {
    const first = await runEval([
      "run",
      "--vault",
      dir,
      "--questions",
      "qs-cond",
      "--condition",
      "pack",
      "--budget",
      "3000",
    ]);
    expect(first).toBe(0);
    const id = stdoutText().match(/wrote results (\S+)/)?.[1] as string;
    errSpy.mockClear();
    outSpy.mockClear();
    const second = await runEval([
      "run",
      "--vault",
      dir,
      "--questions",
      "qs-cond",
      "--condition",
      "pack",
      "--budget",
      "5000",
      "--resume",
      id,
    ]);
    expect(second).toBe(2);
    expect(stderrText()).toContain("does not match --budget 5000");
  });

  it("--resume with matching condition/budget/cap proceeds (no mismatch error)", async () => {
    const first = await runEval([
      "run",
      "--vault",
      dir,
      "--questions",
      "qs-cond",
      "--max-tool-calls",
      "6",
    ]);
    expect(first).toBe(0);
    const id = stdoutText().match(/wrote results (\S+)/)?.[1] as string;
    errSpy.mockClear();
    outSpy.mockClear();
    const second = await runEval([
      "run",
      "--vault",
      dir,
      "--questions",
      "qs-cond",
      "--max-tool-calls",
      "6",
      "--resume",
      id,
    ]);
    expect(second).toBe(0);
    expect(stderrText()).not.toContain("does not match");
  });
});

// C8: a legacy artifact minted before condition/pack_budget/max_tool_calls
// existed carries none of the three fields — it must still load and score
// as an uncapped `tools` run, never fail to parse.
describe("daftari eval score — legacy artifacts (C8)", () => {
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

  it("a results file with no condition/pack_budget/max_tool_calls fields still scores", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daftari-eval-legacy-"));
    try {
      const qs = minimalQuestionSet("qs-legacy");
      qs.questions = [
        {
          id: "q1",
          tier: "retrieval",
          question: "how many tiers?",
          expected_answer: "3",
          expected_sources: ["a.md"],
          origin: "generated",
        },
      ];
      await writeQuestionSet(dir, qs);
      // Deliberately no `condition` / `pack_budget` / `max_tool_calls` keys —
      // the exact shape a pre-this-wave artifact has.
      const legacyRun: EvalRun = {
        id: "legacy-run-1",
        questions_id: "qs-legacy",
        answerer_model: "m",
        prompt_version: 1,
        timestamp: "2026-01-01T00:00:00Z",
        k: 1,
        runs: {},
      };
      await writeResults(dir, legacyRun);
      const code = await runEval(["score", "--vault", dir, "--results", "legacy-run-1"]);
      expect(code).toBe(0);
      const out = outSpy.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("condition=tools");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Artifact ids double as filenames: an OpenRouter model slug's "/" must never
// reach the results/scores paths.
describe("modelIdSlug", () => {
  it("flattens path separators and exotic characters", async () => {
    const { modelIdSlug } = await import("../../src/eval/index.js");
    expect(modelIdSlug("anthropic/claude-sonnet-4.6")).toBe("anthropic-claude-sonnet-4.6");
    expect(modelIdSlug("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(modelIdSlug("a b/c:d")).toBe("a-b-c-d");
  });
});
