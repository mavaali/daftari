// Anti-strawman checks for recall-bench arm C.
//
// Part A (Task 6): build-time provenance — assert PROVENANCE.sha equals the
//   LIVE blob SHA of the canonical SKILL.md in the sibling claude-home-base
//   repo. Skips gracefully when the sibling repo is absent.
//
// Part B (Task 7): runtime call-argument fidelity — assert that makeCompiler
//   drives the LLM with EXACTLY the canonical AUTHORING_SYSTEM_PROMPT and the
//   correct per-day opts. If the compiler ever sends a different/edited prompt,
//   this test fails — that's the anti-strawman point.
//
// Both blocks are HERMETIC: no network, no MiniLM, no real LLM.

import { describe, it, expect, afterAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../../../dist/frontmatter/types.js";
import type {
  LlmClient,
  CompleteWithToolsOpts,
  CompleteWithToolsResult,
} from "../../../dist/eval/llm.js";
import { AUTHORING_SYSTEM_PROMPT, PROVENANCE } from "./authoring-prompt.js";
import { makeCompiler } from "./compiler.js";
import { parseConfig } from "./config.js";
import type { DayMetadata } from "./types.js";

// ---------------------------------------------------------------------------
// Part A — build-time provenance (Task 6)
// ---------------------------------------------------------------------------

describe("Part A — build-time provenance", () => {
  // Ungated: these rely only on the constants in authoring-prompt.ts.
  it("PROVENANCE.repo === 'claude-home-base'", () => {
    expect(PROVENANCE.repo).toBe("claude-home-base");
  });

  it("PROVENANCE.path ends with SKILL.md", () => {
    expect(PROVENANCE.path.endsWith("SKILL.md")).toBe(true);
  });

  // Gated: requires the sibling repo to be present on this machine.
  it("PROVENANCE.sha matches the live blob SHA of SKILL.md in the sibling repo", () => {
    const repoDir =
      process.env.RB_SKILL_REPO ??
      "/Users/mihirwagle/projects/claude-home-base";

    let liveSha: string;
    try {
      liveSha = execSync(
        `git -C ${repoDir} rev-parse feat/knowledge-plugin:${PROVENANCE.path}`,
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
    } catch (e) {
      // Sibling repo / branch / file absent — skip gracefully, never hard-fail.
      console.warn(
        `[anti-strawman Part A] SKIPPED: could not resolve SKILL.md SHA from ` +
          `${repoDir} (feat/knowledge-plugin:${PROVENANCE.path}). ` +
          `Error: ${e instanceof Error ? e.message : String(e)}`,
      );
      return; // dynamic skip — test passes vacuously when repo is absent
    }

    expect(liveSha).toBe(PROVENANCE.sha);
  });
});

// ---------------------------------------------------------------------------
// Part B — runtime call-argument fidelity (Task 7)
// ---------------------------------------------------------------------------

// A recording stub LlmClient that captures every completeWithTools call and
// returns an empty tool_calls result (no vault I/O, no MiniLM).
interface CapturedCall {
  model: string;
  system: string;
  user: string;
  maxRounds: number | undefined;
}

function makeRecordingStub(): { llm: LlmClient; captured: CapturedCall[] } {
  const captured: CapturedCall[] = [];

  const llm: LlmClient = {
    async complete() {
      return ok({ text: "stub", input_tokens: 1, output_tokens: 1, stop_reason: "end_turn" });
    },
    async completeJson() {
      return ok({
        text: "stub",
        parsed: {},
        input_tokens: 1,
        output_tokens: 1,
        stop_reason: "end_turn",
      });
    },
    async completeWithTools(opts: CompleteWithToolsOpts) {
      captured.push({
        model: opts.model,
        system: opts.system,
        user: opts.user,
        maxRounds: opts.maxRounds,
      });
      const result: CompleteWithToolsResult = {
        text: "done",
        tool_calls: [],
        input_tokens: 1,
        output_tokens: 1,
        stop_reason: "end_turn",
      };
      return ok(result);
    },
  };

  return { llm, captured };
}

// Fixed DayMetadata factory.
function meta(n: number): DayMetadata {
  return {
    dayNumber: n,
    date: `2026-01-${String(n).padStart(2, "0")}`,
    personaId: "persona-a",
    activeArcs: [`arc-${n}`],
  };
}

describe("Part B — runtime call-argument fidelity", () => {
  // Shared tmp vault dir — created once, cleaned up after the suite.
  const vaultRoot = mkdtempSync(join(tmpdir(), "rb-anti-strawman-"));

  afterAll(() => {
    try {
      rmSync(vaultRoot, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("compiler sends canonical opts for all 3 days", async () => {
    const cfgResult = parseConfig({
      answererModel: "stub-model",
      authoringModel: "test-authoring-model",
      agentMaxIterations: 4,
      compile: "write",
    });
    if (!cfgResult.ok) throw new Error(cfgResult.error.message);
    const cfg = cfgResult.value;

    const { llm, captured } = makeRecordingStub();
    const compile = makeCompiler(vaultRoot, cfg, llm);

    // Simulate adapter accumulation: priorDayPaths grows across days.
    const day1 = await compile(1, "Day one content.", meta(1), []);
    const day2 = await compile(2, "Day two content.", meta(2), ["topics/a.md"]);
    const day3 = await compile(
      3,
      "Day three content.",
      meta(3),
      ["topics/a.md", "topics/b.md"],
    );

    // Three calls total — one per day.
    expect(captured).toHaveLength(3);

    // Every call must use the configured authoringModel.
    for (const call of captured) {
      expect(call.model).toBe(cfg.authoringModel);
    }

    // Every call must send EXACTLY the canonical AUTHORING_SYSTEM_PROMPT —
    // identity check (===), not substring. Any compiler-side edit fails here.
    for (const call of captured) {
      expect(call.system).toBe(AUTHORING_SYSTEM_PROMPT);
    }

    // Every call must respect agentMaxIterations as maxRounds.
    for (const call of captured) {
      expect(call.maxRounds).toBe(cfg.agentMaxIterations);
    }

    // Day 1: no prior pages — user message must say "No prior-day pages exist yet."
    expect(captured[0].user).toContain("No prior-day pages exist yet");
    expect(captured[0].user).not.toContain("Pages from prior days");

    // Day 2: prior paths supplied → must surface them in the user message.
    expect(captured[1].user).toContain("topics/a.md");
    expect(captured[1].user).toContain("Pages from prior days");

    // Day 3: both prior paths must appear.
    expect(captured[2].user).toContain("topics/a.md");
    expect(captured[2].user).toContain("topics/b.md");
    expect(captured[2].user).toContain("Pages from prior days");

    // Suppress unused-variable lint for the CompileResult values — we only
    // care that the calls were made; notesWritten is empty (stub returns []).
    void day1;
    void day2;
    void day3;
  });
});
