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
  type LlmClient,
  retry,
  stripCodeFence,
} from "./llm.js";
import type { CortexEvalError } from "./types.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

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

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: unknown }; finish_reason?: string | null }>;
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

  const complete = async (o: CompleteOpts): Promise<Result<CompleteResult, CortexEvalError>> => {
    return retry(async () => {
      let res: Awaited<ReturnType<typeof fetch>>;
      try {
        res = await fetchImpl(`${OPENROUTER_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: o.model,
            max_tokens: o.maxTokens ?? 4096,
            ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
            messages: [
              { role: "system", content: o.system },
              { role: "user", content: o.user },
            ],
          }),
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
      const choice = json.choices?.[0];
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
        input_tokens: json.usage?.prompt_tokens ?? 0,
        output_tokens: json.usage?.completion_tokens ?? 0,
        stop_reason: finish ? (FINISH_TO_STOP[finish] ?? finish) : "unknown",
      });
    });
  };

  const completeJson = async (
    o: CompleteJsonOpts,
  ): Promise<Result<CompleteJsonResult, CortexEvalError>> => {
    // Same contract as createAnthropicClient.completeJson: schema embedded as
    // a system-prompt hint, fence-stripped JSON.parse, shape checks stay with
    // the caller.
    const sysWithSchema = `${o.system}\n\nReturn JSON matching:\n${JSON.stringify(o.schema, null, 2)}\nReturn ONLY JSON, no prose.`;
    const r = await complete({ ...o, system: sysWithSchema });
    if (!r.ok) return r;
    try {
      const parsed = JSON.parse(stripCodeFence(r.value.text));
      return ok({ ...r.value, parsed });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err({
        kind: "llm",
        message: `JSON parse: ${msg} — output was: ${r.value.text.slice(0, 200)}`,
        retryable: false,
      });
    }
  };

  const completeWithTools = async (
    _o: CompleteWithToolsOpts,
  ): Promise<Result<CompleteWithToolsResult, CortexEvalError>> => {
    // Deliberately unimplemented: only `daftari eval` drives tools, and eval
    // stays on the anthropic transport. An untested OpenAI function-calling
    // loop would be riskier than an explicit refusal.
    return err({
      kind: "llm",
      message:
        "completeWithTools is not supported on the openrouter transport — run daftari eval on the anthropic transport",
      retryable: false,
    });
  };

  return { complete, completeJson, completeWithTools };
}
