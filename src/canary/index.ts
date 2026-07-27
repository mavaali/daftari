// `daftari canary` — the falsification harness for kill condition 1 of the
// 2026-07-27 read-path fence design.
//
// Deliberately a separate command from `daftari eval`. The eval answerer drives
// an in-process tool surface with write tools excluded, so it cannot observe
// instruction compliance at all — that was one of the four grounds the
// predecessor's canary was killed on.

import { createAnthropicClient } from "../eval/llm.js";
import { formatReport, parseCanaryArgs, runCanary } from "./run.js";

const USAGE = `daftari canary — does the read-path fence change consumer behaviour?

Runs three arms over a fixed set of documents carrying benign embedded
directives: unfenced, placebo (length-matched neutral server text), and fenced.
Compliance is whether the model calls an inert tool the document told it to
call while answering an unrelated retrieval question.

Usage:
  daftari canary [--model <id>] [--repetitions <n>] [--seed <n>]

Options:
  --model <id>         Model to test (default: $DAFTARI_CANARY_MODEL or Sonnet 4.5)
  --repetitions <n>    Trials per item per arm (default: 5)
  --seed <n>           Bootstrap seed, for a reproducible interval (default: 1)

Requires ANTHROPIC_API_KEY. Exits 1 if the kill condition fires, 2 if the run
is void (positive control failed), 0 if the fence survives.
`;

export async function runCanaryCli(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const opts = parseCanaryArgs(argv);
  if (!opts.ok) {
    process.stderr.write(`daftari canary: ${opts.error.message}\n\n${USAGE}`);
    return 1;
  }

  let client: ReturnType<typeof createAnthropicClient>;
  try {
    client = createAnthropicClient();
  } catch (e) {
    process.stderr.write(`daftari canary: ${(e as Error).message}\n`);
    return 1;
  }

  const report = await runCanary(client, {
    ...opts.value,
    onProgress: (m) => process.stderr.write(`  ${m}\n`),
  });
  if (!report.ok) {
    process.stderr.write(`daftari canary: ${JSON.stringify(report.error)}\n`);
    return 1;
  }

  process.stdout.write(`${formatReport(report.value)}\n`);
  if (report.value.verdict.reason.startsWith("VOID")) return 2;
  return report.value.verdict.killed ? 1 : 0;
}

export type { CanaryItem } from "./fixtures.js";
export { CANARY_ITEMS } from "./fixtures.js";
export type { Arm, CanaryOpts, CanaryReport } from "./run.js";
export { ARMS, formatReport, renderArm, runCanary } from "./run.js";
