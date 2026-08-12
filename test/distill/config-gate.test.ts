// Tests for the distill module's internal LLM client construction and the
// `distill:` config gate (U2).
//
// Three scenarios:
//   1. Config WITH a `distill:` block  → client resolves successfully.
//   2. Config MISSING the `distill:` block → error with a clear "distill not
//      configured" message; zero LLM constructor calls.
//   3. Missing API key for the resolved transport → fail-fast before any spend.
//
// Both LLM constructors are mocked so no real API call happens.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/eval/llm.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/eval/llm.js")>("../../src/eval/llm.js");
  return {
    ...actual,
    createAnthropicClient: vi.fn(() => ({
      complete: vi.fn(),
      completeJson: vi.fn(),
      completeWithTools: vi.fn(),
    })),
  };
});

vi.mock("../../src/eval/llm-openrouter.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/eval/llm-openrouter.js")>(
    "../../src/eval/llm-openrouter.js",
  );
  return {
    ...actual,
    createOpenRouterClient: vi.fn(() => ({
      complete: vi.fn(),
      completeJson: vi.fn(),
      completeWithTools: vi.fn(),
    })),
  };
});

const { resolveDistillClient } = await import("../../src/distill/index.js");
const llmMod = await import("../../src/eval/llm.js");
const orMod = await import("../../src/eval/llm-openrouter.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"];

function writeConfig(yaml: string): void {
  mkdirSync(join(dir, ".daftari"), { recursive: true });
  writeFileSync(join(dir, ".daftari", "config.yaml"), yaml, "utf-8");
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "daftari-distill-gate-"));
  vi.mocked(llmMod.createAnthropicClient).mockClear();
  vi.mocked(orMod.createOpenRouterClient).mockClear();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ---------------------------------------------------------------------------
// Scenario 1: `distill:` block present → resolves successfully
// ---------------------------------------------------------------------------

describe("resolveDistillClient — distill block present", () => {
  it("returns a client without error when distill block is configured", () => {
    writeConfig(
      [
        "version: 1",
        "distill:",
        "  model: claude-haiku-4-5",
        "  max_llm_calls: 50",
        "  max_claims: 20",
        "  max_verbatim_chars: 4000",
        "  in_call_input_cap: 8000",
      ].join("\n"),
    );
    process.env.ANTHROPIC_API_KEY = "test-key";

    const result = resolveDistillClient(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.client).toBeDefined();
    expect(result.value.config.model).toBe("claude-haiku-4-5");
    expect(result.value.config.maxLlmCalls).toBe(50);
    expect(result.value.config.maxClaims).toBe(20);
    expect(result.value.config.maxVerbatimChars).toBe(4000);
    expect(result.value.config.inCallInputCap).toBe(8000);
    expect(llmMod.createAnthropicClient).toHaveBeenCalledTimes(1);
  });

  it("constructs the client using the anthropic transport by default", () => {
    writeConfig(["version: 1", "distill:", "  model: claude-haiku-4-5"].join("\n"));
    process.env.ANTHROPIC_API_KEY = "test-key";

    const result = resolveDistillClient(dir);

    expect(result.ok).toBe(true);
    expect(llmMod.createAnthropicClient).toHaveBeenCalledTimes(1);
    expect(orMod.createOpenRouterClient).not.toHaveBeenCalled();
  });

  it("uses defaults for omitted numeric fields when distill block is present", () => {
    writeConfig(["version: 1", "distill:", "  model: claude-haiku-4-5"].join("\n"));
    process.env.ANTHROPIC_API_KEY = "test-key";

    const result = resolveDistillClient(dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // defaults must be positive — structural check, not pinning exact values
    expect(result.value.config.maxLlmCalls).toBeGreaterThan(0);
    expect(result.value.config.maxClaims).toBeGreaterThan(0);
    expect(result.value.config.maxVerbatimChars).toBeGreaterThan(0);
    expect(result.value.config.inCallInputCap).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: `distill:` block absent → refuse to run; zero LLM calls
// ---------------------------------------------------------------------------

describe("resolveDistillClient — distill block absent", () => {
  it("returns an error containing 'distill' when the block is missing", () => {
    writeConfig("version: 1\n");
    process.env.ANTHROPIC_API_KEY = "test-key";

    const result = resolveDistillClient(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message.toLowerCase()).toMatch(/distill/);
  });

  it("makes zero LLM constructor calls when the distill block is absent", () => {
    writeConfig("version: 1\n");
    process.env.ANTHROPIC_API_KEY = "test-key";

    resolveDistillClient(dir);

    expect(llmMod.createAnthropicClient).not.toHaveBeenCalled();
    expect(orMod.createOpenRouterClient).not.toHaveBeenCalled();
  });

  it("returns an error even if all keys are set when the block is absent", () => {
    writeConfig("version: 1\n");
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    const result = resolveDistillClient(dir);

    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: Missing API key → fail-fast before any spend
// ---------------------------------------------------------------------------

describe("resolveDistillClient — missing API key", () => {
  it("returns an error mentioning ANTHROPIC_API_KEY when key is absent", () => {
    writeConfig(["version: 1", "distill:", "  model: claude-haiku-4-5"].join("\n"));
    // ANTHROPIC_API_KEY deliberately not set

    const result = resolveDistillClient(dir);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("does not call the client constructor when the API key is missing", () => {
    writeConfig(["version: 1", "distill:", "  model: claude-haiku-4-5"].join("\n"));

    resolveDistillClient(dir);

    // The constructor throws on missing key; the fail-fast guard must catch it
    // BEFORE the constructor is reached or the mock would still be called.
    // Either zero calls (guard ran first) or the mock absorbed the throw — both
    // mean no real network spend. We assert zero calls since our constructLlm
    // pattern checks the env var before calling the constructor.
    expect(llmMod.createAnthropicClient).not.toHaveBeenCalled();
  });
});
