// test/distill/cli-propose.test.ts
//
// `daftari distill --propose` end-to-end through runDistill, with the LLM
// transport mocked (no network, no key). Covers the 2026-10-25 benchmark
// findings: an all-chunks-failed run must exit non-zero and must not poison
// the source's distill state for the next run (beads 4v1q, b4m3).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
