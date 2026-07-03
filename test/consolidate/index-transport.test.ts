// --transport wiring for `daftari consolidate`: flag/env selection between the
// anthropic and openrouter LlmClient transports, per-transport key gating, and
// the per-transport default model. Both client constructors are mocked; no
// real API call happens.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "../../src/frontmatter/types.js";

// A deterministic mock client: birth's foundational-ordering verdict (both
// orders agree → directed edge), revision's survives verdict. Mirrors the
// stage2 harness.
function mockClient() {
  return {
    complete: vi.fn(),
    completeJson: vi.fn(async (opts: { user: string }) => {
      const isRevision = /\[template:/.test(opts.user);
      const docIsB = /DOC A \(path: b\.md\)/.test(opts.user);
      const verdict = isRevision
        ? { verdict: "survives", reason: "mock revision survives" }
        : { related: true, premise: docIsB ? "B" : "A", reason: "mock birth premise" };
      return ok({
        text: JSON.stringify(verdict),
        parsed: verdict,
        input_tokens: 200,
        output_tokens: 30,
        stop_reason: "end_turn",
      });
    }),
    completeWithTools: vi.fn(),
  };
}

vi.mock("../../src/eval/llm.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/eval/llm.js")>("../../src/eval/llm.js");
  return { ...actual, createAnthropicClient: vi.fn(() => mockClient()) };
});

vi.mock("../../src/eval/llm-openrouter.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/eval/llm-openrouter.js")>(
    "../../src/eval/llm-openrouter.js",
  );
  // Keep the real resolveTransport — the wiring under test — mock only the
  // constructor so no key/network is needed once gating passes.
  return { ...actual, createOpenRouterClient: vi.fn(() => mockClient()) };
});

vi.mock("../../src/tools/search.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/tools/search.js")>(
    "../../src/tools/search.js",
  );
  return {
    ...actual,
    vaultSearchRelated: vi.fn(async () =>
      ok({ count: 1, hits: [{ path: "b.md", collection: "c", score: 0.9 }] }),
    ),
  };
});

const { runConsolidate } = await import("../../src/consolidate/index.js");
const llmMod = await import("../../src/eval/llm.js");
const orMod = await import("../../src/eval/llm-openrouter.js");

let dir: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "DAFTARI_LLM_TRANSPORT"];

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "daftari-transport-"));
  mkdirSync(join(dir, ".daftari"), { recursive: true });
  // shadow_mode on so no live edge writes happen during these wiring tests.
  writeFileSync(join(dir, ".daftari", "config.yaml"), "version: 1\nshadow_mode: true\n");
  const fm = (title: string) =>
    `---\ntitle: ${title}\ndomain: accumulation\ncollection: c\nstatus: canonical\nconfidence: high\ncreated: 2026-06-17\nupdated: 2026-06-17\nupdated_by: agent:test\nprovenance: direct\nsources: []\nsuperseded_by: null\nttl_days: 90\ntags: []\n---\n# ${title}\n`;
  writeFileSync(join(dir, "a.md"), fm("A"));
  writeFileSync(join(dir, "b.md"), fm("B"));
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

function captureStdout(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  return { out, restore: () => spy.mockRestore() };
}

describe("--transport selection", () => {
  it("--transport=invalid → exit 2", async () => {
    const code = await runConsolidate(["--vault", dir, "--mode", "birth", "--transport", "lol"]);
    expect(code).toBe(2);
  });

  it("--transport openrouter without OPENROUTER_API_KEY → exit 2 (not an ANTHROPIC complaint)", async () => {
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      errs.push(String(s));
      return true;
    });
    const code = await runConsolidate([
      "--vault",
      dir,
      "--mode",
      "birth",
      "--transport",
      "openrouter",
    ]);
    spy.mockRestore();
    expect(code).toBe(2);
    expect(errs.join("")).toMatch(/OPENROUTER_API_KEY/);
    expect(errs.join("")).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it("--transport openrouter constructs the openrouter client, not anthropic, and defaults the model to the openrouter slug", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { out, restore } = captureStdout();
    const code = await runConsolidate([
      "--vault",
      dir,
      "--mode",
      "birth",
      "--transport",
      "openrouter",
    ]);
    restore();
    expect([0, 4]).toContain(code);
    expect(orMod.createOpenRouterClient).toHaveBeenCalledTimes(1);
    expect(llmMod.createAnthropicClient).not.toHaveBeenCalled();
    const text = out.join("");
    expect(text).toMatch(/anthropic\/claude-haiku-4\.5/);
    // The openrouter default model has its own pricing row — no fallback flag.
    expect(text).not.toMatch(/pricing_fallback/);
  });

  it("DAFTARI_LLM_TRANSPORT=openrouter selects openrouter without a flag", async () => {
    process.env.DAFTARI_LLM_TRANSPORT = "openrouter";
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { restore } = captureStdout();
    const code = await runConsolidate(["--vault", dir, "--mode", "birth"]);
    restore();
    expect([0, 4]).toContain(code);
    expect(orMod.createOpenRouterClient).toHaveBeenCalledTimes(1);
    expect(llmMod.createAnthropicClient).not.toHaveBeenCalled();
  });

  it("default (no flag, no env) stays on anthropic — existing behavior unchanged", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const { restore } = captureStdout();
    const code = await runConsolidate(["--vault", dir, "--mode", "birth"]);
    restore();
    expect([0, 4]).toContain(code);
    expect(llmMod.createAnthropicClient).toHaveBeenCalledTimes(1);
    expect(orMod.createOpenRouterClient).not.toHaveBeenCalled();
  });

  it("--report decorrelation --transport openrouter gates on OPENROUTER_API_KEY, never ANTHROPIC (C1)", async () => {
    // No keys set at all: the report path must complain about the SELECTED
    // transport's key, not unconditionally about ANTHROPIC_API_KEY. A minimal
    // valid fixture gets us past fixture parsing to the key gate.
    const fixturePath = join(dir, "fixture.json");
    writeFileSync(
      fixturePath,
      JSON.stringify({
        version: 1,
        edges: [
          {
            id: "e1",
            fromPath: "a.md",
            toPath: "b.md",
            fromContent: "x",
            toContent: "y",
            truth: "derives",
          },
        ],
      }),
    );
    const errs: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      errs.push(String(s));
      return true;
    });
    const code = await runConsolidate([
      "--report",
      "decorrelation",
      "--fixture",
      fixturePath,
      "--transport",
      "openrouter",
    ]);
    spy.mockRestore();
    expect(code).toBe(2);
    expect(errs.join("")).toMatch(/OPENROUTER_API_KEY/);
    expect(errs.join("")).not.toMatch(/ANTHROPIC_API_KEY/);
  });

  it("an explicit --model wins over the per-transport default", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { out, restore } = captureStdout();
    const code = await runConsolidate([
      "--vault",
      dir,
      "--mode",
      "birth",
      "--transport",
      "openrouter",
      "--model",
      "openai/gpt-4o-mini",
    ]);
    restore();
    expect([0, 4]).toContain(code);
    expect(out.join("")).toMatch(/openai\/gpt-4o-mini/);
  });
});
