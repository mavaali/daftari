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
}

export interface CompleteJsonResult extends CompleteResult {
  parsed: unknown;
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
      });
    });
  };

  const completeJson = async (
    opts: CompleteJsonOpts,
  ): Promise<Result<CompleteJsonResult, CortexEvalError>> => {
    // The schema is embedded in the system prompt as a hint to the LLM, then
    // the response goes through JSON.parse + a manual shape check by the
    // caller (see generate.ts and score.ts). This is NOT strict JSON Schema
    // validation — there is no schema validator dep in v1. Callers must
    // verify required fields exist after parse. If we ever need strict
    // validation, add `ajv` and validate `parsed` here.
    const sysWithSchema = `${opts.system}\n\nReturn JSON matching:\n${JSON.stringify(opts.schema, null, 2)}\nReturn ONLY JSON, no prose.`;
    const r = await complete({ ...opts, system: sysWithSchema });
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
      if (!r.error || r.error.kind !== "llm" || !r.error.retryable) return r;
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
