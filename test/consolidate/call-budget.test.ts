import { describe, expect, it, vi } from "vitest";
import { withCallBudget } from "../../src/consolidate/call-budget.js";
import type { LlmClient } from "../../src/eval/llm.js";
import { ok } from "../../src/frontmatter/types.js";

// A fake LlmClient whose three methods are vi.fn spies returning a trivial ok,
// so we can count how many calls reach the underlying client.
function fakeLlm() {
  const complete = vi.fn(async () => ok({ text: "x" }) as never);
  const completeJson = vi.fn(async () => ok({ json: {} }) as never);
  const completeWithTools = vi.fn(async () => ok({ text: "x" }) as never);
  const llm = { complete, completeJson, completeWithTools } as unknown as LlmClient;
  return { llm, complete, completeJson, completeWithTools };
}

describe("withCallBudget", () => {
  it("delegates the first maxCalls calls, then short-circuits without hitting the client", async () => {
    const { llm, completeJson } = fakeLlm();
    const capped = withCallBudget(llm, 2);

    const r1 = await capped.completeJson({} as never);
    const r2 = await capped.completeJson({} as never);
    const r3 = await capped.completeJson({} as never);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error.message).toContain("budget");
    // The 3rd call never reached the underlying client — that's the spend cap.
    expect(completeJson).toHaveBeenCalledTimes(2);
  });

  it("shares one budget across all call kinds", async () => {
    const { llm, complete, completeJson } = fakeLlm();
    const capped = withCallBudget(llm, 1);

    const first = await capped.completeJson({} as never);
    const second = await capped.complete({} as never);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(completeJson).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(0);
  });

  it("a zero budget blocks every call", async () => {
    const { llm, completeJson } = fakeLlm();
    const capped = withCallBudget(llm, 0);
    const r = await capped.completeJson({} as never);
    expect(r.ok).toBe(false);
    expect(completeJson).toHaveBeenCalledTimes(0);
  });
});
