// Top-level entry for `daftari sleep` — the circadian pass.
//
// Scheduling is the operating system's job (cron, launchd, a CI schedule);
// daftari ships the cycle, not a daemon. The pass is deterministic and
// LLM-free: it measures decay, ranks the wake list by blast radius, sweeps
// expired proposals, writes the wake queue for an external agent, and
// renders the Morning Report for the human who ratifies.
//
// Exit codes (the audit convention):
//   0 — cycle ran, report produced
//   2 — config/usage error
//   3 — runtime error (IO failure)

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runSleepCycle } from "./cycle.js";
import { renderJson, renderMarkdown, type SleepReport } from "./report.js";

const DEFAULT_WAKE_LIMIT = 20;

const HELP = `daftari sleep — the vault's nightly metabolic pass.

Usage:
  daftari sleep [--vault <path>] [options]
  daftari sleep --help

The cycle (deterministic, no LLM, no document writes):
  1. sweep expired staged actions (housekeeping)
  2. score every document's decay; honor the domain split (generative docs
     going stale is expected — counted, never woken)
  3. build the WAKE LIST: canonical accumulation docs past TTL with
     downstream dependents, ranked by blast radius — and write it to
     .daftari/wake-queue.jsonl for an external agent to re-verify each
     against its sources and stage diffs for ratification
  4. surface tension aging and the court docket head
  5. render the Morning Report, ending at the ratification queue — with the
     rubber-stamp monitor (zero rejections over a long history is a warning,
     not a compliment)

Flags:
  --vault <path>         Vault root (default: current directory).
  --wake-limit <n>       Wake-list rows shown in the report (default: ${DEFAULT_WAKE_LIMIT}).
                         The queue file always carries the full list.
  --no-queue             Do not write .daftari/wake-queue.jsonl.
  --output <md>          Markdown report destination (default: stdout).
  --output-json <json>   JSON report destination (default: not written).

Scheduling is yours (cron shown; any scheduler works):
  0 3 * * * cd /path/to/vault && npx daftari sleep --output .daftari/morning-report.md

Exit codes:
  0 — cycle ran, report produced
  2 — config/usage error
  3 — runtime error (IO failure)
`;

function readStringArg(argv: string[], flag: string): string | undefined {
  const raw = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (raw === undefined) return undefined;
  const idx = argv.indexOf(raw);
  return raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : argv[idx + 1];
}

export function wakeQueuePath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "wake-queue.jsonl");
}

export async function runSleep(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const vaultRoot = resolve(readStringArg(argv, "--vault") ?? ".");

  let wakeLimit = DEFAULT_WAKE_LIMIT;
  const rawLimit = readStringArg(argv, "--wake-limit");
  if (rawLimit !== undefined) {
    const n = Number(rawLimit);
    if (!Number.isInteger(n) || n < 1) {
      process.stderr.write(`daftari sleep: --wake-limit must be a positive integer\n`);
      return 2;
    }
    wakeLimit = n;
  }

  const cycle = await runSleepCycle(vaultRoot);
  if (!cycle.ok) {
    process.stderr.write(`daftari sleep: ${cycle.error.message}\n`);
    return 3;
  }

  // The wake queue: one JSON line per task, overwritten each cycle — a
  // snapshot for tonight's agent, not a log. Gitignored (local curation
  // state, like the provenance log).
  let queuePath: string | null = null;
  if (!argv.includes("--no-queue")) {
    queuePath = wakeQueuePath(vaultRoot);
    try {
      await mkdir(dirname(queuePath), { recursive: true });
      const lines = cycle.value.wake.map((w) => JSON.stringify(w)).join("\n");
      await writeFile(queuePath, lines.length > 0 ? `${lines}\n` : "", "utf-8");
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      process.stderr.write(`daftari sleep: wake-queue write failed: ${reason}\n`);
      return 3;
    }
  }

  const report: SleepReport = {
    generatedAt: new Date().toISOString(),
    vault: vaultRoot,
    cycle: cycle.value,
    wakeQueuePath: queuePath,
    wakeLimit,
  };

  const md = renderMarkdown(report);
  const outputMd = readStringArg(argv, "--output");
  const outputJson = readStringArg(argv, "--output-json");
  try {
    if (outputMd) {
      await writeFile(resolve(outputMd), md, "utf-8");
    } else {
      process.stdout.write(md);
    }
    if (outputJson) {
      await writeFile(resolve(outputJson), renderJson(report), "utf-8");
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`daftari sleep: write failed: ${reason}\n`);
    return 3;
  }

  return 0;
}
