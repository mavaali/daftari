import { describe, expect, it, vi } from "vitest";
import {
  createAnthropicClient,
  type LlmClient,
  retry,
  stripCodeFence,
} from "../../src/eval/llm.js";
import type { CortexEvalError } from "../../src/eval/types.js";
import { ok, type Result } from "../../src/frontmatter/types.js";

describe("LlmClient interface", () => {
  it("a mock client satisfies the interface", async () => {
    const mock: LlmClient = {
      complete: vi.fn(async () => ({
        ok: true,
        value: { text: "hello", input_tokens: 1, output_tokens: 1, stop_reason: "end_turn" },
      })),
      completeJson: vi.fn(async () => ({
        ok: true,
        // `text` is required by CompleteJsonResult — include it so this mock
        // genuinely satisfies the interface contract (tsconfig excludes test/,
        // so an omission would otherwise slip through untyped).
        value: {
          text: "{}",
          parsed: { foo: 1 },
          input_tokens: 1,
          output_tokens: 1,
          stop_reason: "end_turn",
        },
      })),
      completeWithTools: vi.fn(),
    };
    const r = await mock.complete({ system: "s", user: "u", model: "claude-sonnet-fake" });
    expect(r.ok).toBe(true);
  });

  it("createAnthropicClient throws if no API key", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => createAnthropicClient()).toThrow();
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  });
});

describe("temperature passthrough", () => {
  // Injects a fake Anthropic SDK client so the create call is observable.
  function makeClientWith(create: ReturnType<typeof vi.fn>) {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    // biome-ignore lint/suspicious/noExplicitAny: minimal SDK stand-in
    const client = createAnthropicClient({ messages: { create } } as any);
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
    else delete process.env.ANTHROPIC_API_KEY;
    return client;
  }

  it("forwards temperature when set, omits when unset", async () => {
    const create = vi.fn(async () => ({
      content: [{ type: "text", text: "ok", citations: null }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    }));
    const client = makeClientWith(create);
    await client.complete({ model: "m", system: "s", user: "u", temperature: 0 });
    expect(create.mock.calls[0][0]).toMatchObject({ temperature: 0 });
    await client.complete({ model: "m", system: "s", user: "u" });
    expect(create.mock.calls[1][0].temperature).toBeUndefined();
  });
});

// C5 (spec 2026-07-26-context-packs-progressive-disclosure-design.md, final
// plan Phase 3.3): maxToolCalls caps REALIZED tool calls, not requested
// ones — a round's parallel tool_use blocks can overshoot a naive
// "check-then-execute" cap, so the loop must enforce it call-by-call.
describe("completeWithTools — maxToolCalls cap (C5)", () => {
  function makeClientWith(create: ReturnType<typeof vi.fn>) {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    // biome-ignore lint/suspicious/noExplicitAny: minimal SDK stand-in
    const client = createAnthropicClient({ messages: { create } } as any);
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
    else delete process.env.ANTHROPIC_API_KEY;
    return client;
  }

  function toolUseBlock(id: string) {
    return { type: "tool_use", id, name: "probe", input: {} };
  }

  it("a round whose parallel calls would overshoot the cap executes only the remaining slots, stubs the rest, and still reaches a final answer", async () => {
    // Round 1: 5 parallel calls, cap=6 (0 used so far) — all 5 execute.
    // Round 2: 3 MORE parallel calls, remaining = 6-5 = 1 — only 1 executes,
    //   2 are stubbed. Realized total hits the cap (6).
    // Round 3: tools omitted (budget exhausted) — the mock still answers
    //   with plain text, proving the loop forces a final answer rather than
    //   looping forever or erroring.
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        content: Array.from({ length: 5 }, (_, i) => toolUseBlock(`r1-${i}`)),
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: Array.from({ length: 3 }, (_, i) => toolUseBlock(`r2-${i}`)),
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "final answer", citations: null }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      });
    const client = makeClientWith(create);

    const toolHandler = vi.fn(async () => "ok");
    const r = await client.completeWithTools({
      model: "m",
      system: "s",
      user: "u",
      tools: [{ name: "probe", description: "d", input_schema: { type: "object" } }],
      toolHandler,
      maxToolCalls: 6,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tool_calls).toHaveLength(6); // realized calls, never more than the cap
    expect(r.value.text).toBe("final answer");
    expect(toolHandler).toHaveBeenCalledTimes(6);

    // Round 3's request must have omitted `tools` — the cap forces the
    // final answer rather than merely hoping the model stops asking.
    expect(create.mock.calls[2][0]).not.toHaveProperty("tools");

    // The 2 stubbed calls from round 2 got a tool_result each (the API
    // requires one per tool_use id) carrying the budget-exhausted marker,
    // and were never counted.
    const round2ToolResults = create.mock.calls[2][0].messages.at(-1).content;
    const stubbed = round2ToolResults.filter((m: { content: string }) =>
      m.content.includes("tool-call budget exhausted"),
    );
    expect(stubbed).toHaveLength(2);
  });

  it("uncapped (maxToolCalls unset) behaves exactly as before — every requested call executes", async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        content: [toolUseBlock("a"), toolUseBlock("b")],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce({
        content: [{ type: "text", text: "done", citations: null }],
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      });
    const client = makeClientWith(create);
    const toolHandler = vi.fn(async () => "ok");
    const r = await client.completeWithTools({
      model: "m",
      system: "s",
      user: "u",
      tools: [{ name: "probe", description: "d", input_schema: { type: "object" } }],
      toolHandler,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tool_calls).toHaveLength(2);
    expect(toolHandler).toHaveBeenCalledTimes(2);
  });
});

describe("stripCodeFence", () => {
  it("strips a ```json fenced block", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it("strips a bare ``` fenced block", () => {
    expect(stripCodeFence("```\nhello\n```")).toBe("hello");
  });
  it("returns the input unchanged when there is no fence", () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe("retry", () => {
  it("returns success without retrying", async () => {
    const fn = vi.fn(async (): Promise<Result<number, CortexEvalError>> => ok(42));
    const r = await retry(fn);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a non-retryable thrown error (e.g. 400) and surfaces it", async () => {
    const fn = vi.fn(async (): Promise<Result<number, CortexEvalError>> => {
      throw Object.assign(new Error("bad request"), { status: 400 });
    });
    const r = await retry(fn);
    expect(r.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1); // no retries → no backoff delay
  });

  it("retries a 429 then succeeds", async () => {
    let calls = 0;
    const fn = vi.fn(async (): Promise<Result<number, CortexEvalError>> => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      return ok(7);
    });
    const r = await retry(fn);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("returns immediately on a non-retryable in-band llm error", async () => {
    const fn = vi.fn(
      async (): Promise<Result<number, CortexEvalError>> => ({
        ok: false,
        error: { kind: "llm", message: "parse fail", retryable: false },
      }),
    );
    const r = await retry(fn);
    expect(r.ok).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
