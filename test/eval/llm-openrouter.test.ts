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

// The former not-supported stub is gone: completeWithTools is implemented
// (OpenAI function-calling loop) — see the dedicated describe block below.

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

// The OpenAI-style function-calling loop (completeWithTools): tools go up as
// {type:"function"}, arguments come back JSON-encoded, results echo back as
// role:"tool" messages, and the loop ends on the first round with no calls.
describe("createOpenRouterClient — completeWithTools", () => {
  const TOOL_OPTS = {
    ...OPTS,
    tools: [{ name: "vault_read", description: "read a doc", input_schema: { type: "object" } }],
  };

  function toolCallBody(name: string, args: string, id?: string) {
    return {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    };
  }

  it("executes tool calls and returns the final answer with accumulated usage", async () => {
    const bodies: any[] = [];
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        return fakeRes(200, toolCallBody("vault_read", '{"path":"a.md"}', "call_1"));
      })
      .mockImplementationOnce(async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        return fakeRes(200, okBody("final answer", 60, 30));
      });
    const handler = vi.fn().mockResolvedValue({ content: "doc body" });
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as any });

    const r = await client.completeWithTools({ ...TOOL_OPTS, toolHandler: handler });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("final answer");
    expect(r.value.input_tokens).toBe(110);
    expect(r.value.output_tokens).toBe(40);
    expect(r.value.tool_calls).toHaveLength(1);
    expect(r.value.tool_calls[0]).toMatchObject({
      tool: "vault_read",
      input: { path: "a.md" },
      output: { content: "doc body" },
    });
    expect(handler).toHaveBeenCalledWith("vault_read", { path: "a.md" });

    // Round 1 request carries OpenAI-style tools; round 2 echoes the
    // assistant tool_calls turn and the role:"tool" result.
    expect(bodies[0].tools[0]).toMatchObject({
      type: "function",
      function: { name: "vault_read" },
    });
    const roles = bodies[1].messages.map((m: any) => m.role);
    expect(roles).toEqual(["system", "user", "assistant", "tool"]);
    expect(bodies[1].messages[3]).toMatchObject({
      tool_call_id: "call_1",
      content: JSON.stringify({ content: "doc body" }),
    });
  });

  it("hands malformed arguments to the handler as the raw string", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => fakeRes(200, toolCallBody("vault_read", "{not json")))
      .mockImplementationOnce(async () => fakeRes(200, okBody("done")));
    const handler = vi.fn().mockResolvedValue("ok");
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as any });

    const r = await client.completeWithTools({ ...TOOL_OPTS, toolHandler: handler });
    expect(r.ok).toBe(true);
    expect(handler).toHaveBeenCalledWith("vault_read", "{not json");
  });

  it("fails with maxRounds exceeded when the model never stops calling tools", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => fakeRes(200, toolCallBody("vault_read", "{}")));
    const handler = vi.fn().mockResolvedValue("ok");
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as any });

    const r = await client.completeWithTools({ ...TOOL_OPTS, toolHandler: handler, maxRounds: 3 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("exceeded maxRounds (3)");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("records a thrown tool handler as tool_error and keeps going", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => fakeRes(200, toolCallBody("vault_read", "{}")))
      .mockImplementationOnce(async () => fakeRes(200, okBody("recovered")));
    const handler = vi.fn().mockRejectedValue(new Error("boom"));
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as any });

    const r = await client.completeWithTools({ ...TOOL_OPTS, toolHandler: handler });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("recovered");
    expect(r.value.tool_calls[0].output).toEqual({ tool_error: "boom" });
  });

  // C5 (spec 2026-07-26-context-packs-progressive-disclosure-design.md,
  // final plan Phase 3.3): maxToolCalls caps REALIZED calls even when a
  // round's parallel tool_calls would overshoot it — the OpenRouter twin of
  // the anthropic-client test in test/eval/llm.test.ts.
  it("maxToolCalls stubs excess calls within an overshooting round and forces a final answer", async () => {
    function multiCallBody(n: number, prefix: string) {
      return {
        choices: [
          {
            message: {
              content: null,
              tool_calls: Array.from({ length: n }, (_, i) => ({
                id: `${prefix}-${i}`,
                type: "function",
                function: { name: "vault_read", arguments: "{}" },
              })),
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      };
    }
    const bodies: any[] = [];
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        return fakeRes(200, multiCallBody(5, "r1"));
      })
      .mockImplementationOnce(async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        return fakeRes(200, multiCallBody(3, "r2"));
      })
      .mockImplementationOnce(async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        return fakeRes(200, okBody("final answer"));
      });
    const handler = vi.fn().mockResolvedValue("ok");
    const client = createOpenRouterClient({ fetchImpl: fetchImpl as any });

    const r = await client.completeWithTools({
      ...TOOL_OPTS,
      toolHandler: handler,
      maxToolCalls: 6,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.text).toBe("final answer");
    expect(r.value.tool_calls).toHaveLength(6);
    expect(handler).toHaveBeenCalledTimes(6);

    // Round 3's request omitted `tools` — the cap forces a final answer.
    expect(bodies[2]).not.toHaveProperty("tools");

    // 2 of round 2's 3 calls got stubbed, never executed.
    const round2Messages = bodies[2].messages;
    const stubbed = round2Messages.filter(
      (m: { content?: string }) =>
        typeof m.content === "string" && m.content.includes("tool-call budget exhausted"),
    );
    expect(stubbed).toHaveLength(2);
  });
});
