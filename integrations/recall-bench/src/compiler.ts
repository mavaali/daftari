// Authoring compiler loop for the Recall Bench adapter.
//
// Compiles one ingested benchmark day into daftari notes by running the
// AUTHORING_SYSTEM_PROMPT agent against the write-capable tool surface.
// Supersede calls are gated: only paths in priorDayPaths may be superseded,
// enforcing the stream-ordering contract (a day may only supersede prior days,
// never same-day or future material).
//
// The supersede guard is extracted as wrapHandlerWithSupersede so it is unit-
// testable without a real vault: inject a spy inner handler, assert the spy
// was (or was not) called, inspect the returned rejection object.

import type { LlmClient, CompleteWithToolsResult, ToolDef } from "../../../dist/eval/llm.js";
import { AUTHORING_SYSTEM_PROMPT } from "./authoring-prompt.js";
import { buildWriteToolSurface } from "./write-tools.js";
import type { AdapterConfig } from "./config.js";
import type { DayMetadata } from "./types.js";
import type { ToolCallRecord } from "./answerer.js";

export interface CompileResult {
  toolCalls: ToolCallRecord[];
  notesWritten: string[];
}

// The tool-surface handler signature.
type ToolHandler = (name: string, input: unknown) => Promise<unknown>;

// A single tool_call entry as recorded by LlmClient.completeWithTools.
type ToolCallEntry = CompleteWithToolsResult["tool_calls"][number];

// Wraps a tool handler with a supersede guard.
//
// When the agent calls vault_supersede:
//   - If old_path is in priorDayPaths → dispatch to innerHandler (allowed).
//   - If old_path is NOT in priorDayPaths → do NOT dispatch; return a
//     tool_error record so the agent sees the rejection.
//
// All other tools pass through to innerHandler unconditionally.
//
// Exported for hermetic unit testing (no real vault needed).
export function wrapHandlerWithSupersede(
  innerHandler: ToolHandler,
  priorDayPaths: string[],
): ToolHandler {
  const allowed = new Set(priorDayPaths);

  return async (name: string, input: unknown): Promise<unknown> => {
    if (name !== "vault_supersede") {
      return innerHandler(name, input);
    }

    const inp =
      typeof input === "object" && input !== null
        ? (input as Record<string, unknown>)
        : {};
    const oldPath = typeof inp.old_path === "string" ? inp.old_path : undefined;

    if (oldPath === undefined || !allowed.has(oldPath)) {
      // Reject: old_path not in priorDayPaths (or missing). Return a tool_error
      // so the agent sees a clear rejection rather than a silent no-op.
      return {
        tool_error:
          `vault_supersede rejected: old_path "${oldPath ?? "(missing)"}" is not in priorDayPaths. ` +
          `Only paths from prior days may be superseded. priorDayPaths = [${[...allowed].join(", ")}]`,
      };
    }

    return innerHandler(name, input);
  };
}

// Builds the user message for the authoring agent. Includes the raw daily
// content and lists the prior-day paths that already exist in the vault (which
// the agent is permitted to supersede).
function buildUserMessage(
  day: number,
  content: string,
  meta: DayMetadata,
  priorDayPaths: string[],
): string {
  const header = [
    `## Day ${day} — ${meta.date} (persona: ${meta.personaId})`,
    `Active arcs: ${meta.activeArcs.join(", ") || "(none)"}`,
    "",
    "### Raw daily log",
    content,
  ].join("\n");

  const priorSection =
    priorDayPaths.length === 0
      ? "No prior-day pages exist yet. Do not call vault_supersede."
      : [
          "### Pages from prior days (may be superseded)",
          ...priorDayPaths.map((p) => `- ${p}`),
        ].join("\n");

  return `${header}\n\n${priorSection}`;
}

// Factory: returns a compiler function bound to the given vault, config, and
// LLM client. Each call compiles one day.
//
// day            — benchmark day number (1-indexed)
// content        — raw daily log text
// meta           — benchmark day metadata
// priorDayPaths  — paths of notes written on prior days; only these may be
//                  superseded. Accumulate across days by passing notesWritten
//                  from prior CompileResults.
export function makeCompiler(
  vaultRoot: string,
  cfg: AdapterConfig,
  llm: LlmClient,
): (
  day: number,
  content: string,
  meta: DayMetadata,
  priorDayPaths: string[],
) => Promise<CompileResult> {
  return async (
    day: number,
    content: string,
    meta: DayMetadata,
    priorDayPaths: string[],
  ): Promise<CompileResult> => {
    const surface = buildWriteToolSurface(vaultRoot);
    const guardedHandler = wrapHandlerWithSupersede(surface.handler, priorDayPaths);

    const userMessage = buildUserMessage(day, content, meta, priorDayPaths);

    const res = await llm.completeWithTools({
      model: cfg.authoringModel,
      system: AUTHORING_SYSTEM_PROMPT,
      user: userMessage,
      // WriteSurface.defs is typed as ToolDefinition[] but the runtime objects
      // satisfy ToolDef (input_schema is mapped by buildToolSurface under the
      // hood). Cast to align the two type worlds without modifying write-tools.ts.
      tools: surface.defs as unknown as ToolDef[],
      toolHandler: guardedHandler,
      maxRounds: cfg.agentMaxIterations,
    });

    if (!res.ok) throw res.error;

    const rawCalls = res.value.tool_calls as ToolCallEntry[];

    // notesWritten: collect path args of successful vault_write calls.
    // A call is successful when its output does NOT contain tool_error.
    const notesWritten: string[] = [];
    for (const call of rawCalls) {
      if (call.tool !== "vault_write") continue;
      const inp =
        typeof call.input === "object" && call.input !== null
          ? (call.input as Record<string, unknown>)
          : {};
      if (typeof inp.path !== "string") continue;
      // Check for a tool_error in output; if present, skip.
      const out =
        typeof call.output === "object" && call.output !== null
          ? (call.output as Record<string, unknown>)
          : {};
      if ("tool_error" in out) continue;
      notesWritten.push(inp.path);
    }

    const toolCalls: ToolCallRecord[] = rawCalls.map((c) => ({
      tool: c.tool,
      args: (c.input ?? {}) as Record<string, unknown>,
      resultPreview: (JSON.stringify(c.output) ?? "").slice(0, 200),
    }));

    return { toolCalls, notesWritten };
  };
}
