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

describe("run metadata — anthropic complete()", () => {
  function makeClientWith(create: ReturnType<typeof vi.fn>) {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    // biome-ignore lint/suspicious/noExplicitAny: minimal SDK stand-in
    const client = createAnthropicClient({ messages: { create } } as any);
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
    else delete process.env.ANTHROPIC_API_KEY;
    return client;
  }

  it("surfaces servedModel from the SDK response and the effective temperature sent", async () => {
    const create = vi.fn(async () => ({
      // The served model the API actually returned — distinct from requested.
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "ok", citations: null }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    }));
    const client = makeClientWith(create);
    const r = await client.complete({
      model: "claude-sonnet-latest",
      system: "s",
      user: "u",
      temperature: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.servedModel).toBe("claude-3-5-sonnet-20241022");
    expect(r.value.effectiveTemperature).toBe(0);
  });

  it("reports effectiveTemperature undefined when no temperature was sent", async () => {
    const create = vi.fn(async () => ({
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "ok", citations: null }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    }));
    const client = makeClientWith(create);
    const r = await client.complete({ model: "m", system: "s", user: "u" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.effectiveTemperature).toBeUndefined();
  });
});

describe("completeJson — anthropic transport (end-to-end)", () => {
  // Same contract as the openrouter client's completeJson tests: the anthropic
  // client's completeJson delegates to the shared completeJsonWithRetry, so
  // fenced/preamble model output must be recovered the same way on both
  // transports (mavaali-beads-12a — the openrouter path got this coverage in
  // #486; the anthropic path never did).
  function makeClientWith(create: ReturnType<typeof vi.fn>) {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    // biome-ignore lint/suspicious/noExplicitAny: minimal SDK stand-in
    const client = createAnthropicClient({ messages: { create } } as any);
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
    else delete process.env.ANTHROPIC_API_KEY;
    return client;
  }
  function createReturning(text: string) {
    return vi.fn(async () => ({
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text, citations: null }],
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    }));
  }

  it("recovers JSON from a fenced block with leading prose (local-model preamble case)", async () => {
    const client = makeClientWith(
      createReturning('Here is the JSON you asked for:\n\n```json\n{"related": true}\n```'),
    );
    const r = await client.completeJson({
      model: "m",
      system: "s",
      user: "u",
      schema: { type: "object" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.parsed).toEqual({ related: true });
  });

  it("recovers a bare object preceded by reasoning preamble (no fence)", async () => {
    const client = makeClientWith(createReturning('Sure, here you go:\n{"related": false}'));
    const r = await client.completeJson({
      model: "m",
      system: "s",
      user: "u",
      schema: { type: "object" },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.parsed).toEqual({ related: false });
  });
});

describe("run metadata — completeJsonWithRetry", () => {
  const okText = (text: string, servedModel = "served-x") =>
    ok({
      text,
      input_tokens: 1,
      output_tokens: 1,
      stop_reason: "end_turn",
      servedModel,
      // The underlying complete() reports the temp it actually sent.
      effectiveTemperature: 0,
    });
  const jsonOpts = {
    model: "m",
    system: "s",
    user: "u",
    schema: { type: "object" },
    temperature: 0,
  };

  it("first-try success sets viaRetry false and effectiveTemperature = requested temp", async () => {
    const complete = vi.fn(async () => okText('{"claims":[]}'));
    const r = await completeJsonWithRetry(complete, jsonOpts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.viaRetry).toBe(false);
    expect(r.value.effectiveTemperature).toBe(0);
    expect(r.value.servedModel).toBe("served-x");
  });

  it("retry path sets viaRetry true and effectiveTemperature 0.2, carrying servedModel from the retry call", async () => {
    const complete = vi
      .fn()
      // First reply is garbage; underlying complete reports temp 0.
      .mockResolvedValueOnce(
        ok({
          text: "say",
          input_tokens: 1,
          output_tokens: 1,
          stop_reason: "end_turn",
          servedModel: "served-first",
          effectiveTemperature: 0,
        }),
      )
      // Retry reply parses; underlying complete reports the bumped temp 0.2.
      .mockResolvedValueOnce(
        ok({
          text: '{"claims":[{"statement":"x"}]}',
          input_tokens: 1,
          output_tokens: 1,
          stop_reason: "end_turn",
          servedModel: "served-retry",
          effectiveTemperature: 0.2,
        }),
      );
    const r = await completeJsonWithRetry(complete, jsonOpts);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.viaRetry).toBe(true);
    // Salvaged via retry ⇒ effective temp is the bumped 0.2, NOT the requested 0.
    expect(r.value.effectiveTemperature).toBe(0.2);
    // servedModel comes from the retry call that produced the returned value.
    expect(r.value.servedModel).toBe("served-retry");
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
