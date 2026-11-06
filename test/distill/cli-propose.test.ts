// test/distill/cli-propose.test.ts
//
// `daftari distill --propose` end-to-end through runDistill, with the LLM
// transport mocked (no network, no key). Covers the 2026-10-25 benchmark
// findings: an all-chunks-failed run must exit non-zero and must not poison
// the source's distill state for the next run (beads 4v1q, b4m3).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../../src/eval/llm.js";
import { err, ok } from "../../src/frontmatter/types.js";

// The fake client every runDistill call in this file gets. Each test sets
// `completeJson` to the behavior it needs.
const fake: { completeJson: LlmClient["completeJson"] } = {
  completeJson: async () => err({ kind: "llm", message: "unset", retryable: false }),
};

vi.mock("../../src/eval/transport.js", () => ({
  createTransportClient: () =>
    ok({
      complete: vi.fn(),
      completeWithTools: vi.fn(),
      completeJson: (opts: Parameters<LlmClient["completeJson"]>[0]) => fake.completeJson(opts),
    }),
}));

const { runDistill } = await import("../../src/distill/cli.js");

const CONFIG_YAML = ["version: 1", "distill:", "  model: claude-sonnet-5-5", ""].join("\n");

const TRANSCRIPT = [
  "[1/2/26, 9:00:00 AM] Alice: The project deadline is end of Q2.",
  "[1/2/26, 9:01:00 AM] Bob: Agreed. We will use TypeScript for the new service.",
  "[1/2/26, 9:02:00 AM] Alice: Confirmed. No new external dependencies without review.",
].join("\n");

const HTTP_400 = "400 temperature is deprecated for this model";

let vault: string;
let source: string;
let out: string[];
let errOut: string[];
const origOut = process.stdout.write.bind(process.stdout);
const origErr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-distill-propose-"));
  mkdirSync(join(vault, ".daftari"), { recursive: true });
  writeFileSync(join(vault, ".daftari", "config.yaml"), CONFIG_YAML);
  source = join(vault, "chat.txt");
  writeFileSync(source, TRANSCRIPT);
  out = [];
  errOut = [];
  process.stdout.write = ((c: unknown) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    errOut.push(String(c));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  rmSync(vault, { recursive: true, force: true });
});

function failingClient(): void {
  fake.completeJson = async () => err({ kind: "llm", message: HTTP_400, retryable: false });
}

function workingClient(statements: string[]): void {
  fake.completeJson = async () =>
    ok({
      text: "{}",
      parsed: { claims: statements.map((statement) => ({ statement })) },
      input_tokens: 1,
      output_tokens: 1,
      stop_reason: "end_turn",
    });
}

function stagedCount(): number {
  try {
    const raw = readFileSync(join(vault, ".daftari", "staged-actions.jsonl"), "utf-8");
    return raw.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

describe("distill --propose — every chunk errors (bead 4v1q)", () => {
  it("exits 5 and says all chunks failed instead of reporting completion", async () => {
    failingClient();
    const code = await runDistill(["--vault", vault, "--propose", source]);
    expect(code).toBe(5);
    expect(out.join("")).not.toMatch(/distill --propose complete/);
    expect(errOut.join("")).toMatch(/all 1 chunk\(s\) failed/);
  });

  it("documents exit code 5 in --help", async () => {
    await runDistill(["--help"]);
    expect(out.join("")).toMatch(/^\s+5\s+.*chunk/m);
  });
});

// 31 messages ⇒ two 30-message chunks.
const TWO_CHUNK_TRANSCRIPT = Array.from(
  { length: 31 },
  (_, i) => `[1/2/26, 9:${String(i).padStart(2, "0")}:00 AM] Alice: Point number ${i}.`,
).join("\n");

describe("distill --propose — a failed run does not poison the next (bead b4m3)", () => {
  it("run 2 with a working model stages its claims after run 1 failed every chunk", async () => {
    failingClient();
    expect(await runDistill(["--vault", vault, "--propose", source])).toBe(5);

    workingClient(["The project deadline is end of Q2."]);
    out = [];
    const code = await runDistill(["--vault", vault, "--propose", source]);
    expect(code).toBe(0);
    const summary = out.join("");
    expect(summary).toMatch(/noop:\s+false/);
    expect(summary).toMatch(/created:\s+1/);
    expect(stagedCount()).toBe(1);
  });

  it("errors on some chunks plus zero claims elsewhere leaves the source unrecorded", async () => {
    writeFileSync(source, TWO_CHUNK_TRANSCRIPT);
    let call = 0;
    fake.completeJson = async () =>
      call++ === 0
        ? err({ kind: "llm", message: HTTP_400, retryable: false })
        : ok({
            text: "{}",
            parsed: { claims: [] },
            input_tokens: 1,
            output_tokens: 1,
            stop_reason: "end_turn",
          });
    await runDistill(["--vault", vault, "--propose", source]);
    expect(out.join("")).toMatch(/state written: false/);

    workingClient(["Alice listed thirty-one points."]);
    out = [];
    expect(await runDistill(["--vault", vault, "--propose", source])).toBe(0);
    expect(out.join("")).toMatch(/noop:\s+false/);
    expect(stagedCount()).toBeGreaterThan(0);
  });

  it("says so on stderr when an unchanged source discards a non-empty extraction", async () => {
    workingClient(["The project deadline is end of Q2."]);
    expect(await runDistill(["--vault", vault, "--propose", source])).toBe(0);
    errOut = [];
    out = [];
    expect(await runDistill(["--vault", vault, "--propose", source])).toBe(0);
    expect(out.join("")).toMatch(/noop:\s+true/);
    expect(errOut.join("")).toMatch(
      /unchanged since its last recorded distill.*1 extracted claim/s,
    );
  });
});

// 7 chunks × 30 messages, each chunk yielding 10 distinct claims (70 total) —
// the shape that the flat 50-claim default truncated after 5 chunks.
const SEVEN_CHUNK_TRANSCRIPT = Array.from({ length: 210 }, (_, i) => {
  const h = 9 + Math.floor(i / 60);
  const m = String(i % 60).padStart(2, "0");
  return `[1/2/26, ${h}:${m}:00 AM] Alice: Point number ${i}.`;
}).join("\n");

function tenClaimsPerChunk(): void {
  let call = 0;
  fake.completeJson = async () => {
    const c = call++;
    return ok({
      text: "{}",
      parsed: {
        claims: Array.from({ length: 10 }, (_, j) => ({ statement: `Chunk ${c} claim ${j}.` })),
      },
      input_tokens: 1,
      output_tokens: 1,
      stop_reason: "end_turn",
    });
  };
}

describe("distill --propose — claim cap scales with source size", () => {
  it("does not truncate a 7-chunk source when max_claims is unset", async () => {
    writeFileSync(source, SEVEN_CHUNK_TRANSCRIPT);
    tenClaimsPerChunk();
    expect(await runDistill(["--vault", vault, "--propose", source])).toBe(0);
    const summary = out.join("");
    expect(summary).toMatch(/claims:\s+70\b/);
    expect(summary).toMatch(/truncated:\s+false/);
  });

  it("keeps an explicit --max-claims authoritative and reports truncation", async () => {
    writeFileSync(source, SEVEN_CHUNK_TRANSCRIPT);
    tenClaimsPerChunk();
    expect(await runDistill(["--vault", vault, "--propose", "--max-claims", "50", source])).toBe(0);
    const summary = out.join("");
    expect(summary).toMatch(/claims:\s+50\b/);
    expect(summary).toMatch(/truncated:\s+true/);
  });
});
