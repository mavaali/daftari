// Tests for the authoring compiler loop (compiler.ts).
//
// HERMETIC block: supersede-guard tests — no MiniLM, no real vault write needed.
//   The guard is exposed as wrapHandlerWithSupersede and tested by injecting a
//   spy inner handler. No index load; runs in the default suite.
//
// INTEGRATION block (RB_INTEGRATION): notesWritten accumulation — requires a
//   real tmp vault + reindexVault (loads MiniLM). Mirrors the pattern from
//   write-tools.test.ts and adapter.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../../../dist/frontmatter/types.js";
import type {
  LlmClient,
  CompleteWithToolsOpts,
} from "../../../dist/eval/llm.js";
import { makeCompiler, wrapHandlerWithSupersede } from "./compiler.js";
import { parseConfig } from "./config.js";

const RUN = !!process.env.RB_INTEGRATION;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCfg(over: Record<string, unknown> = {}) {
  const r = parseConfig({
    answererModel: "stub-model",
    authoringModel: "stub-authoring-model",
    ...over,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const META = {
  dayNumber: 1,
  date: "2026-01-01",
  personaId: "persona-a",
  activeArcs: ["testing"],
};

// A spy inner handler that records calls and returns a canned success value.
function makeSpy() {
  const calls: Array<{ name: string; input: unknown }> = [];
  const handler = async (name: string, input: unknown): Promise<unknown> => {
    calls.push({ name, input });
    return { ok: true, path: (input as Record<string, unknown>).old_path ?? "written" };
  };
  return { handler, calls };
}

// ---------------------------------------------------------------------------
// HERMETIC: wrapHandlerWithSupersede — supersede-guard behaviour
// ---------------------------------------------------------------------------

describe("wrapHandlerWithSupersede — guard behaviour", () => {
  it("blocks vault_supersede when old_path is NOT in priorDayPaths", async () => {
    const { handler: innerHandler, calls } = makeSpy();
    const priorDayPaths = ["persona-a/day-0001.md"];

    const guarded = wrapHandlerWithSupersede(innerHandler, priorDayPaths);

    const result = await guarded("vault_supersede", {
      old_path: "persona-a/day-0099.md", // not in priorDayPaths
      new_path: "persona-a/day-0001.md",
      agent: "test",
    });

    // Inner handler must NOT have been called.
    expect(calls).toHaveLength(0);

    // Result must signal rejection — the agent needs to see it.
    const r = result as Record<string, unknown>;
    expect(r.tool_error ?? r.error ?? r.rejected).toBeTruthy();
  });

  it("allows vault_supersede when old_path IS in priorDayPaths", async () => {
    const { handler: innerHandler, calls } = makeSpy();
    const priorDayPaths = ["persona-a/day-0001.md", "persona-a/day-0002.md"];

    const guarded = wrapHandlerWithSupersede(innerHandler, priorDayPaths);

    await guarded("vault_supersede", {
      old_path: "persona-a/day-0001.md", // IS in priorDayPaths
      new_path: "persona-a/day-0003.md",
      agent: "test",
    });

    // Inner handler MUST have been dispatched.
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("vault_supersede");
  });

  it("passes non-supersede tools through to the inner handler unconditionally", async () => {
    const { handler: innerHandler, calls } = makeSpy();
    const guarded = wrapHandlerWithSupersede(innerHandler, []);

    await guarded("vault_write", { path: "notes/x.md", body: "hello", agent: "test" });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("vault_write");
  });

  it("blocks supersede even when priorDayPaths is empty", async () => {
    const { handler: innerHandler, calls } = makeSpy();
    const guarded = wrapHandlerWithSupersede(innerHandler, []);

    const result = await guarded("vault_supersede", {
      old_path: "persona-a/day-0001.md",
      new_path: "persona-a/day-0002.md",
      agent: "test",
    });

    expect(calls).toHaveLength(0);
    const r = result as Record<string, unknown>;
    expect(r.tool_error ?? r.error ?? r.rejected).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// HERMETIC: makeCompiler shape — no vault I/O
// ---------------------------------------------------------------------------

describe("makeCompiler — returns a function", () => {
  it("makeCompiler returns a callable compiler function", () => {
    const stubLlm: LlmClient = {
      async complete() {
        return ok({ text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" });
      },
      async completeJson() {
        return ok({ text: "", parsed: {}, input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" });
      },
      async completeWithTools() {
        return ok({ text: "", tool_calls: [], input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" });
      },
    };

    const compiler = makeCompiler("/tmp/__fake_vault__", makeCfg(), stubLlm);
    expect(typeof compiler).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// HERMETIC: makeCompiler — supersede guard enforced end-to-end through compiler
// ---------------------------------------------------------------------------

describe("makeCompiler — supersede guard via stub llm (hermetic)", () => {
  it("rejects vault_supersede for old_path not in priorDayPaths, records error in toolCalls", async () => {
    // Stub LLM: emits exactly one vault_supersede with a path NOT in priorDayPaths.
    // The guarded handler should NOT dispatch to any real tool; the tool call
    // result recorded in CompileResult.toolCalls should encode the rejection.
    const stubLlm: LlmClient = {
      async complete() {
        return ok({ text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" });
      },
      async completeJson() {
        return ok({ text: "", parsed: {}, input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" });
      },
      async completeWithTools(opts: CompleteWithToolsOpts) {
        // Drive the guarded handler directly so we see what the agent would see.
        const output = await opts.toolHandler("vault_supersede", {
          old_path: "persona-a/day-0099.md", // deliberately NOT in priorDayPaths
          new_path: "persona-a/day-0001.md",
          agent: "agent:recall-bench-compiler",
        });
        return ok({
          text: "done",
          tool_calls: [
            {
              tool: "vault_supersede",
              input: { old_path: "persona-a/day-0099.md", new_path: "persona-a/day-0001.md" },
              output,
              latency_ms: 1,
            },
          ],
          input_tokens: 1,
          output_tokens: 1,
          stop_reason: "end_turn",
        });
      },
    };

    const compiler = makeCompiler("/tmp/__fake_vault__", makeCfg(), stubLlm);
    const result = await compiler(1, "Day 1 content.", META, [
      "persona-a/day-0001.md", // priorDayPaths does NOT include day-0099
    ]);

    // Should have one tool call recorded.
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe("vault_supersede");

    // The result preview should encode the rejection (tool_error / error / rejected).
    const preview = result.toolCalls[0].resultPreview;
    expect(preview).toMatch(/tool_error|error|rejected/i);

    // notesWritten must be empty — no vault_write succeeded.
    expect(result.notesWritten).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION: notesWritten accumulation (requires MiniLM)
// ---------------------------------------------------------------------------

describe.skipIf(!RUN)("makeCompiler — notesWritten (RB_INTEGRATION)", () => {
  let vaultRoot: string;

  beforeAll(async () => {
    vaultRoot = await mkdtemp(join(tmpdir(), "daftari-compiler-"));
    await mkdir(join(vaultRoot, "notes"), { recursive: true });

    const { reindexVault } = await import("../../../dist/search/reindex.js");
    await reindexVault(vaultRoot);
  }, 120_000);

  afterAll(async () => {
    if (vaultRoot) await rm(vaultRoot, { recursive: true, force: true });
  });

  it("returns the path of a successful vault_write in notesWritten", async () => {
    const writtenPath = "notes/compiler-test.md";

    // Stub LLM: emits a single vault_write tool call.
    const stubLlm: LlmClient = {
      async complete() {
        return ok({ text: "", input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" });
      },
      async completeJson() {
        return ok({ text: "", parsed: {}, input_tokens: 0, output_tokens: 0, stop_reason: "end_turn" });
      },
      async completeWithTools(opts: CompleteWithToolsOpts) {
        // Dispatch a real vault_write so the file lands on disk.
        const output = await opts.toolHandler("vault_write", {
          path: writtenPath,
          body: "Compiler test content.",
          frontmatter: {
            title: "Compiler Test",
            domain: "accumulation",
            collection: "notes",
            status: "draft",
            confidence: "high",
            provenance: "direct",
            created: "2026-01-01",
            tags: [],
          },
          agent: "agent:recall-bench-compiler",
        });
        return ok({
          text: "done",
          tool_calls: [
            {
              tool: "vault_write",
              input: { path: writtenPath },
              output,
              latency_ms: 1,
            },
          ],
          input_tokens: 1,
          output_tokens: 1,
          stop_reason: "end_turn",
        });
      },
    };

    const compiler = makeCompiler(vaultRoot, makeCfg(), stubLlm);
    const result = await compiler(1, "Day 1 content.", META, []);

    expect(result.notesWritten).toContain(writtenPath);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe("vault_write");
  }, 60_000);
});
