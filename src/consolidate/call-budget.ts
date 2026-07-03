// A hard ceiling on total LLM calls for one consolidate session.
//
// `--budget` (spec §3.3) is a QUEUE-ITEM budget: it feeds prioritize() and caps
// how many births/edges are dispatched, not how many LLM calls they make. Each
// birth item fans out to ~20 neighbors x 2 orders = up to ~40 completeJson
// calls, so the real spend is (items x fan-out) and `--budget` alone never
// bounds it. This wrapper gives `--max-llm-calls` a real spend cap: it counts
// every underlying call across all three client methods and, once the ceiling
// is reached, short-circuits with a runtime error WITHOUT hitting the network.
//
// birthOne and the revision panel already treat a completeJson error as a
// skipped neighbor / vote, so once the budget is spent the loop drains cheaply
// (no further real calls) rather than crashing.

import type { LlmClient } from "../eval/llm.js";
import type { CortexEvalError } from "../eval/types.js";
import { err, type Result } from "../frontmatter/types.js";

export function withCallBudget(llm: LlmClient, maxCalls: number): LlmClient {
  let used = 0;

  function exhausted<T>(): Result<T, CortexEvalError> {
    return err({
      kind: "runtime",
      message: `LLM call budget exhausted (--max-llm-calls ${maxCalls})`,
    });
  }

  // Reserve a slot synchronously before awaiting, so sequential calls are
  // counted deterministically. Returns false when the budget is spent.
  function take(): boolean {
    if (used >= maxCalls) return false;
    used++;
    return true;
  }

  return {
    complete: (opts) => (take() ? llm.complete(opts) : Promise.resolve(exhausted())),
    completeJson: (opts) => (take() ? llm.completeJson(opts) : Promise.resolve(exhausted())),
    completeWithTools: (opts) =>
      take() ? llm.completeWithTools(opts) : Promise.resolve(exhausted()),
  };
}
