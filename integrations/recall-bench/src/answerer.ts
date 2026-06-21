// Per-question agent loop for the Recall Bench adapter.
//
// Reuses daftari's eval machinery verbatim: buildToolSurface gives the LLM the
// same read-only Daftari tool surface the cortex eval uses, and the LlmClient
// drives the tool loop. The answerer does NOT re-implement retrieval or
// rewrite what the model sees.
//
// NO-FLATTEN CONSTRAINT (load-bearing): the tool surface passes structured tool
// output (including decay/superseded_by) to the model verbatim. We never
// post-process hits or inline those structured fields into prose.
// extractRetrieval reads ONLY {path,score,snippet} for the benchmark's
// retrieval metric — it does not mutate, reorder, or enrich the model's view.

import { buildToolSurface } from "../../../dist/eval/tool-surface.js";
import { createAnthropicClient, type LlmClient } from "../../../dist/eval/llm.js";
import { ANSWERER_SYSTEM_PROMPT } from "../../../dist/eval/prompts.js";
import type { AdapterConfig } from "./config.js";

export interface RetrievalEntry {
  path: string;
  score: number;
  snippet: string;
}

export interface ToolCallRecord {
  tool: string;
  args: Record<string, unknown>;
  resultPreview: string;
}

export interface AnswerResult {
  answer: string;
  retrieval: RetrievalEntry[];
  toolCalls: ToolCallRecord[];
}

// A single tool_call entry as recorded by LlmClient.completeWithTools.
interface ToolCallEntry {
  tool: string;
  input: unknown;
  output: unknown;
  latency_ms: number;
}

// Structural guard for a vault_search success output: a HybridSearchResult has
// an array of hits. A {tool_error} envelope or any non-hits shape is skipped.
function hasHits(output: unknown): output is { hits: unknown[] } {
  return (
    typeof output === "object" &&
    output !== null &&
    Array.isArray((output as { hits?: unknown }).hits)
  );
}

// Reads {path,score,snippet} off a single hit. Returns null for malformed hits.
function readHit(hit: unknown): RetrievalEntry | null {
  if (typeof hit !== "object" || hit === null) return null;
  const h = hit as Record<string, unknown>;
  if (typeof h.path !== "string") return null;
  const score = typeof h.score === "number" ? h.score : 0;
  const snippet = typeof h.snippet === "string" ? h.snippet : "";
  return { path: h.path, score, snippet };
}

// Union all vault_search hits across the tool calls, dedup by path keeping the
// max score. Reads only {path,score,snippet} — never the structured fields.
export function extractRetrieval(toolCalls: ToolCallEntry[]): RetrievalEntry[] {
  const byPath = new Map<string, RetrievalEntry>();
  for (const call of toolCalls) {
    if (call.tool !== "vault_search") continue;
    if (!hasHits(call.output)) continue; // skips {tool_error} and shapes lacking .hits
    for (const raw of call.output.hits) {
      const entry = readHit(raw);
      if (entry === null) continue;
      const prior = byPath.get(entry.path);
      if (prior === undefined || entry.score > prior.score) {
        byPath.set(entry.path, entry);
      }
    }
  }
  return [...byPath.values()];
}

export function makeAnswerer(
  vaultRoot: string,
  cfg: AdapterConfig,
  llm: LlmClient = createAnthropicClient(),
): (question: string) => Promise<AnswerResult> {
  const surface = buildToolSurface(vaultRoot);

  return async (question: string): Promise<AnswerResult> => {
    const res = await llm.completeWithTools({
      model: cfg.answererModel,
      system: ANSWERER_SYSTEM_PROMPT,
      user: question,
      tools: surface.defs,
      toolHandler: surface.handler,
      maxRounds: cfg.agentMaxIterations,
    });
    if (!res.ok) throw res.error;

    const toolCalls = res.value.tool_calls as ToolCallEntry[];

    const retrieval = extractRetrieval(toolCalls);

    const recordedCalls: ToolCallRecord[] = toolCalls.map((c) => ({
      tool: c.tool,
      args: (c.input ?? {}) as Record<string, unknown>,
      resultPreview: JSON.stringify(c.output).slice(0, 200),
    }));

    return {
      answer: res.value.text,
      retrieval,
      toolCalls: recordedCalls,
    };
  };
}
