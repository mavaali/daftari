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
