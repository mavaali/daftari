// src/eval/llm-openrouter.ts
// Second model-family transport for the LlmClient interface, backed by
// OpenRouter's OpenAI-compatible /chat/completions endpoint. Exists for two
// reasons: (1) the Stage-5 graduation gate requires panel votes from ≥2 model
// families (spec §12 amendment, 2026-07-02 — single-family k_survived is
// ~92% error-correlated); (2) it lets the consolidate cadence run on an
// OPENROUTER_API_KEY where no billed ANTHROPIC_API_KEY is exposed.
//
// Grounded on scripts/run-decorrelation-openrouter.mjs (the shim that ran the
// decorrelation report), promoted to a real client: injectable fetch for
// hermetic tests, the shared retry() for 429/5xx/network backoff, and the same
// schema-in-system completeJson contract as createAnthropicClient.

import { err, ok, type Result } from "../frontmatter/types.js";
import {
  type CompleteJsonOpts,
  type CompleteJsonResult,
  type CompleteOpts,
  type CompleteResult,
  type CompleteWithToolsOpts,
  type CompleteWithToolsResult,
  completeJsonWithRetry,
  type LlmClient,
  retry,
} from "./llm.js";
import type { CortexEvalError } from "./types.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Per-attempt deadline for a single /chat/completions POST. undici applies no
// overall request timeout, so a stalled connection or a slow-drip 200 body would
// hang a consolidate/eval run indefinitely. An abort throws, which postChat's
// catch already classifies as a retryable transport failure. Completions and
// tool-loop rounds run longer than embeddings, hence the larger default;
// DAFTARI_OPENROUTER_TIMEOUT_MS overrides it (the deadline is operator policy).
const REQUEST_TIMEOUT_MS = Number(process.env.DAFTARI_OPENROUTER_TIMEOUT_MS) || 120_000;

export type LlmTransport = "anthropic" | "openrouter";

// Transport selection: explicit value (CLI flag) wins, then the
// DAFTARI_LLM_TRANSPORT env var, then "anthropic" (the historical default —
// every existing caller keeps its behavior). A malformed value is an error,
// never a silent fallback: a typo'd "openroutr" must not quietly bill the
// Anthropic key.
export function resolveTransport(explicit: string | undefined): Result<LlmTransport, Error> {
  // `||` (not `??`): an explicit empty string means "not given" and falls
  // through to the env var. Trim tolerates launchd/cron quoting mishaps.
  const raw = (explicit || process.env.DAFTARI_LLM_TRANSPORT)?.trim();
  if (raw === undefined || raw === "") return ok("anthropic");
  const norm = raw.toLowerCase();
  if (norm === "anthropic" || norm === "openrouter") return ok(norm);
  return err(new Error(`unknown LLM transport '${raw}' — valid values: anthropic, openrouter`));
}

// OpenAI-style tool call as relayed by OpenRouter: `function.arguments` is a
// JSON-ENCODED STRING, not an object (the wire format difference vs
// Anthropic's structured `input`).
interface OpenRouterToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenRouterChatResponse {
  // The model the provider actually served — echoed at the top level of the
  // OpenAI-compatible response. Distinct from the requested model. Surfaced as
  // CompleteResult.servedModel (6mf.6); undefined when the provider omits it.
  model?: string;
  choices?: Array<{
    message?: { content?: unknown; tool_calls?: OpenRouterToolCall[] };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  // OpenRouter can relay provider errors in a 200 body (moderation blocks,
  // provider failures after headers were sent).
  error?: { code?: unknown; message?: unknown };
}

// Map OpenAI-style finish_reason onto Anthropic's stop_reason vocabulary so
// recorded traces don't mix vocabularies across transports; unknown values
// pass through transport-native.
const FINISH_TO_STOP: Record<string, string> = { stop: "end_turn", length: "max_tokens" };

// Some providers return message.content as an array of typed parts rather
// than a string. Join the text parts — the same semantics as the anthropic
// client's multi-block join.
function flattenContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts = content
      .filter(
        (p): p is { type: string; text: string } =>
          typeof p === "object" &&
          p !== null &&
          "text" in p &&
          (p as { type?: unknown }).type === "text",
      )
      .map((p) => p.text)
      .filter((t) => typeof t === "string");
    if (parts.length > 0) return parts.join("");
  }
  return undefined;
}

export function createOpenRouterClient(opts?: { fetchImpl?: typeof fetch }): LlmClient {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY env var is required for the openrouter transport");
  }
  const fetchImpl = opts?.fetchImpl ?? fetch;

  // One POST to /chat/completions with the shared failure taxonomy:
  // transport / 5xx / 429 are retryable; other HTTP statuses and embedded
  // 200-body errors keep their existing classification. `complete` and the
  // tool loop both go through here so the two paths cannot drift.
  const postChat = async (
    payload: Record<string, unknown>,
  ): Promise<Result<OpenRouterChatResponse, CortexEvalError>> => {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetchImpl(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      // Transport-level failure (DNS, reset, timeout): transient, retryable.
      const msg = e instanceof Error ? e.message : String(e);
      return err({ kind: "llm", message: `openrouter fetch: ${msg}`, retryable: true });
    }
    if (res.status === 429 || res.status >= 500) {
      return err({ kind: "llm", message: `openrouter http ${res.status}`, retryable: true });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return err({
        kind: "llm",
        message: `openrouter http ${res.status}: ${body.slice(0, 200)}`,
        retryable: false,
      });
    }
    let json: OpenRouterChatResponse;
    try {
      json = (await res.json()) as OpenRouterChatResponse;
    } catch (e) {
      // Body cut mid-stream / malformed JSON on 200: transient, retryable.
      const msg = e instanceof Error ? e.message : String(e);
      return err({ kind: "llm", message: `openrouter body parse: ${msg}`, retryable: true });
    }
    if (json.error) {
      // Error relayed in a 200 body. Surface ITS message; retry only when
      // the embedded code is itself transient.
      const code = typeof json.error.code === "number" ? json.error.code : undefined;
      const msg =
        typeof json.error.message === "string"
          ? json.error.message
          : JSON.stringify(json.error).slice(0, 200);
      return err({
        kind: "llm",
        message: `openrouter error: ${msg}`,
        retryable: code === 429 || (code !== undefined && code >= 500),
      });
    }
    return ok(json);
  };

  const complete = async (o: CompleteOpts): Promise<Result<CompleteResult, CortexEvalError>> => {
    return retry(async () => {
      const json = await postChat({
        model: o.model,
        max_tokens: o.maxTokens ?? 4096,
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
        messages: [
          { role: "system", content: o.system },
          { role: "user", content: o.user },
        ],
      });
      if (!json.ok) return json;
      const choice = json.value.choices?.[0];
      const text = flattenContent(choice?.message?.content);
      if (text === undefined) {
        return err({
          kind: "llm",
          message: "openrouter response carried no message content",
          retryable: false,
        });
      }
      const finish = choice?.finish_reason;
      return ok({
        text,
        input_tokens: json.value.usage?.prompt_tokens ?? 0,
        output_tokens: json.value.usage?.completion_tokens ?? 0,
        stop_reason: finish ? (FINISH_TO_STOP[finish] ?? finish) : "unknown",
        // Served model echoed by the provider (distinct from o.model) and the
        // temperature we actually sent (undefined ⇒ none). Metadata only (6mf.6).
        servedModel: json.value.model,
        effectiveTemperature: o.temperature,
      });
    });
  };

  // Delegates to the shared completeJsonWithRetry so the schema-hint + retry
  // + parseModelJson contract (strict fence-strip then lenient brace-slice)
  // cannot drift between the anthropic and openrouter transports.
  const completeJson = (o: CompleteJsonOpts) => completeJsonWithRetry(complete, o);

  // The OpenAI-style function-calling loop, mirroring the anthropic client's
  // round structure exactly: ask, execute every returned tool call through
  // opts.toolHandler, append the results, repeat until a round returns no
  // tool calls (final answer) or maxRounds is exhausted. Wire-format
  // differences handled here: tools go up as {type:"function",function:{...}},
  // arguments come back JSON-encoded (parsed leniently — a malformed blob is
  // handed to the handler as the raw string rather than dropped), and results
  // go back as role:"tool" messages keyed by tool_call_id.
  const completeWithTools = async (
    o: CompleteWithToolsOpts,
  ): Promise<Result<CompleteWithToolsResult, CortexEvalError>> => {
    const maxRounds = o.maxRounds ?? 12;
    const toolCalls: CompleteWithToolsResult["tool_calls"] = [];
    const messages: unknown[] = [
      { role: "system", content: o.system },
      { role: "user", content: o.user },
    ];
    const tools = o.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    let totalIn = 0;
    let totalOut = 0;

    for (let round = 0; round < maxRounds; round++) {
      const res = await retry(async () =>
        postChat({
          model: o.model,
          max_tokens: o.maxTokens ?? 4096,
          ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
          tools,
          messages,
        }),
      );
      if (!res.ok) return res;
      const json = res.value;
      totalIn += json.usage?.prompt_tokens ?? 0;
      totalOut += json.usage?.completion_tokens ?? 0;
      const choice = json.choices?.[0];
      const message = choice?.message;
      const rawCalls = (message?.tool_calls ?? []).filter(
        (c): c is OpenRouterToolCall & { function: { name: string } } =>
          typeof c?.function?.name === "string",
      );

      if (rawCalls.length === 0) {
        const finish = choice?.finish_reason;
        return ok({
          text: flattenContent(message?.content) ?? "",
          input_tokens: totalIn,
          output_tokens: totalOut,
          stop_reason: finish ? (FINISH_TO_STOP[finish] ?? finish) : "unknown",
          tool_calls: toolCalls,
        });
      }

      // Echo the assistant turn back verbatim (content may be null when the
      // model went straight to tool calls — that is valid on this wire).
      messages.push({
        role: "assistant",
        content: message?.content ?? null,
        tool_calls: message?.tool_calls,
      });

      for (let i = 0; i < rawCalls.length; i++) {
        const tc = rawCalls[i] as OpenRouterToolCall & { function: { name: string } };
        const rawArgs = tc.function.arguments ?? "";
        let input: unknown;
        try {
          input = rawArgs === "" ? {} : JSON.parse(rawArgs);
        } catch {
          input = rawArgs;
        }
        const t0 = Date.now();
        let output: unknown;
        try {
          output = await o.toolHandler(tc.function.name, input);
        } catch (e) {
          output = { tool_error: e instanceof Error ? e.message : String(e) };
        }
        toolCalls.push({
          tool: tc.function.name,
          input,
          output,
          latency_ms: Date.now() - t0,
        });
        messages.push({
          role: "tool",
          // Some providers omit ids on single calls; synthesize a stable one
          // so the echo-back stays well-formed.
          tool_call_id: tc.id ?? `call_${round}_${i}`,
          content: typeof output === "string" ? output : JSON.stringify(output),
        });
      }
    }
    return err({
      kind: "llm",
      message: `exceeded maxRounds (${maxRounds}) without final answer`,
      retryable: false,
    });
  };

  return { complete, completeJson, completeWithTools };
}
