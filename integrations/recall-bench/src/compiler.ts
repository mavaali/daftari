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

import { withCallBudget } from "../../../dist/consolidate/call-budget.js";
import { listStagedActions } from "../../../dist/curation/staged-actions.js";
import type { NormalizedMessage } from "../../../dist/distill/adapters/types.js";
import { chunkMessages } from "../../../dist/distill/chunk.js";
import { extractClaims } from "../../../dist/distill/extract.js";
import { proposeAllClaims } from "../../../dist/distill/propose.js";
import type { CompleteWithToolsResult, LlmClient, ToolDef } from "../../../dist/eval/llm.js";
import { vaultRatify } from "../../../dist/tools/staged-actions.js";
import { DISTILL_NUMERIC_DEFAULTS } from "../../../dist/utils/config.js";
import type { ToolCallRecord } from "./answerer.js";
import { AUTHORING_SYSTEM_PROMPT } from "./authoring-prompt.js";
import type { AdapterConfig } from "./config.js";
import type { DayMetadata } from "./types.js";
import { buildWriteToolSurface } from "./write-tools.js";

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
      typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
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
      tools: surface.defs,
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

// The distill compile arm (U10/R16). Runs Daftari's OWN compile-on-ingest
// pipeline — chunk → extract → propose → ratify-to-land — over each benchmark
// day, so recall-bench scores the distiller's compile quality on the fixed,
// reproducible internal compiler (R2), not an authoring-agent loop.
//
// Each day is fed to the pipeline as a single synthetic transcript message
// (the distiller's native input is a chat transcript; a benchmark day is prose,
// so we wrap it — the chunk/extract/propose stages are identical either way).
// The timestamp is derived deterministically from the day's date so chunk
// anchors, and therefore claim_keys and landed paths, are reproducible across
// identical runs. Because a recall-bench query only sees LANDED docs, every
// staged proposal from the run is approved through the same `vault_ratify` path
// a human review would use — distill proposes, ratify disposes, here on
// autopilot for the benchmark.
export function makeDistillCompiler(
  vaultRoot: string,
  cfg: AdapterConfig,
  llm: LlmClient,
): (
  day: number,
  content: string,
  meta: DayMetadata,
  priorDayPaths: string[],
) => Promise<CompileResult> {
  return async (_day: number, content: string, meta: DayMetadata): Promise<CompileResult> => {
    // Split the day into paragraph-level synthetic messages so the chunk windows
    // engage and the extraction input cap cannot silently truncate a long day
    // (one giant single message → the 16k slice would drop its tail unmarked).
    const paragraphs = content
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const bodies = paragraphs.length > 0 ? paragraphs : [content];
    const messages: NormalizedMessage[] = bodies.map((text, i) => ({
      ts: `${meta.date}T12:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
      sender: meta.personaId,
      text,
      type: "text",
      attachment: null,
    }));
    const chunks = chunkMessages(messages);

    // Truncation must be LOUD, not silent: if a chunk still exceeds the input
    // cap, extraction would slice it and lose content with no marker — fail the
    // run rather than quietly confound the recall baseline.
    for (const chunk of chunks) {
      if (chunk.text.length > DISTILL_NUMERIC_DEFAULTS.inCallInputCap) {
        throw new Error(
          `recall-bench distill arm: a chunk on day ${meta.dayNumber} is ${chunk.text.length} ` +
            `chars, over the ${DISTILL_NUMERIC_DEFAULTS.inCallInputCap}-char input cap — it would ` +
            "be silently truncated; the benchmark day needs finer splitting",
        );
      }
    }

    const extracted = await extractClaims(
      chunks,
      withCallBudget(llm, DISTILL_NUMERIC_DEFAULTS.maxLlmCalls),
      {
        model: cfg.authoringModel,
        maxClaims: DISTILL_NUMERIC_DEFAULTS.maxClaims,
        inCallInputCap: DISTILL_NUMERIC_DEFAULTS.inCallInputCap,
      },
    );
    // A confounded baseline is worse than a loud failure: any extraction error or
    // exhausted budget means this day landed partial/zero memory, so the R16 gate
    // number would read as compile quality when it is partly infra failure.
    if (extracted.chunkErrors.length > 0) {
      throw new Error(
        `recall-bench distill arm: ${extracted.chunkErrors.length} extraction error(s) on day ` +
          `${meta.dayNumber}: ${extracted.chunkErrors.map((e) => e.error).join("; ")}`,
      );
    }
    if (extracted.budget_exhausted) {
      throw new Error(
        `recall-bench distill arm: LLM call budget exhausted on day ${meta.dayNumber} — ` +
          "recall baseline would be confounded",
      );
    }

    const sourceId = `day-${meta.dayNumber}`;
    const runId = `rb-distill-day-${meta.dayNumber}`;
    // Stamp each proposal with the benchmark day's own date (not today's) so
    // temporal questions get the right signal and landed content is date-stable.
    const proposal = await proposeAllClaims(vaultRoot, extracted.claims, {
      sourceId,
      runId,
      asOf: meta.date,
    });
    if (proposal.errors.length > 0) {
      throw new Error(
        `recall-bench distill arm: ${proposal.errors.length} claim(s) failed to stage on day ` +
          `${meta.dayNumber}: ${proposal.errors.map((e) => e.error).join("; ")}`,
      );
    }

    // Ratify-to-land: a compiled claim recall-bench can query must be a landed
    // doc, not a draft proposal. Approve every staged action from this run; a
    // ratify failure is loud, not skipped (it would drop a day's memory).
    const notesWritten: string[] = [];
    const pending = await listStagedActions(vaultRoot, "pending");
    if (!pending.ok) throw pending.error;
    for (const action of pending.value) {
      if (action.runId !== runId) continue;
      const ratified = await vaultRatify(vaultRoot, {
        id: action.id,
        decision: "approve",
        principal: "agent:recall-bench",
      });
      if (!ratified.ok) {
        throw new Error(
          `recall-bench distill arm: failed to ratify ${action.id} on day ${meta.dayNumber}: ` +
            ratified.error.message,
        );
      }
      notesWritten.push(action.targetPath);
    }

    return { toolCalls: [], notesWritten };
  };
}
