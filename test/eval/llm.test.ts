import { describe, expect, it, vi } from "vitest";
import { createAnthropicClient, type LlmClient } from "../../src/eval/llm.js";

describe("LlmClient interface", () => {
  it("a mock client satisfies the interface", async () => {
    const mock: LlmClient = {
      complete: vi.fn(async () => ({
        ok: true,
        value: { text: "hello", input_tokens: 1, output_tokens: 1, stop_reason: "end_turn" },
      })),
      completeJson: vi.fn(async () => ({
        ok: true,
        value: { parsed: { foo: 1 }, input_tokens: 1, output_tokens: 1, stop_reason: "end_turn" },
      })),
      completeWithTools: vi.fn(),
    };
    const r = await mock.complete({ system: "s", user: "u", model: "claude-sonnet-fake" });
    expect(r.ok).toBe(true);
  });

  it("createAnthropicClient throws if no API key", () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => createAnthropicClient()).toThrow();
    if (prev) process.env.ANTHROPIC_API_KEY = prev;
  });
});
