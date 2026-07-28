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
//
// `usage` is deliberately NOT 1. A CI job gating on "exit 1 means the fence is
// dead" would otherwise fire identically for a typo'd flag or an unset API key
// — the same conflation `void` exists to prevent for a broken instrument.
// Every code here means a different thing happened:
//   0 the fence survived   1 kill condition 1 fired
//   2 the run was void     3 it never ran (bad arguments, no key)
//   4 it started and died partway (API failure) — money already spent, and
//     unlike 3 the fix is to retry, not to correct the invocation
export const EXIT = { survived: 0, killed: 1, void: 2, usage: 3, failed: 4 } as const;

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

Requires ANTHROPIC_API_KEY.

Exit codes:
  0  the fence survived — fencing reduced compliance
  1  kill condition 1 fired — fencing did not change compliance
  2  the run was void — the positive control failed, so nothing is concluded
  3  it never ran — bad arguments or no API key, nothing spent
  4  it started and failed partway — an API error mid-run, partial spend

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
    // command needs, and what THIS invocation would spend — arguments are
    // already parsed here, so quoting the default would misreport any run that
    // passed --repetitions.
    const items = CANARY_ITEMS.length;
    const reps = opts.value.repetitions ?? 5;
    const trials = 3 * items * reps + items;
    process.stderr.write(
      `daftari canary: ANTHROPIC_API_KEY is required.\n\n` +
        `  export ANTHROPIC_API_KEY=sk-ant-...\n\n` +
        `This run would make ${trials} model calls (${items} items x 3 arms x ` +
        `${reps} repetitions, plus ${items} positive-control trials).\n` +
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
    // Distinct from EXIT.usage: this run reached the API and spent against it
    // before dying, so the operator's next move is to retry, not to fix their
    // command line. Collapsing the two would make a mid-run network blip look
    // like a typo.
    const e = report.error;
    const detail = typeof e === "object" && e !== null && "message" in e ? e.message : String(e);
    process.stderr.write(`daftari canary: run failed partway through — ${detail}\n`);
    return EXIT.failed;
  }

  process.stdout.write(`${formatReport(report.value)}\n`);
  return EXIT[report.value.verdict.status];
}

export type { CanaryItem } from "./fixtures.js";
export { CANARY_ITEMS } from "./fixtures.js";
export type { Arm, CanaryOpts, CanaryReport } from "./run.js";
export { ARMS, formatReport, renderArm, runCanary } from "./run.js";
