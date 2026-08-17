// src/eval/llm.ts
// Single-point wrapper around @anthropic-ai/sdk. Other eval modules depend
// on the LlmClient interface, not the SDK, so they can be unit-tested with
// hand-rolled mocks.

import Anthropic from "@anthropic-ai/sdk";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { CortexEvalError } from "./types.js";

export interface CompleteOpts {
  model: string;
  system: string;
  user: string;
  maxTokens?: number; // default 4096
  // Optional sampling temperature. Omitted ⇒ the SDK sends no temperature and
  // the provider default (1.0) applies. Pinned to 0 for the direction
  // elicitation (foundational-ordering must be deterministic, not creative).
  temperature?: number;
}

export interface CompleteJsonOpts extends CompleteOpts {
  // biome-ignore lint/suspicious/noExplicitAny: JSON Schema is structural
  schema: any;
}

export interface ToolDef {
  name: string;
  description: string;
  // biome-ignore lint/suspicious/noExplicitAny: JSON Schema is structural
  input_schema: any;
}

export interface CompleteWithToolsOpts extends CompleteOpts {
  tools: ToolDef[];
  toolHandler: (name: string, input: unknown) => Promise<unknown>;
  maxRounds?: number; // default 12
}

export interface CompleteResult {
  text: string;
  input_tokens: number;
  output_tokens: number;
  stop_reason: string;
  // --- Optional LLM run metadata (6mf.6) ---------------------------------
  // Additive + optional so every existing caller and hand-rolled mock stays
  // type-valid. Surfaced here (not consumed here) so a later bead can stamp
  // it onto emitted beliefs. Never load-bearing for control flow.
  //
  // The model string the provider actually SERVED for this call — distinct
  // from the requested `opts.model`. Undefined when the transport did not
  // report one.
  servedModel?: string;
  // The temperature ACTUALLY sent to the API for this call. Undefined when no
  // temperature was sent (provider default applies). On completeJsonWithRetry's
  // retry path this is the bumped value (0.2), not the requested temp.
  effectiveTemperature?: number;
}

export interface CompleteJsonResult extends CompleteResult {
  parsed: unknown;
  // True iff this JSON value was salvaged via completeJsonWithRetry's bounded
  // reprompt branch (temp bumped off 0). Only completeJsonWithRetry sets it;
  // undefined elsewhere. false ⇒ first-try success.
  viaRetry?: boolean;
}

export interface CompleteWithToolsResult extends CompleteResult {
  tool_calls: { tool: string; input: unknown; output: unknown; latency_ms: number }[];
}

export interface LlmClient {
  complete(opts: CompleteOpts): Promise<Result<CompleteResult, CortexEvalError>>;
  completeJson(opts: CompleteJsonOpts): Promise<Result<CompleteJsonResult, CortexEvalError>>;
  completeWithTools(
    opts: CompleteWithToolsOpts,
  ): Promise<Result<CompleteWithToolsResult, CortexEvalError>>;
}

// `injected` lets tests substitute a stand-in SDK client so the create call is
// observable; production passes nothing and a real Anthropic instance is built.
export function createAnthropicClient(injected?: Pick<Anthropic, "messages">): LlmClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is required for daftari eval");
  const client = injected ?? new Anthropic({ apiKey });

  const complete = async (opts: CompleteOpts): Promise<Result<CompleteResult, CortexEvalError>> => {
    return retry(async () => {
      const res = await client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        system: opts.system,
        messages: [{ role: "user", content: opts.user }],
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      });
      const text = res.content
        .filter((b): b is { type: "text"; text: string; citations: null } => b.type === "text")
        .map((b) => b.text)
        .join("");
      return ok({
        text,
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        stop_reason: res.stop_reason ?? "unknown",
        // The served model the API returned (distinct from opts.model) and the
        // temperature we actually sent (undefined ⇒ none sent). Metadata only.
        servedModel: res.model,
        effectiveTemperature: opts.temperature,
      });
    });
  };

  // The schema is embedded in the system prompt as a hint to the LLM (see
  // completeJsonWithRetry), then the response goes through parseModelJson + a
  // manual shape check by the caller (see generate.ts and score.ts). This is
  // NOT strict JSON Schema validation — there is no schema validator dep in v1.
  // Callers must verify required fields exist after parse.
  const completeJson = (opts: CompleteJsonOpts) => completeJsonWithRetry(complete, opts);

  const completeWithTools = async (
    opts: CompleteWithToolsOpts,
  ): Promise<Result<CompleteWithToolsResult, CortexEvalError>> => {
    const maxRounds = opts.maxRounds ?? 12;
    const toolCalls: CompleteWithToolsResult["tool_calls"] = [];
    const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
      { role: "user", content: opts.user },
    ];
    let totalIn = 0;
    let totalOut = 0;
    let lastStop = "unknown";

    for (let round = 0; round < maxRounds; round++) {
      const res = await retry(async () =>
        ok(
          await client.messages.create({
            model: opts.model,
            max_tokens: opts.maxTokens ?? 4096,
            system: opts.system,
            // biome-ignore lint/suspicious/noExplicitAny: SDK types
            tools: opts.tools as any,
            // biome-ignore lint/suspicious/noExplicitAny: SDK types
            messages: messages as any,
            ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          }),
        ),
      );
      if (!res.ok) return res;
      const message = res.value;
      totalIn += message.usage.input_tokens;
      totalOut += message.usage.output_tokens;
      lastStop = message.stop_reason ?? "unknown";

      // biome-ignore lint/suspicious/noExplicitAny: SDK content union
      const blocks = message.content as any[];
      const toolUses = blocks.filter((b) => b.type === "tool_use");
      if (toolUses.length === 0) {
        const text = blocks
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
        return ok({
          text,
          input_tokens: totalIn,
          output_tokens: totalOut,
          stop_reason: lastStop,
          tool_calls: toolCalls,
        });
      }

      messages.push({ role: "assistant", content: blocks });

      const toolResults: unknown[] = [];
      for (const tu of toolUses) {
        const t0 = Date.now();
        let output: unknown;
        try {
          output = await opts.toolHandler(tu.name, tu.input);
        } catch (e) {
          output = { tool_error: e instanceof Error ? e.message : String(e) };
        }
        const latency = Date.now() - t0;
        toolCalls.push({ tool: tu.name, input: tu.input, output, latency_ms: latency });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: typeof output === "string" ? output : JSON.stringify(output),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }
    return err({
      kind: "llm",
      message: `exceeded maxRounds (${maxRounds}) without final answer`,
      retryable: false,
    });
  };

  return { complete, completeJson, completeWithTools };
}

// --- helpers ---

const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 60_000;

// Exported for unit testing — these two pure helpers carry the trickiest logic
// in this module (retry arithmetic/predicate, fence stripping) and would
// otherwise be unreachable, since createAnthropicClient news up the SDK.
export async function retry<T>(
  fn: () => Promise<Result<T, CortexEvalError>>,
): Promise<Result<T, CortexEvalError>> {
  let lastErr: CortexEvalError | null = null;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const r = await fn();
      if (r.ok) return r;
      if (r.error?.kind !== "llm" || !r.error.retryable) return r;
      lastErr = r.error;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = (e as { status?: number })?.status;
      const retryable = status === 429 || (typeof status === "number" && status >= 500);
      if (!retryable) return err({ kind: "llm", message: msg, retryable: false });
      lastErr = { kind: "llm", message: msg, retryable: true };
    }
    // Don't sleep after the final attempt — the loop is about to exit and
    // surface the error; a trailing backoff would just delay the failure.
    if (i < MAX_RETRIES - 1) {
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** i, MAX_BACKOFF_MS);
      await new Promise((res) => setTimeout(res, backoff));
    }
  }
  return err(lastErr ?? { kind: "llm", message: "retries exhausted", retryable: false });
}

export function stripCodeFence(s: string): string {
  const m = s.match(/^```(?:json)?\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : s;
}

// Narrow a noisy completion to its most likely JSON payload: prefer the first
// fenced ```json block anywhere in the text, else the raw text; then slice to
// the outermost object/array (`{..}` or `[..]`), which drops leading reasoning
// preamble and trailing prose. For already-clean JSON this returns it verbatim.
function extractJsonCandidate(text: string): string {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/i);
  const body = (fence ? fence[1] : text).trim();
  const objAt = body.indexOf("{");
  const arrAt = body.indexOf("[");
  let start = -1;
  let closer = "";
  if (objAt !== -1 && (arrAt === -1 || objAt < arrAt)) {
    start = objAt;
    closer = "}";
  } else if (arrAt !== -1) {
    start = arrAt;
    closer = "]";
  }
  if (start === -1) return body;
  const end = body.lastIndexOf(closer);
  return end > start ? body.slice(start, end + 1) : body.slice(start);
}

/**
 * Parse JSON from a model completion, tolerating the wrappers that local /
 * OpenAI-compatible models (e.g. Ollama) add. Strict path first — stripCodeFence
 * + JSON.parse, the historical behavior, unchanged for clean or whole-string
 * fenced output. On failure, a lenient fallback recovers JSON from a fenced
 * block placed after reasoning preamble, or a bare object/array surrounded by
 * prose. Throws when no valid JSON can be recovered; the caller classifies it.
 */
export function parseModelJson(text: string): unknown {
  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    // Strict parse failed — fall through to lenient recovery below.
  }
  return JSON.parse(extractJsonCandidate(text));
}

/**
 * Run a `completeJson` exchange with one bounded reprompt on parse failure.
 * Local / OpenAI-compatible models (e.g. Ollama) occasionally emit a degenerate
 * ("say") or truncated generation that no parser can recover. A single retry
 * that (a) reminds the model to return ONLY raw JSON and (b) nudges temperature
 * off 0 — temp 0 is deterministic, so a plain retry would repeat the same broken
 * output — recovers most of that tail. Both LlmClient transports delegate here
 * so the schema-hint + retry contract cannot drift between them.
 */
export async function completeJsonWithRetry(
  complete: (opts: CompleteOpts) => Promise<Result<CompleteResult, CortexEvalError>>,
  opts: CompleteJsonOpts,
): Promise<Result<CompleteJsonResult, CortexEvalError>> {
  const sysWithSchema = `${opts.system}\n\nReturn JSON matching:\n${JSON.stringify(opts.schema, null, 2)}\nReturn ONLY JSON, no prose.`;

  const first = await complete({ ...opts, system: sysWithSchema });
  if (!first.ok) return first;
  try {
    // First-try success: viaRetry:false, effective temp = the requested temp
    // (which is exactly what the underlying complete() reported). servedModel
    // carries from the call that produced the returned value (this one).
    return ok({ ...first.value, parsed: parseModelJson(first.value.text), viaRetry: false });
  } catch {
    // First reply was unparseable — fall through to one bounded reprompt.
  }

  const retrySys = `${sysWithSchema}\n\nYour previous reply was NOT valid JSON. Return ONLY the raw JSON value — no prose, no explanation, no markdown code fences.`;
  const retryTemp = (opts.temperature ?? 0) === 0 ? 0.2 : opts.temperature;
  const second = await complete({ ...opts, system: retrySys, temperature: retryTemp });
  if (!second.ok) return second;
  try {
    // Salvaged via retry: viaRetry:true. effectiveTemperature is the bumped
    // temp the retry call actually sent (second.value.effectiveTemperature),
    // NOT the requested temp; servedModel carries from this second call.
    return ok({ ...second.value, parsed: parseModelJson(second.value.text), viaRetry: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err({
      kind: "llm",
      message: `JSON parse (after retry): ${msg} — output was: ${second.value.text.slice(0, 200)}`,
      retryable: false,
    });
  }
}
