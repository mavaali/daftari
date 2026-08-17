import { describe, expect, it, vi } from "vitest";
import {
  completeJsonWithRetry,
  createAnthropicClient,
  type LlmClient,
  parseModelJson,
  retry,
  stripCodeFence,
} from "../../src/eval/llm.js";
import type { CortexEvalError } from "../../src/eval/types.js";
import { err, ok, type Result } from "../../src/frontmatter/types.js";

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

describe("parseModelJson", () => {
  it("parses clean JSON with no wrapper", () => {
    expect(parseModelJson('{"claims":[{"statement":"x"}]}')).toEqual({
      claims: [{ statement: "x" }],
    });
  });

  it("parses a whole-string ```json fenced block", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parses a bare ``` fenced block", () => {
    expect(parseModelJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("recovers JSON from a fenced block with leading prose (the Ollama case)", () => {
    const text = 'Here is the JSON you asked for:\n\n```json\n{"claims":[{"statement":"y"}]}\n```';
    expect(parseModelJson(text)).toEqual({ claims: [{ statement: "y" }] });
  });

  it("recovers a bare object preceded by reasoning preamble", () => {
    const text = 'Sure — my analysis is done.\n{"a":1,"b":2}';
    expect(parseModelJson(text)).toEqual({ a: 1, b: 2 });
  });

  it("recovers an object with trailing prose after it", () => {
    expect(parseModelJson('{"a":1}\n\nHope that helps!')).toEqual({ a: 1 });
  });

  it("recovers a fenced block that has no trailing newline before the closing fence", () => {
    expect(parseModelJson('```json\n{"a":1}```')).toEqual({ a: 1 });
  });

  it("parses a top-level array", () => {
    expect(parseModelJson('```json\n[{"statement":"z"}]\n```')).toEqual([{ statement: "z" }]);
  });

  it("throws when no JSON can be recovered", () => {
    expect(() => parseModelJson("there is no json in this reply at all")).toThrow();
  });
});

describe("completeJsonWithRetry", () => {
  const okText = (text: string) =>
    ok({ text, input_tokens: 1, output_tokens: 1, stop_reason: "end_turn" });
  const jsonOpts = { model: "m", system: "s", user: "u", schema: { type: "object" } };

  it("parses on the first try when JSON is valid (no retry)", async () => {
    const complete = vi.fn(async () => okText('{"claims":[]}'));
    const r = await completeJsonWithRetry(complete, jsonOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.parsed).toEqual({ claims: [] });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("retries once with a reprompt and recovers when the first reply is unparseable", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(okText("say")) // degenerate garbage generation
      .mockResolvedValueOnce(okText('{"claims":[{"statement":"x"}]}'));
    const r = await completeJsonWithRetry(complete, jsonOpts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.parsed).toEqual({ claims: [{ statement: "x" }] });
    expect(complete).toHaveBeenCalledTimes(2);
    // the retry nudges temperature off 0 (temp 0 would repeat the garbage) and
    // reprompts for raw JSON.
    const retryOpts = complete.mock.calls[1][0];
    expect(retryOpts.temperature).toBeGreaterThan(0);
    expect(retryOpts.system).toMatch(/ONLY the raw JSON/i);
  });

  it("returns a parse error after the retry also fails", async () => {
    const complete = vi.fn(async () => okText("still not json"));
    const r = await completeJsonWithRetry(complete, jsonOpts);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/after retry/i);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does not retry when the underlying complete call errors", async () => {
    const complete = vi.fn(async () =>
      err<CortexEvalError>({ kind: "llm", message: "boom", retryable: false }),
    );
    const r = await completeJsonWithRetry(complete, jsonOpts);
    expect(r.ok).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
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
