// src/eval/run.ts
// The answerer loop. For each question, run the answerer LLM k independent
// times against the in-process tool surface, recording a full trace per run.
// Results are keyed by `"${question_index}:${k_index}"` so --resume can skip
// pairs already marked complete and re-run only the rest.

import { err, ok, type Result } from "../frontmatter/types.js";
import type { LlmClient, ToolDef } from "./llm.js";
import { ANSWERER_SYSTEM_PROMPT, PROMPT_VERSION } from "./prompts.js";
import { buildToolSurface } from "./tool-surface.js";
import type { CortexEvalError, EvalRun, PerRunResult, QuestionSet, Trace } from "./types.js";

export interface RunOptions {
  k: number;
  model: string;
  resumeFrom?: EvalRun;
  runId?: string; // stable id the caller controls (so the on-disk file path is stable across the run and resume)
  timestamp?: string; // real timestamp for EvalRun metadata
  persist?: (run: EvalRun) => Promise<void>; // called after every (q,k) status change, enabling --resume
}

export async function runAnswerer(
  questions: QuestionSet,
  vaultRoot: string,
  llm: LlmClient,
  opts: RunOptions,
): Promise<Result<EvalRun, CortexEvalError>> {
  const ts = opts.timestamp ?? "2026-01-01T00:00:00Z";
  const id = opts.resumeFrom?.id ?? opts.runId ?? `${questions.id}-${opts.model}-${ts}`;
  const runs: Record<string, PerRunResult> = { ...(opts.resumeFrom?.runs ?? {}) };

  // Builds the current EvalRun from the live `runs` map. Snapshotting after
  // each (q,k) status change lets the caller persist partial progress, so a
  // failure/crash leaves a resumable file on disk (see --resume).
  const snapshot = (): EvalRun => ({
    id,
    questions_id: questions.id,
    answerer_model: opts.model,
    prompt_version: PROMPT_VERSION,
    timestamp: ts,
    k: opts.k,
    runs,
  });

  const tools = buildToolSurface(vaultRoot);
  const toolDefs: ToolDef[] = tools.defs;

  for (let qi = 0; qi < questions.questions.length; qi++) {
    const q = questions.questions[qi];
    for (let k = 0; k < opts.k; k++) {
      const key = `${qi}:${k}`;
      if (runs[key]?.status === "complete") continue;

      const t0 = Date.now();
      const r = await llm.completeWithTools({
        model: opts.model,
        system: ANSWERER_SYSTEM_PROMPT,
        user: q.question,
        tools: toolDefs,
        toolHandler: tools.handler,
      });
      const wall_ms = Date.now() - t0;
      if (!r.ok) {
        // Mark this pair incomplete, persist the partial run (completed pairs
        // plus this incomplete one), then surface the error. Persisting here
        // is what makes --resume work: progress made before the failure is
        // saved, so a re-run skips the completed pairs and retries the rest.
        runs[key] = {
          question_id: q.id,
          question_index: qi,
          k_index: k,
          status: "incomplete",
          trace: null,
        };
        await opts.persist?.(snapshot());
        return err(r.error);
      }

      const trace: Trace = {
        tool_calls: r.value.tool_calls,
        final_answer: r.value.text,
        total_tool_calls: r.value.tool_calls.length,
        input_tokens: r.value.input_tokens,
        output_tokens: r.value.output_tokens,
        wall_ms,
        stop_reason: r.value.stop_reason,
      };
      runs[key] = {
        question_id: q.id,
        question_index: qi,
        k_index: k,
        status: "complete",
        trace,
      };
      await opts.persist?.(snapshot());
    }
  }

  return ok(snapshot());
}
