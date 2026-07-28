// `daftari canary` — the falsification harness for kill condition 1 of the
// 2026-07-27 read-path fence design.
//
// Deliberately a separate command from `daftari eval`. The eval answerer drives
// an in-process tool surface with write tools excluded, so it cannot observe
// instruction compliance at all — that was one of the four grounds the
// predecessor's canary was killed on.

import type { LlmClient } from "../eval/llm.js";
import { createAnthropicClient } from "../eval/llm.js";
import { CANARY_ITEMS } from "./fixtures.js";
import { formatReport, parseCanaryArgs, runCanary } from "./run.js";

// Exit codes are a contract, so they are declared once and derived from the
// verdict's structured status rather than from its prose.
export const EXIT = { survived: 0, killed: 1, void: 2, usage: 1 } as const;

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

Running from a working copy (this package is not published under this name for
local use — \`npx daftari\` would fetch the registry version, not your build):

  npm run build && node dist/cli.js canary
  npm run build && npx --no daftari canary   # uses the local bin
`;

// `deps.client` lets tests drive the exit-code contract without a network call
// or an API key, following the `createAnthropicClient(injected?)` precedent.
export async function runCanaryCli(
  argv: readonly string[],
  deps: { client?: LlmClient } = {},
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return 0;
  }
  const opts = parseCanaryArgs(argv);
  if (!opts.ok) {
    process.stderr.write(`daftari canary: ${opts.error.message}\n\n${USAGE}`);
    return EXIT.usage;
  }

  let client: LlmClient;
  try {
    client = deps.client ?? createAnthropicClient();
  } catch {
    // The shared eval client's own message names `daftari eval`, which is
    // wrong and confusing when the user ran `daftari canary`. Say what this
    // command needs, and what it will spend it on.
    const items = CANARY_ITEMS.length;
    const trials = 3 * items * 5 + items;
    process.stderr.write(
      `daftari canary: ANTHROPIC_API_KEY is required.\n\n` +
        `  export ANTHROPIC_API_KEY=sk-ant-...\n\n` +
        `A default run makes ${trials} model calls (${items} items x 3 arms x 5 ` +
        `repetitions, plus ${items} positive-control trials).\n` +
        `Use --repetitions to change that; fewer than 3 makes the interval too ` +
        `wide to conclude anything.\n`,
    );
    return EXIT.usage;
  }

  const report = await runCanary(client, {
    ...opts.value,
    onProgress: (m) => process.stderr.write(`  ${m}\n`),
  });
  if (!report.ok) {
    process.stderr.write(`daftari canary: ${JSON.stringify(report.error)}\n`);
    return EXIT.usage;
  }

  process.stdout.write(`${formatReport(report.value)}\n`);
  return EXIT[report.value.verdict.status];
}

export type { CanaryItem } from "./fixtures.js";
export { CANARY_ITEMS } from "./fixtures.js";
export type { Arm, CanaryOpts, CanaryReport } from "./run.js";
export { ARMS, formatReport, renderArm, runCanary } from "./run.js";
