// `daftari runs` — inspect the sleep/distill run ledger (.daftari/runs.jsonl).
// Read-only: list recent runs, or show one run's stored summary.
//
// Exit codes (the audit convention):
//   0 — listing/show produced
//   2 — usage error (unknown subcommand, bad --limit)
//   4 — show target not found

import { resolve } from "node:path";
import { listRuns, readRun, renderRunShow, renderRunsList } from "./run-ledger.js";

const HELP = `daftari runs — inspect the sleep/distill run ledger.

Usage:
  daftari runs [list] [--vault <path>] [--limit <n>]
  daftari runs show <id>  [--vault <path>]
  daftari runs --help

The ledger is .daftari/runs.jsonl — one content-light record per completed
sleep pass (counts only, no document bodies), appended by 'daftari sleep' and
self-pruned to a bounded history.

Exit codes:
  0 — produced   2 — usage error   4 — run id not found
`;

function readStringArg(argv: string[], flag: string): string | undefined {
  const raw = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (raw === undefined) return undefined;
  const idx = argv.indexOf(raw);
  return raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : argv[idx + 1];
}

export async function runRuns(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const vaultRoot = resolve(readStringArg(argv, "--vault") ?? ".");
  const sub = argv[0] && !argv[0].startsWith("-") ? argv[0] : "list";

  if (sub === "show") {
    const id = argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined;
    if (!id) {
      process.stderr.write("daftari runs: 'show' requires a run id\n");
      return 2;
    }
    const record = readRun(vaultRoot, id);
    if (!record) {
      process.stderr.write(`daftari runs: no run matching '${id}'\n`);
      return 4;
    }
    process.stdout.write(renderRunShow(record));
    return 0;
  }

  if (sub === "list") {
    let limit: number | undefined;
    const rawLimit = readStringArg(argv, "--limit");
    if (rawLimit !== undefined) {
      const n = Number(rawLimit);
      if (!Number.isInteger(n) || n < 1) {
        process.stderr.write("daftari runs: --limit must be a positive integer\n");
        return 2;
      }
      limit = n;
    }
    process.stdout.write(renderRunsList(listRuns(vaultRoot, limit)));
    return 0;
  }

  process.stderr.write(`daftari runs: unknown subcommand '${sub}' (expected 'list' or 'show')\n`);
  return 2;
}
