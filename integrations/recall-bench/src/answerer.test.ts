// INTEGRATION test (NOT hermetic): exercises real reindexVault + buildToolSurface,
// which load the MiniLM embedding model. Gated behind RB_INTEGRATION so the
// hermetic suite stays fast and offline-safe.
//
// The LLM is stubbed (no network), but the tool surface and search index are
// real: the stub's completeWithTools invokes the REAL toolHandler against the
// freshly indexed vault, so we verify end-to-end that a planted fact is
// retrieved and surfaced.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../../../dist/frontmatter/types.js";
import { reindexVault } from "../../../dist/search/reindex.js";
import type {
  LlmClient,
  CompleteWithToolsOpts,
} from "../../../dist/eval/llm.js";
import { makeAnswerer, extractRetrieval, wrapHandlerWithLimit } from "./answerer.js";
import { mapDay } from "./corpus-map.js";
import type { AdapterConfig } from "./config.js";

const RUN = !!process.env.RB_INTEGRATION;

// HERMETIC: pure extraction invariants — no MiniLM, no network. These ran inside
// the RB_INTEGRATION-gated block before, which meant they were silently SKIPPED
// in the default suite. They are pure functions of hand-built tool-call records,
// so they belong in the always-on hermetic suite.
describe("extractRetrieval", () => {
  it("dedups by path keeping max score across multiple search calls", () => {
    const merged = extractRetrieval([
      {
        tool: "vault_search",
        input: { query: "a" },
        output: { hits: [{ path: "x.md", score: 0.2, snippet: "lo" }] },
        latency_ms: 1,
      },
      {
        tool: "vault_search",
        input: { query: "b" },
        output: { hits: [{ path: "x.md", score: 0.9, snippet: "hi" }] },
        latency_ms: 1,
      },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({ path: "x.md", score: 0.9, snippet: "hi" });
  });

  it("skips tool_error and non-search outputs during extraction", () => {
    const merged = extractRetrieval([
      { tool: "vault_search", input: {}, output: { tool_error: "boom" }, latency_ms: 1 },
      { tool: "vault_read", input: {}, output: { hits: [{ path: "y.md", score: 1, snippet: "s" }] }, latency_ms: 1 },
      { tool: "vault_search", input: {}, output: { hits: [{ path: "z.md", score: 0.5, snippet: "s" }] }, latency_ms: 1 },
    ]);
    expect(merged).toEqual([{ path: "z.md", score: 0.5, snippet: "s" }]);
  });
});

// HERMETIC: the limit-capping wrapper around the tool handler. Uses a fake inner
// handler that echoes its (name, input) so we can assert exactly what the wrapper
// forwarded — no MiniLM, no search index.
describe("wrapHandlerWithLimit", () => {
  function makeSpy() {
    const calls: Array<{ name: string; input: unknown }> = [];
    const handler = async (name: string, input: unknown) => {
      calls.push({ name, input });
      return { echoed: true };
    };
    return { handler, calls };
  }

  it("injects limit when the model omits it on vault_search", async () => {
    const { handler, calls } = makeSpy();
    const wrapped = wrapHandlerWithLimit(handler, 15);
    await wrapped("vault_search", { query: "q" });
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toEqual({ query: "q", limit: 15 });
  });

  it("caps limit when the model exceeds maxSearchResults", async () => {
    const { handler, calls } = makeSpy();
    const wrapped = wrapHandlerWithLimit(handler, 15);
    await wrapped("vault_search", { query: "q", limit: 99 });
    expect(calls[0].input).toEqual({ query: "q", limit: 15 });
  });

  it("leaves a within-bounds limit untouched on vault_search", async () => {
    const { handler, calls } = makeSpy();
    const wrapped = wrapHandlerWithLimit(handler, 15);
    await wrapped("vault_search", { query: "q", limit: 5 });
    expect(calls[0].input).toEqual({ query: "q", limit: 5 });
  });

  it("passes non-search tools through unchanged", async () => {
    const { handler, calls } = makeSpy();
    const wrapped = wrapHandlerWithLimit(handler, 15);
    await wrapped("vault_read", { path: "a.md", limit: 99 });
    expect(calls[0]).toEqual({ name: "vault_read", input: { path: "a.md", limit: 99 } });
  });

  it("injects limit even when vault_search input is missing/not an object", async () => {
    const { handler, calls } = makeSpy();
    const wrapped = wrapHandlerWithLimit(handler, 15);
    await wrapped("vault_search", undefined);
    expect(calls[0].input).toEqual({ limit: 15 });
  });
});

const CFG: AdapterConfig = {
  answererModel: "stub-model",
  maxSearchResults: 15,
  agentMaxIterations: 6,
};

// A stub LlmClient that structurally satisfies the interface. Its
// completeWithTools calls the REAL toolHandler("vault_search", {query}) once,
// then returns a result echoing that real output, so retrieval extraction runs
// against genuine search hits.
function makeStubLlm(question: string): LlmClient {
  return {
    async complete() {
      return ok({ text: "stub", input_tokens: 1, output_tokens: 1, stop_reason: "end_turn" });
    },
    async completeJson() {
      return ok({
        text: "stub",
        parsed: {},
        input_tokens: 1,
        output_tokens: 1,
        stop_reason: "end_turn",
      });
    },
    async completeWithTools(opts: CompleteWithToolsOpts) {
      const query = question;
      const output = await opts.toolHandler("vault_search", { query });
      return ok({
        text: `The planted fact is sapphire. [persona-a/day-0001.md]`,
        tool_calls: [
          { tool: "vault_search", input: { query }, output, latency_ms: 1 },
        ],
        input_tokens: 1,
        output_tokens: 1,
        stop_reason: "end_turn",
      });
    },
  };
}

describe.skipIf(!RUN)("makeAnswerer (integration)", () => {
  let vault: string;

  beforeAll(async () => {
    vault = await mkdtemp(join(tmpdir(), "rb-answerer-"));
    const days = [
      mapDay(1, "The secret gemstone of the week is sapphire.", {
        dayNumber: 1,
        date: "2026-01-01",
        personaId: "persona-a",
        activeArcs: ["gemstones"],
      }),
      mapDay(2, "Lunch was a quiet bowl of ramen near the office.", {
        dayNumber: 2,
        date: "2026-01-02",
        personaId: "persona-a",
        activeArcs: ["food"],
      }),
    ];
    for (const d of days) {
      const abs = join(vault, d.relPath);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, d.markdown, "utf8");
    }
    const r = await reindexVault(vault);
    if (!r.ok) throw r.error;
  }, 120_000);

  afterAll(async () => {
    if (vault) await rm(vault, { recursive: true, force: true });
  });

  it("returns the planted answer and retrieves the planted daily", async () => {
    const answer = makeAnswerer(vault, CFG, makeStubLlm("What is the secret gemstone?"));
    const result = await answer("What is the secret gemstone?");

    expect(result.answer).toContain("sapphire");

    const planted = result.retrieval.find((r) => r.path === "persona-a/day-0001.md");
    expect(planted).toBeDefined();
    expect(planted!.path).toBe("persona-a/day-0001.md");
    expect(typeof planted!.score).toBe("number");
    expect(typeof planted!.snippet).toBe("string");

    // toolCalls record the real vault_search call with a bounded preview.
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe("vault_search");
    expect(result.toolCalls[0].args).toEqual({ query: "What is the secret gemstone?" });
    expect(result.toolCalls[0].resultPreview.length).toBeLessThanOrEqual(200);
  }, 60_000);
});
