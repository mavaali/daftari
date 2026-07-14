// Top-level entry for `daftari sleep` — the vault's dreams.
//
// Scheduling is the operating system's job (cron, launchd, a CI schedule);
// daftari ships the cycle, not a daemon. Two dream types:
//
//   circadian (default) — deterministic and LLM-FREE: measures decay, ranks
//   the wake list by blast radius, sweeps expired proposals, writes the wake
//   queue for an external agent, renders the Morning Report. The default
//   dream stays free: no flag combination on the default path can spend.
//
//   tension-scan — the LLM contradiction pass (explicit opt-in, costs
//   money): retrieves related docs per candidate, judges one pair of claims
//   per call, logs conflicts to the tension ledger. Hard call budget from
//   .daftari/config.yaml (tension_scan.max_llm_calls); judged pairs persist
//   across runs so unchanged content is never paid for twice.
//
// Exit codes (the audit convention):
//   0 — pass ran, report produced
//   2 — config/usage error
//   3 — runtime error (IO failure)

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { resolveAccess } from "../access/rbac.js";
import { sourceReadable } from "../curation/tension-access.js";
import { createAnthropicClient, type LlmClient } from "../eval/llm.js";
import {
  createOpenRouterClient,
  type LlmTransport,
  resolveTransport,
} from "../eval/llm-openrouter.js";
import { ok } from "../frontmatter/types.js";
import { openIndexForActiveProvider, vaultSearchRelated } from "../tools/search.js";
import { loadConfig } from "../utils/config.js";
import { runSleepCycle } from "./cycle.js";
import {
  renderJson,
  renderMarkdown,
  renderTensionScanJson,
  renderTensionScanMarkdown,
  type SleepReport,
} from "./report.js";
import { runTensionScan, type TensionScanDeps } from "./tension-scan.js";

const DEFAULT_WAKE_LIMIT = 20;

// Judge model defaults. Sonnet, not haiku: the demo's false-positive rate
// (0-1 borderline flags per run over ~30 benign notes) was measured with a
// frontier judge; the conservatism clause needs one to hold.
export const TENSION_SCAN_DEFAULT_MODEL = "claude-sonnet-4-6";
export const TENSION_SCAN_DEFAULT_MODEL_OPENROUTER = "anthropic/claude-sonnet-4.6";

const DREAM_TYPES = ["circadian", "tension-scan"] as const;
type DreamType = (typeof DREAM_TYPES)[number];

const HELP = `daftari sleep — the vault's nightly metabolic pass.

Usage:
  daftari sleep [--vault <path>] [options]
  daftari sleep --dream tension-scan [--vault <path>] [options]
  daftari sleep --help

Dream types (--dream, default 'circadian'):
  circadian     The free pass (deterministic, no LLM, no document writes):
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

  tension-scan  The contradiction pass (CALLS AN LLM — explicit opt-in):
    for each candidate doc (never-scanned first, then changed since the last
    scan, capped at --max-docs), retrieve related docs and judge ONE pair of
    claims per LLM call. Conservative: related-but-compatible is not a
    conflict; an unparseable verdict defaults to no-conflict. Conflicts land
    on the tension ledger (kind factual|temporal|interpretive), attributed to
    the scan agent. Judged pairs persist in .daftari/tension-scan-state.json
    — unchanged pairs are never re-judged; open tensions are never re-logged.

Flags (circadian):
  --vault <path>         Vault root (default: current directory).
  --wake-limit <n>       Wake-list rows shown in the report (default: ${DEFAULT_WAKE_LIMIT}).
                         The queue file always carries the full list.
  --no-queue             Do not write .daftari/wake-queue.jsonl.
  --output <md>          Markdown report destination (default: stdout).
  --output-json <json>   JSON report destination (default: not written).

Flags (tension-scan):
  --vault <path>         Vault root (default: current directory).
  --max-llm-calls <n>    Hard cap on pairwise judgments this pass
                         (default: config tension_scan.max_llm_calls, else 200).
  --max-docs <n>         Candidate docs per pass
                         (default: config tension_scan.max_docs, else 50).
  --model <id>           Judge model (default: ${TENSION_SCAN_DEFAULT_MODEL}).
  --transport <t>        anthropic (default, ANTHROPIC_API_KEY) or
                         openrouter (OPENROUTER_API_KEY); env fallback
                         DAFTARI_LLM_TRANSPORT.
  --agent <id>           loggedBy identity for logged tensions
                         (default: config tension_scan.agent, else
                         agent:sleep-tension-scan).
  --user <u> --role <r>  RBAC identity. Tension writes obey the
                         vault_tension_log rule: both sides readable, or the
                         pair is neither judged nor logged. Omitted =>
                         unrestricted (the RBAC-unconfigured posture).
  --output <md>          Markdown report destination (default: stdout).
  --output-json <json>   JSON report destination (default: not written).

Scheduling is yours (cron shown; any scheduler works):
  0 3 * * * cd /path/to/vault && npx daftari sleep --output .daftari/morning-report.md

Exit codes:
  0 — pass ran, report produced
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

  const dream = readStringArg(argv, "--dream") ?? "circadian";
  if (!(DREAM_TYPES as readonly string[]).includes(dream)) {
    process.stderr.write(
      `daftari sleep: --dream must be one of ${DREAM_TYPES.join("|")}, got ${dream}\n`,
    );
    return 2;
  }
  if ((dream as DreamType) === "tension-scan") {
    return runTensionScanCli(argv, vaultRoot);
  }

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

// --- the tension-scan dream ---------------------------------------------------

// Positive-integer flag parse shared by the two budget flags. Undefined means
// "not given" (fall back to config); anything non-integer or < 1 is a usage
// error.
function readPositiveInt(
  argv: string[],
  flagName: string,
): { value: number | undefined; error?: string } {
  const raw = readStringArg(argv, flagName);
  if (raw === undefined) return { value: undefined };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { value: undefined, error: `${flagName} must be a positive integer` };
  }
  return { value: n };
}

// Transport-aware LLM construction (the consolidate loop's pattern): the key
// check runs before the constructor so a missing key fails fast with a clear
// message instead of the client's terse internal throw.
function constructLlm(transport: LlmTransport): { llm: LlmClient } | { error: string } {
  const keyVar = transport === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
  if (!process.env[keyVar]) {
    return { error: `${keyVar} env var is required (transport: ${transport})` };
  }
  try {
    return {
      llm: transport === "openrouter" ? createOpenRouterClient() : createAnthropicClient(),
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

async function runTensionScanCli(argv: string[], vaultRoot: string): Promise<number> {
  const cfg = loadConfig(vaultRoot);
  if (!cfg.ok) {
    process.stderr.write(`daftari sleep: ${cfg.error.message}\n`);
    return 2;
  }

  const maxLlmCalls = readPositiveInt(argv, "--max-llm-calls");
  if (maxLlmCalls.error) {
    process.stderr.write(`daftari sleep: ${maxLlmCalls.error}\n`);
    return 2;
  }
  const maxDocs = readPositiveInt(argv, "--max-docs");
  if (maxDocs.error) {
    process.stderr.write(`daftari sleep: ${maxDocs.error}\n`);
    return 2;
  }

  const transportRes = resolveTransport(readStringArg(argv, "--transport"));
  if (!transportRes.ok) {
    process.stderr.write(`daftari sleep: ${transportRes.error.message}\n`);
    return 2;
  }
  const transport = transportRes.value;
  const model =
    readStringArg(argv, "--model") ??
    (transport === "openrouter"
      ? TENSION_SCAN_DEFAULT_MODEL_OPENROUTER
      : TENSION_SCAN_DEFAULT_MODEL);

  const llmRes = constructLlm(transport);
  if ("error" in llmRes) {
    process.stderr.write(`daftari sleep: ${llmRes.error}\n`);
    return 2;
  }

  // RBAC: --role builds the same gate vault_tension_log enforces —
  // sourceReadable over both sides of every pair, resolved against the index
  // when it opens (fail-closed to the first-segment rule when it does not).
  // No --role ⇒ unrestricted, matching every read surface when RBAC is off.
  const roleName = readStringArg(argv, "--role");
  const user = readStringArg(argv, "--user");
  let sourceVisible: ((path: string) => boolean) | undefined;
  let accessDb: ReturnType<typeof openIndexForActiveProvider> | undefined;
  let access: ReturnType<typeof resolveAccess> | undefined;
  if (roleName !== undefined) {
    access = resolveAccess(cfg.value, user ?? `agent:${roleName}`, roleName);
    accessDb = openIndexForActiveProvider(vaultRoot);
    const db = accessDb.ok ? accessDb.value : null;
    const ctx = access;
    sourceVisible = (path: string) => sourceReadable(db, ctx, path);
  }

  const deps: TensionScanDeps = {
    llm: llmRes.llm,
    searchNeighbors: async (path, limit) => {
      const r = await vaultSearchRelated(vaultRoot, { path, limit }, access);
      if (!r.ok) return r;
      return ok(r.value.hits.map((h) => h.path));
    },
    ...(sourceVisible ? { sourceVisible } : {}),
  };

  try {
    const scan = await runTensionScan(
      {
        vaultRoot,
        agent: readStringArg(argv, "--agent") ?? cfg.value.tensionScan.agent,
        model,
        maxLlmCalls: maxLlmCalls.value ?? cfg.value.tensionScan.maxLlmCalls,
        maxDocs: maxDocs.value ?? cfg.value.tensionScan.maxDocs,
      },
      deps,
    );
    if (!scan.ok) {
      process.stderr.write(`daftari sleep: ${scan.error.message}\n`);
      return 3;
    }
    if (scan.value.stateWriteError) {
      process.stderr.write(
        `daftari sleep: tension-scan state write failed: ${scan.value.stateWriteError} — ` +
          "the next pass re-baselines (some budget will be re-spent)\n",
      );
    }

    const md = renderTensionScanMarkdown(vaultRoot, model, scan.value);
    const outputMd = readStringArg(argv, "--output");
    const outputJson = readStringArg(argv, "--output-json");
    try {
      if (outputMd) {
        await writeFile(resolve(outputMd), md, "utf-8");
      } else {
        process.stdout.write(md);
      }
      if (outputJson) {
        await writeFile(resolve(outputJson), renderTensionScanJson(scan.value), "utf-8");
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      process.stderr.write(`daftari sleep: write failed: ${reason}\n`);
      return 3;
    }
    return 0;
  } finally {
    if (accessDb?.ok) accessDb.value.close();
  }
}
