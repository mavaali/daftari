// OpenRouter LlmClient (src/eval/llm-openrouter.ts): the second model-family
// transport. Same LlmClient contract as createAnthropicClient, backed by
// OpenRouter's OpenAI-compatible /chat/completions endpoint via an injectable
// fetch — so every test here runs hermetically, no network.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOpenRouterClient,
  OPENROUTER_BASE_URL,
  resolveTransport,
} from "../../src/eval/llm-openrouter.js";

// Minimal fake of the fetch Response surface the client uses.
function fakeRes(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function okBody(text: string, inTok = 100, outTok = 20) {
  return {
    choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: inTok, completion_tokens: outTok },
  };
}

const OPTS = { model: "anthropic/claude-haiku-4.5", system: "sys", user: "usr" };

let savedKey: string | undefined;
let savedTransport: string | undefined;
beforeEach(() => {
  savedKey = process.env.OPENROUTER_API_KEY;
  savedTransport = process.env.DAFTARI_LLM_TRANSPORT;
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  delete process.env.DAFTARI_LLM_TRANSPORT;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
  if (savedTransport === undefined) delete process.env.DAFTARI_LLM_TRANSPORT;
  else process.env.DAFTARI_LLM_TRANSPORT = savedTransport;
  vi.restoreAllMocks();
});

describe("createOpenRouterClient — construction", () => {
  it("throws if OPENROUTER_API_KEY is missing", () => {
    delete process.env.OPENROUTER_API_KEY;
    expect(() => createOpenRouterClient()).toThrow(/OPENROUTER_API_KEY/);
  });
});

describe("complete", () => {
  it("POSTs the OpenAI-compatible shape and maps the response", async () => {
    const fetchImpl = vi.fn(async () => fakeRes(200, okBody("hello", 42, 7)));
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const r = await client.complete({ ...OPTS, temperature: 0 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("hello");
    expect(r.value.input_tokens).toBe(42);
    expect(r.value.output_tokens).toBe(7);
    // finish_reason is mapped to Anthropic's stop_reason vocabulary so eval
    // traces don't mix vocabularies across transports.
    expect(r.value.stop_reason).toBe("end_turn");

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-or-test");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("anthropic/claude-haiku-4.5");
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
  });

  it("omits temperature when not set (provider default applies)", async () => {
    const fetchImpl = vi.fn(async () => fakeRes(200, okBody("x")));
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.complete(OPTS);
    const body = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect("temperature" in body).toBe(false);
  });

  it("retries a 429 then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeRes(429, { error: "rate limited" }))
      .mockResolvedValueOnce(fakeRes(200, okBody("after retry")));
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.complete(OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text).toBe("after retry");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("a 4xx (non-429) fails fast without retry, carrying status + body snippet", async () => {
    const fetchImpl = vi.fn(async () => fakeRes(400, { error: { message: "bad model slug" } }));
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.complete(OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("llm");
    expect(r.error.retryable).toBe(false);
    expect(r.error.message).toMatch(/400/);
    expect(r.error.message).toMatch(/bad model slug/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("a response with no message content is an error, not an empty success", async () => {
    const fetchImpl = vi.fn(async () => fakeRes(200, { choices: [], usage: {} }));
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.complete(OPTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/content/i);
  });

  it("a thrown network error is retried, then surfaces as an llm error", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(fakeRes(200, okBody("recovered")));
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.complete(OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text).toBe("recovered");
  });

  it("maps finish_reason 'length' to 'max_tokens'", async () => {
    const body = {
      choices: [{ message: { content: "cut" }, finish_reason: "length" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const fetchImpl = vi.fn(async () => fakeRes(200, body));
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.complete(OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.stop_reason).toBe("max_tokens");
  });

  it("an OpenRouter error body on HTTP 200 with a transient code is retried", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(fakeRes(200, { error: { code: 502, message: "provider hiccup" } }))
      .mockResolvedValueOnce(fakeRes(200, okBody("after embedded 502")));
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.complete(OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text).toBe("after embedded 502");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("an OpenRouter error body on HTTP 200 with a non-transient code fails with ITS message", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeRes(200, { error: { code: 403, message: "moderation blocked" } }),
    );
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.complete(OPTS);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.retryable).toBe(false);
    expect(r.error.message).toMatch(/moderation blocked/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("flattens array content parts (multi-part providers) like the anthropic multi-block join", async () => {
    const body = {
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "part one " },
              { type: "reasoning", text: "IGNORED" },
              { type: "text", text: "part two" },
            ],
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    const fetchImpl = vi.fn(async () => fakeRes(200, body));
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.complete(OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text).toBe("part one part two");
  });

  it("a body that fails to parse (json() throws) is retried", async () => {
    const broken = {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected end of JSON input");
      },
      text: async () => "",
    };
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(broken)
      .mockResolvedValueOnce(fakeRes(200, okBody("after body reset")));
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.complete(OPTS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.text).toBe("after body reset");
  });
});

describe("completeJson", () => {
  it("embeds the schema in system, strips fences, and parses", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeRes(200, okBody('```json\n{"related": true, "premise": "A"}\n```')),
    );
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.completeJson({ ...OPTS, schema: { type: "object" } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.parsed).toEqual({ related: true, premise: "A" });

    const body = JSON.parse(
      String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    const sys = body.messages[0].content as string;
    expect(sys).toMatch(/Return JSON matching/);
    expect(sys).toMatch(/"type": "object"/);
  });

  it("unparseable output → non-retryable llm error with an output snippet", async () => {
    const fetchImpl = vi.fn(async () => fakeRes(200, okBody("not json at all")));
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const r = await client.completeJson({ ...OPTS, schema: {} });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.retryable).toBe(false);
    expect(r.error.message).toMatch(/not json at all/);
  });
});

describe("completeWithTools", () => {
  it("returns an explicit not-supported error (eval runs on the anthropic transport)", async () => {
    const client = createOpenRouterClient({
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    const r = await client.completeWithTools({
      ...OPTS,
      tools: [],
      toolHandler: async () => ({}),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/not supported.*openrouter/i);
  });
});

describe("resolveTransport", () => {
  it("defaults to anthropic with no flag and no env", () => {
    const r = resolveTransport(undefined);
    expect(r).toEqual({ ok: true, value: "anthropic" });
  });

  it("explicit 'openrouter' wins", () => {
    const r = resolveTransport("openrouter");
    expect(r).toEqual({ ok: true, value: "openrouter" });
  });

  it("falls back to DAFTARI_LLM_TRANSPORT when no explicit value", () => {
    process.env.DAFTARI_LLM_TRANSPORT = "openrouter";
    const r = resolveTransport(undefined);
    expect(r).toEqual({ ok: true, value: "openrouter" });
  });

  it("an explicit value overrides the env var", () => {
    process.env.DAFTARI_LLM_TRANSPORT = "openrouter";
    const r = resolveTransport("anthropic");
    expect(r).toEqual({ ok: true, value: "anthropic" });
  });

  it("is case-insensitive", () => {
    const r = resolveTransport("OpenRouter");
    expect(r).toEqual({ ok: true, value: "openrouter" });
  });

  it("rejects unknown transports, naming the valid ones", () => {
    const r = resolveTransport("gemini");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/anthropic.*openrouter|openrouter.*anthropic/);
  });

  it("rejects a malformed env var too (a typo must not silently mean anthropic)", () => {
    process.env.DAFTARI_LLM_TRANSPORT = "openroutr";
    const r = resolveTransport(undefined);
    expect(r.ok).toBe(false);
  });

  it("an explicit empty string falls through to the env var, not to anthropic", () => {
    process.env.DAFTARI_LLM_TRANSPORT = "openrouter";
    const r = resolveTransport("");
    expect(r).toEqual({ ok: true, value: "openrouter" });
  });

  it("trims whitespace from the env var (launchd/cron quoting mishaps)", () => {
    process.env.DAFTARI_LLM_TRANSPORT = " openrouter ";
    const r = resolveTransport(undefined);
    expect(r).toEqual({ ok: true, value: "openrouter" });
  });
});
