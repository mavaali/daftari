// Stage 2 wiring tests: --mode flag, env-var gating, ANTHROPIC_API_KEY check,
// Component A dispatch, exit-code hierarchy. The LlmClient is fully mocked via
// vi.mock so no real API call happens.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ok } from "../../src/frontmatter/types.js";

// Mock the LLM client surface BEFORE importing runConsolidate so the import
// graph sees the mock. The factory returns a client that always answers
// "survives" / "derives" depending on which mode is calling.
vi.mock("../../src/eval/llm.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../src/eval/llm.js")>("../../src/eval/llm.js");
  return {
    ...actual,
    createAnthropicClient: vi.fn(() => ({
      complete: vi.fn(),
      completeJson: vi.fn(async (opts: { user: string }) => {
        // Birth mode sends doc + neighbor; revision mode sends edge metadata.
        // We can distinguish by looking at the user body for the template
        // marker (revision uses [template:...]).
        const isRevision = /\[template:/.test(opts.user);
        const verdict = isRevision
          ? { verdict: "survives", reason: "mock revision survives" }
          : { verdict: "derives", reason: "mock birth derives" };
        return ok({
          text: JSON.stringify(verdict),
          parsed: verdict,
          input_tokens: 200,
          output_tokens: 30,
          stop_reason: "end_turn",
        });
      }),
      completeWithTools: vi.fn(),
    })),
  };
});

// Also mock vault_search_related so birth's neighbor lookup is deterministic.
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

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daftari-stage2-"));
  mkdirSync(join(dir, ".daftari"), { recursive: true });
  // Two trivial docs so loadDocuments has something to return.
  const fm = (title: string) =>
    `---\ntitle: ${title}\ndomain: accumulation\ncollection: c\nstatus: draft\nconfidence: medium\ncreated: 2026-05-01\nprovenance: direct\nsources: []\nsuperseded_by: null\nttl_days: 90\ntags: []\n---\n# ${title}\n`;
  writeFileSync(join(dir, "a.md"), fm("A"));
  writeFileSync(join(dir, "b.md"), fm("B"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

function captureStdout(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  return { out, restore: () => spy.mockRestore() };
}

describe("--mode flag validation", () => {
  it("default mode is 'scan' (Stage 1 behavior, no LLM)", async () => {
    const { out } = captureStdout();
    const code = await runConsolidate(["--vault", dir]);
    expect([0, 4]).toContain(code);
    expect(out.join("")).toMatch(/mode: scan/);
    // No Component A section in scan mode.
    expect(out.join("")).not.toMatch(/Component A/);
  });

  it("--mode=invalid → exit 2", async () => {
    const code = await runConsolidate(["--vault", dir, "--mode", "lol"]);
    expect(code).toBe(2);
  });

  it("--max-births=abc → exit 2", async () => {
    const code = await runConsolidate(["--vault", dir, "--mode", "birth", "--max-births", "abc"]);
    expect(code).toBe(2);
  });

  it("--max-panels=-1 → exit 2", async () => {
    const code = await runConsolidate(["--vault", dir, "--mode", "revision", "--max-panels", "-1"]);
    expect(code).toBe(2);
  });
});

describe("ANTHROPIC_API_KEY gating", () => {
  it("--mode=birth without the env var → exit 2 with clear error (no SDK throw)", async () => {
    const code = await runConsolidate(["--vault", dir, "--mode", "birth"]);
    expect(code).toBe(2);
  });

  it("--mode=scan does NOT require ANTHROPIC_API_KEY", async () => {
    const code = await runConsolidate(["--vault", dir]);
    expect([0, 4]).toContain(code);
  });
});

describe("Stage 2 dispatch — birth", () => {
  it("--mode=birth runs the loop, advances birthProcessed, writes a trace, reports counts", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    // Shadow_mode on so no real edge writes hit the store during the test.
    writeFileSync(join(dir, ".daftari", "config.yaml"), "version: 1\nshadow_mode: true\n");

    const { out } = captureStdout();
    const code = await runConsolidate(["--vault", dir, "--mode", "birth"]);
    expect([0, 4]).toContain(code);
    const text = out.join("");
    expect(text).toMatch(/Component A \(birth\)/);
    expect(text).toMatch(/births_processed: [12]/);
    expect(text).toMatch(/llm_calls: \d+/);
    expect(text).toMatch(/shadow_mode: true/);

    // The trace landed.
    expect(existsSync(join(dir, ".daftari", "birth-trace.jsonl"))).toBe(true);
    // birthProcessed advanced in state.
    const stateRaw = readFileSync(join(dir, ".daftari", "consolidate-state.json"), "utf-8");
    const state = JSON.parse(stateRaw) as { birthProcessed: Record<string, string> };
    expect(Object.keys(state.birthProcessed).length).toBeGreaterThan(0);
    // Shadow mode: no real edges in .daftari/edges.jsonl.
    expect(existsSync(join(dir, ".daftari", "edges.jsonl"))).toBe(false);
    // But shadow-actions.jsonl WAS appended (the calibration data flow).
    expect(existsSync(join(dir, ".daftari", "shadow-actions.jsonl"))).toBe(true);
  });
});

describe("Stage 2 dispatch — --max-births cap", () => {
  it("caps the number of docs processed in birth mode", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    writeFileSync(join(dir, ".daftari", "config.yaml"), "version: 1\nshadow_mode: true\n");
    // Add more docs so the cap matters.
    for (let i = 0; i < 5; i++) {
      const fm = `---\ntitle: D${i}\ndomain: accumulation\ncollection: c\nstatus: draft\nconfidence: medium\ncreated: 2026-05-01\nprovenance: direct\nsources: []\nsuperseded_by: null\nttl_days: 90\ntags: []\n---\n# D${i}\n`;
      writeFileSync(join(dir, `d${i}.md`), fm);
    }

    const { out } = captureStdout();
    const code = await runConsolidate(["--vault", dir, "--mode", "birth", "--max-births", "2"]);
    expect([0, 4]).toContain(code);
    const text = out.join("");
    // Exactly the cap (2 of the 7 docs queued; queue order is birth-slice FIFO).
    expect(text).toMatch(/births_processed: 2/);
  });
});

describe("Stage 2 — trace failure → exit 5", () => {
  it("if the trace cannot be written (read-only .daftari), exit code is 5", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    writeFileSync(join(dir, ".daftari", "config.yaml"), "version: 1\nshadow_mode: true\n");
    // Make .daftari read-only AFTER seeding config but BEFORE the run. The
    // shadow-actions.jsonl write hits ENOENT/EACCES; birth-trace also fails.
    // We chmod the dir to 0o555 (r-x).
    const dotDaf = join(dir, ".daftari");
    const fsMod = await import("node:fs");
    fsMod.chmodSync(dotDaf, 0o555);
    try {
      const { out } = captureStdout();
      const code = await runConsolidate(["--vault", dir, "--mode", "birth"]);
      // Exit 5 (trace failure) dominates 0 / 4.
      expect(code).toBe(5);
      void out;
    } finally {
      // Restore perms so afterEach can rmSync.
      fsMod.chmodSync(dotDaf, 0o755);
    }
  });
});
