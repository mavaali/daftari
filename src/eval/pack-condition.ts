// src/eval/pack-condition.ts
// The pack answerer (spec 2026-07-26-context-packs-progressive-disclosure-
// design.md, Decision 4 / final plan Phase 3.1). Per (question, k): build a
// vault_context brief in-process, hand it to the answerer LLM as its ONLY
// context (no tools), and record a normal Trace so gradeAnswer and
// aggregateScore run completely unchanged. Same persist/--resume shape as
// runAnswerer (src/eval/run.ts) — the two conditions are siblings, not one
// extending the other, so a pack run never accidentally inherits a tool-loop
// assumption.
//
// access is passed as `undefined` to vaultContext, mirroring
// tool-surface.ts's established posture: eval runs locally against a
// snapshot, there is no caller identity. vault_context is intentionally NOT
// added to the eval tool-loop surface (src/eval/tool-surface.ts) — the
// baseline `tools` condition stays a clean control, uncontaminated by the
// very capability this condition measures.

import { err, ok, type Result } from "../frontmatter/types.js";
import { vaultContext } from "../tools/context.js";
import type { LlmClient } from "./llm.js";
import { PACK_ANSWERER_SYSTEM_PROMPT, PROMPT_VERSION } from "./prompts.js";
import type { CortexEvalError, EvalRun, PerRunResult, QuestionSet, Trace } from "./types.js";

export interface PackRunOptions {
  k: number;
  model: string;
  budget: number;
  resumeFrom?: EvalRun;
  runId?: string; // stable id the caller controls, mirrors RunOptions.runId
  timestamp?: string;
  persist?: (run: EvalRun) => Promise<void>;
}

export async function runPackAnswerer(
  questions: QuestionSet,
  vaultRoot: string,
  llm: LlmClient,
  opts: PackRunOptions,
): Promise<Result<EvalRun, CortexEvalError>> {
  const ts = opts.timestamp ?? "2026-01-01T00:00:00Z";
  const id =
    opts.resumeFrom?.id ?? opts.runId ?? `${questions.id}-${opts.model}-pack-b${opts.budget}-${ts}`;
  const runs: Record<string, PerRunResult> = { ...(opts.resumeFrom?.runs ?? {}) };

  const snapshot = (): EvalRun => ({
    id,
    questions_id: questions.id,
    answerer_model: opts.model,
    prompt_version: PROMPT_VERSION,
    timestamp: ts,
    k: opts.k,
    runs,
    condition: "pack",
    pack_budget: opts.budget,
  });

  for (let qi = 0; qi < questions.questions.length; qi++) {
    const q = questions.questions[qi];
    for (let k = 0; k < opts.k; k++) {
      const key = `${qi}:${k}`;
      if (runs[key]?.status === "complete") continue;

      const t0 = Date.now();
      const packResult = await vaultContext(
        vaultRoot,
        { task: q.question, budget: opts.budget },
        undefined,
      );
      if (!packResult.ok) {
        runs[key] = {
          question_id: q.id,
          question_index: qi,
          k_index: k,
          status: "incomplete",
          trace: null,
        };
        await opts.persist?.(snapshot());
        return err({ kind: "runtime", message: packResult.error.message });
      }
      const pack = packResult.value;

      const r = await llm.complete({
        model: opts.model,
        system: PACK_ANSWERER_SYSTEM_PROMPT,
        user: pack.brief,
      });
      const wall_ms = Date.now() - t0;
      if (!r.ok) {
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
        tool_calls: [],
        final_answer: r.value.text,
        total_tool_calls: 0,
        input_tokens: r.value.input_tokens,
        output_tokens: r.value.output_tokens,
        wall_ms,
        stop_reason: r.value.stop_reason,
        pack: {
          budget: pack.budget,
          estimated_tokens: pack.estimatedTokens,
          included_paths: pack.manifest.included.map((e) => e.path),
        },
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
