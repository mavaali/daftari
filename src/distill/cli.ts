// src/distill/cli.ts
//
// `daftari distill` CLI front door (U7) and its argument-parsing helpers.
//
// Split out of src/distill/index.ts (U9): index.ts owns the pipeline
// orchestration and the config/client resolver; this module owns the argv
// parsing, mode routing (--plan / --propose / --review), and process I/O.
// index.ts re-exports `runDistill` so existing importers keep their path.

import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { withCallBudget } from "../consolidate/call-budget.js";
import { listStagedActions } from "../curation/staged-actions.js";
import type { LlmTransport } from "../eval/llm-openrouter.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { vaultRatify } from "../tools/staged-actions.js";
import {
  DEFAULT_CORROBORATION_THRESHOLD,
  type DistillConfig,
  loadConfig,
} from "../utils/config.js";
import type { SourceAdapter } from "./adapters/types.js";
import { chunkMessages } from "./chunk.js";
import { buildReceipt, planDistill } from "./cost.js";
import { extractClaims } from "./extract.js";
import { ADAPTER_REGISTRY, DISTILL_NOT_CONFIGURED_MSG, resolveDistillClient } from "./index.js";
import { makeOverlapHinter } from "./propose.js";
import { distillUpsert, recordLandedClaim } from "./state.js";

// ---------------------------------------------------------------------------
// CLI front door — U7
// ---------------------------------------------------------------------------

const DISTILL_USAGE = `daftari distill — compile-on-ingest: extract claims from a source file.

Usage:
  daftari distill <file|-> [options]

Source:
  <file>           Path to a chat-transcript .txt file.
  -                Read from stdin (requires --source-id).

Options:
  --vault <path>       Vault root (default: current directory).
  --source-id <id>     Stable identity of this source. Required when reading
                       from stdin; derived from the filename otherwise.
  --source-type <chat-transcript|claude-session>
                       Override auto-detected adapter. Auto-detect: a .jsonl
                       extension (case-insensitive) → claude-session, all other
                       paths/stdin → chat-transcript.
  --sender <user|assistant>
                       Filter messages to a single sender before chunking.
                       Absent → all senders (unchanged behavior). A single-sender
                       pass yields claims of known provenance (R6).
  --plan               Print a cost/call estimate without making any LLM calls.
                       This is the default when neither --plan nor --propose is given.
  --propose            Run the full pipeline: extract claims and stage proposals
                       into the vault. Requires an API key and a distill: config block.
  --review <run_id>    Review the pending proposals from a prior run and approve
                       them all through the ratify path. Dry-run (list only) unless
                       --yes is given. Mutually exclusive with --plan / --propose.
  --by <principal>     Reviewer principal recorded on each ratify (default: cli).
  --yes                Actually approve on --review (without it, --review lists only).
                       Ratifies ALL matched proposals, ignoring corroboration.
  --auto-safe          On --review, ratify only the corroborated subset
                       (corroboration >= threshold); the rest stay queued for a
                       human. Applies without --yes. If both are given, --yes wins.
  --corroboration-threshold <T>
                       Corroboration bar in [0,1] for --auto-safe (default:
                       config distill.corroboration_threshold, else 0.8).
  --max-llm-calls <n>  Override config.maxLlmCalls for this run.
  --max-claims <n>     Override config.maxClaims for this run.
  --model <id>         Override config.model for this run.
  --transport <t>      LLM transport: anthropic (default) | openrouter.
  --zdr                Assert zero-data-retention for the receipt (default: false).
  --help, -h           Show this help.

Exit codes:
  0   Success.
  2   Usage error (no source, stdin without --source-id, unknown flag).
  3   Config/key refuse (missing distill: block, missing API key on --propose).
  4   Partial failure (some claims failed to stage, or some proposals failed to ratify).
`;

/**
 * Read a string flag value (--flag value or --flag=value).
 *
 * Returns:
 *   `{ found: false }` — flag is absent from argv.
 *   `{ found: true, value: string }` — flag present with a non-empty value.
 *   `{ found: true, value: undefined }` — flag present but its value is
 *     missing (last token) or the `=`-form was `--flag=` (empty rhs); the
 *     caller should exit 2.
 */
function readStringArg(
  argv: string[],
  flag: string,
): { found: false } | { found: true; value: string | undefined } {
  const match = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (match === undefined) return { found: false };
  if (match.includes("=")) {
    const rhs = match.slice(match.indexOf("=") + 1);
    return { found: true, value: rhs.length > 0 ? rhs : undefined };
  }
  const idx = argv.indexOf(match);
  const next = argv[idx + 1];
  // If next token is absent or is itself a flag, the value is missing.
  return {
    found: true,
    value: next !== undefined && !next.startsWith("--") ? next : undefined,
  };
}

/**
 * Read a string flag, returning the value or undefined when absent.
 * Exits 2 via `process.exit`-equivalent return of a sentinel string when the
 * flag is present but its value is missing — callers check `MISSING_VALUE`.
 *
 * Because `runDistill` is async and exit codes are returned, not thrown, we
 * use a shared sentinel object to signal "flag present, value missing".
 */
const MISSING_FLAG_VALUE = Symbol("MISSING_FLAG_VALUE");

function readString(argv: string[], flag: string): string | undefined | typeof MISSING_FLAG_VALUE {
  const res = readStringArg(argv, flag);
  if (!res.found) return undefined;
  if (res.value === undefined) return MISSING_FLAG_VALUE;
  return res.value;
}

/**
 * Parse a positive integer flag value.
 *
 * Returns:
 *   `undefined`              — flag is absent (use default).
 *   `number`                 — flag present with a valid positive integer.
 *   `MISSING_FLAG_VALUE`     — flag present but value token is missing.
 *   `INVALID_INT_VALUE`      — flag present but value is non-numeric or ≤ 0.
 */
const INVALID_INT_VALUE = Symbol("INVALID_INT_VALUE");

function readPositiveInt(
  argv: string[],
  flag: string,
): number | undefined | typeof MISSING_FLAG_VALUE | typeof INVALID_INT_VALUE {
  const res = readStringArg(argv, flag);
  if (!res.found) return undefined;
  if (res.value === undefined) return MISSING_FLAG_VALUE;
  const n = Number.parseInt(res.value, 10);
  return Number.isFinite(n) && n > 0 ? n : INVALID_INT_VALUE;
}

/**
 * Generate a stable run ID for one distill invocation.
 * Format: `distill-<ISO date>-<6-char random hex>`.
 * Not the idempotency key (that is sourceId); this is a per-run trace stamp.
 */
function makeRunId(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
  return `distill-${iso}-${rand}`;
}

/**
 * Derive a stable sourceId from a file path: basename without extension.
 * E.g. "/path/to/chat-2026-01.txt" → "chat-2026-01".
 */
function sourceIdFromPath(filePath: string): string {
  const base = basename(filePath);
  const ext = extname(base);
  return ext ? base.slice(0, base.length - ext.length) : base;
}

/**
 * Load config without constructing an LLM client (used on the --plan path).
 * Returns err when the config is missing the distill: block — same refuse
 * message as resolveDistillClient so the user sees a consistent error.
 */
function resolveDistillConfig(vaultRoot: string): Result<DistillConfig, Error> {
  const cfg = loadConfig(vaultRoot);
  if (!cfg.ok) return err(cfg.error);

  if (!cfg.value.distill) {
    return err(new Error(DISTILL_NOT_CONFIGURED_MSG));
  }
  return ok(cfg.value.distill);
}

/**
 * `daftari distill` CLI front door.
 *
 * Parses argv, validates inputs, then routes to one of:
 *   --plan (default): zero-spend pre-flight estimate.
 *   --propose:        full LLM-driven extraction + staged proposals.
 *   --review:         batch-ratify a prior run's staged proposals.
 *
 * Returns an exit code (0/2/3/4); the caller sets process.exitCode.
 * Diagnostics go to stderr; clean output goes to stdout.
 */
export async function runDistill(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(DISTILL_USAGE);
    return 0;
  }

  // ---------------------------------------------------------------------------
  // Parse flags
  // ---------------------------------------------------------------------------

  // I5: both --plan and --propose is a usage error.
  if (argv.includes("--plan") && argv.includes("--propose")) {
    process.stderr.write(
      `daftari distill: cannot specify both --plan and --propose\n\n${DISTILL_USAGE}`,
    );
    return 2;
  }

  // I1: read value-taking flags; any flag present without a value is an error.
  const vaultRes = readString(argv, "--vault");
  if (vaultRes === MISSING_FLAG_VALUE) {
    process.stderr.write(`daftari distill: --vault requires a value\n\n${DISTILL_USAGE}`);
    return 2;
  }
  const vaultRaw = vaultRes ?? ".";
  const vaultRoot = resolve(vaultRaw);

  // --review <run_id>: batch-ratify mode. Handled before the source-file
  // machinery because it takes a run_id, not a source file.
  const reviewRes = readString(argv, "--review");
  if (reviewRes === MISSING_FLAG_VALUE) {
    process.stderr.write(`daftari distill: --review requires a run_id\n\n${DISTILL_USAGE}`);
    return 2;
  }
  if (reviewRes !== undefined) {
    if (argv.includes("--plan") || argv.includes("--propose")) {
      process.stderr.write(
        `daftari distill: --review cannot be combined with --plan or --propose\n\n${DISTILL_USAGE}`,
      );
      return 2;
    }
    const byRes = readString(argv, "--by");
    if (byRes === MISSING_FLAG_VALUE) {
      process.stderr.write(`daftari distill: --by requires a value\n\n${DISTILL_USAGE}`);
      return 2;
    }
    const principal = byRes ?? "cli";

    // R8: corroboration gate. --auto-safe ratifies only the corroborated
    // subset; --corroboration-threshold overrides the config/default bar.
    const autoSafe = argv.includes("--auto-safe");
    const ctRes = readString(argv, "--corroboration-threshold");
    if (ctRes === MISSING_FLAG_VALUE) {
      process.stderr.write(
        `daftari distill: --corroboration-threshold requires a value\n\n${DISTILL_USAGE}`,
      );
      return 2;
    }
    // Base bar: the vault's distill.corroborationThreshold when a distill:
    // block is present, else the conservative default. A --review on a vault
    // without a distill: block must still work using the default.
    let threshold = DEFAULT_CORROBORATION_THRESHOLD;
    const cfgForThreshold = resolveDistillConfig(vaultRoot);
    if (cfgForThreshold.ok) threshold = cfgForThreshold.value.corroborationThreshold;
    if (ctRes !== undefined) {
      const t = Number.parseFloat(ctRes);
      if (!Number.isFinite(t) || t < 0 || t > 1) {
        process.stderr.write(
          `daftari distill: --corroboration-threshold must be a number in [0,1]\n\n${DISTILL_USAGE}`,
        );
        return 2;
      }
      threshold = t;
    }

    const yes = argv.includes("--yes");
    const applied = yes || autoSafe; // auto-safe implies apply the qualifying subset
    return await reviewRun(vaultRoot, reviewRes, principal, applied, autoSafe, threshold, yes);
  }

  const sourceIdRes = readString(argv, "--source-id");
  if (sourceIdRes === MISSING_FLAG_VALUE) {
    process.stderr.write(`daftari distill: --source-id requires a value\n\n${DISTILL_USAGE}`);
    return 2;
  }
  const sourceIdFlag = sourceIdRes;

  const sourceTypeRes = readString(argv, "--source-type");
  if (sourceTypeRes === MISSING_FLAG_VALUE) {
    process.stderr.write(`daftari distill: --source-type requires a value\n\n${DISTILL_USAGE}`);
    return 2;
  }
  const sourceTypeFlag = sourceTypeRes;
  if (sourceTypeFlag !== undefined && !(sourceTypeFlag in ADAPTER_REGISTRY)) {
    process.stderr.write(
      `daftari distill: unknown --source-type: ${sourceTypeFlag} ` +
        `(known: ${Object.keys(ADAPTER_REGISTRY).join(", ")})\n\n${DISTILL_USAGE}`,
    );
    return 2;
  }

  const senderRes = readString(argv, "--sender");
  if (senderRes === MISSING_FLAG_VALUE) {
    process.stderr.write(`daftari distill: --sender requires a value\n\n${DISTILL_USAGE}`);
    return 2;
  }
  const senderFlag = senderRes;
  if (senderFlag !== undefined && senderFlag !== "user" && senderFlag !== "assistant") {
    process.stderr.write(
      `daftari distill: --sender must be 'user' or 'assistant'\n\n${DISTILL_USAGE}`,
    );
    return 2;
  }

  const transportRes2 = readString(argv, "--transport");
  if (transportRes2 === MISSING_FLAG_VALUE) {
    process.stderr.write(`daftari distill: --transport requires a value\n\n${DISTILL_USAGE}`);
    return 2;
  }
  const transportFlag = transportRes2;

  const modelRes = readString(argv, "--model");
  if (modelRes === MISSING_FLAG_VALUE) {
    process.stderr.write(`daftari distill: --model requires a value\n\n${DISTILL_USAGE}`);
    return 2;
  }
  const modelFlag = modelRes;

  // I2: numeric flags — distinguish absent (ok) from present-but-bad (exit 2).
  const maxLlmCallsRaw = readPositiveInt(argv, "--max-llm-calls");
  if (maxLlmCallsRaw === MISSING_FLAG_VALUE) {
    process.stderr.write(`daftari distill: --max-llm-calls requires a value\n\n${DISTILL_USAGE}`);
    return 2;
  }
  if (maxLlmCallsRaw === INVALID_INT_VALUE) {
    process.stderr.write(
      `daftari distill: --max-llm-calls must be a positive integer\n\n${DISTILL_USAGE}`,
    );
    return 2;
  }
  const maxLlmCallsFlag = maxLlmCallsRaw;

  const maxClaimsRaw = readPositiveInt(argv, "--max-claims");
  if (maxClaimsRaw === MISSING_FLAG_VALUE) {
    process.stderr.write(`daftari distill: --max-claims requires a value\n\n${DISTILL_USAGE}`);
    return 2;
  }
  if (maxClaimsRaw === INVALID_INT_VALUE) {
    process.stderr.write(
      `daftari distill: --max-claims must be a positive integer\n\n${DISTILL_USAGE}`,
    );
    return 2;
  }
  const maxClaimsFlag = maxClaimsRaw;

  const zdr = argv.includes("--zdr");
  const wantPropose = argv.includes("--propose");

  // When neither --plan nor --propose is given, default to --plan (safe zero-spend preview).
  const mode: "plan" | "propose" = wantPropose ? "propose" : "plan";

  // Source file is the first non-flag positional argument.
  // Collect all positional args (those not starting with "--" and not
  // immediately following a known value-taking flag).
  const VALUE_FLAGS = new Set([
    "--vault",
    "--source-id",
    "--source-type",
    "--sender",
    "--transport",
    "--max-llm-calls",
    "--max-claims",
    "--model",
    "--review",
    "--by",
    "--corroboration-threshold",
  ]);
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (
      a === "--plan" ||
      a === "--propose" ||
      a === "--zdr" ||
      a === "--yes" ||
      a === "--auto-safe" ||
      a === "--help" ||
      a === "-h"
    ) {
      continue;
    }
    if (a.startsWith("--")) {
      // Either a known value-flag or an unknown flag.
      const bare = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
      if (VALUE_FLAGS.has(bare)) {
        // Skip the next token if the flag was written as `--flag value` (no `=`).
        if (!a.includes("=")) i++;
        continue;
      }
      // Unknown flag → usage error.
      process.stderr.write(`daftari distill: unknown flag: ${a}\n\n${DISTILL_USAGE}`);
      return 2;
    }
    positionals.push(a);
  }

  // m3: reject extra positionals before checking for absent source.
  if (positionals.length > 1) {
    process.stderr.write(
      `daftari distill: only one source is accepted; got: ${positionals.join(", ")}\n\n${DISTILL_USAGE}`,
    );
    return 2;
  }

  const sourceArg = positionals[0];

  // ---------------------------------------------------------------------------
  // Validate source arg
  // ---------------------------------------------------------------------------

  if (sourceArg === undefined) {
    process.stderr.write(
      `daftari distill: no source file given — pass a file path or '-' for stdin\n\n${DISTILL_USAGE}`,
    );
    return 2;
  }

  if (sourceArg === "-" && sourceIdFlag === undefined) {
    process.stderr.write(
      `daftari distill: reading from stdin requires --source-id\n\n${DISTILL_USAGE}`,
    );
    return 2;
  }

  // ---------------------------------------------------------------------------
  // Resolve config (both modes need it; only --propose also needs the client)
  // ---------------------------------------------------------------------------

  const configRes = resolveDistillConfig(vaultRoot);
  if (!configRes.ok) {
    process.stderr.write(`daftari distill: ${configRes.error.message}\n`);
    return 3;
  }

  // Apply CLI overrides to a mutable copy of config.
  const config: DistillConfig = {
    ...configRes.value,
    ...(maxLlmCallsFlag !== undefined ? { maxLlmCalls: maxLlmCallsFlag } : {}),
    ...(maxClaimsFlag !== undefined ? { maxClaims: maxClaimsFlag } : {}),
    ...(modelFlag !== undefined ? { model: modelFlag } : {}),
  };

  // ---------------------------------------------------------------------------
  // Read source content
  // ---------------------------------------------------------------------------

  // I3: guard stdin TTY before attempting to read (would block forever).
  if (sourceArg === "-" && process.stdin.isTTY) {
    process.stderr.write(
      `daftari distill: stdin is a terminal — pipe content or pass a file path\n`,
    );
    return 2;
  }

  let sourceContent: string;
  try {
    if (sourceArg === "-") {
      // Read stdin synchronously (distill is not a long-running server).
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      }
      sourceContent = Buffer.concat(chunks).toString("utf-8");
    } else {
      sourceContent = readFileSync(resolve(sourceArg), "utf-8");
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`daftari distill: cannot read source: ${reason}\n`);
    return 2;
  }

  // Stable source identity: explicit flag wins, else derive from filename.
  const sourceId = sourceIdFlag ?? (sourceArg === "-" ? "stdin" : sourceIdFromPath(sourceArg));

  // ---------------------------------------------------------------------------
  // Parse + chunk (both modes)
  // ---------------------------------------------------------------------------

  // Adapter selection (R5): explicit --source-type wins; else auto-detect by
  // extension (.jsonl → claude-session), stdin/other → chat-transcript.
  const sourceType =
    sourceTypeFlag ??
    (sourceArg !== "-" && sourceArg.toLowerCase().endsWith(".jsonl")
      ? "claude-session"
      : "chat-transcript");
  const adapter: SourceAdapter = ADAPTER_REGISTRY[sourceType];
  let messages = adapter.parse(sourceContent);
  if (senderFlag !== undefined) {
    messages = messages.filter((m) => m.sender === senderFlag); // R6
  }
  const chunks = chunkMessages(messages);

  // ---------------------------------------------------------------------------
  // --plan: zero-spend estimate
  // ---------------------------------------------------------------------------

  if (mode === "plan") {
    const plan = planDistill(chunks, config);

    const costLine =
      plan.estimatedCostUSD === 0
        ? "$0.00 (no chunks)"
        : `~$${plan.estimatedCostUSD.toFixed(4)}${plan.priced ? "" : " (Haiku fallback pricing — model not in price table)"}`;

    process.stdout.write(
      [
        `distill --plan`,
        `  source:              ${sourceArg}`,
        `  source-id:           ${sourceId}`,
        `  vault:               ${vaultRoot}`,
        `  model:               ${plan.model}`,
        `  chunks:              ${plan.chunkCount}`,
        `  estimated LLM calls: ${plan.estimatedLlmCalls}`,
        `  estimated cost:      ${costLine}`,
        ``,
        `Run with --propose to extract claims and stage proposals.`,
        ``,
      ].join("\n"),
    );
    return 0;
  }

  // ---------------------------------------------------------------------------
  // --propose: full extraction + staging
  // ---------------------------------------------------------------------------

  // C1: single transport resolution — resolveDistillClient owns transport
  // selection and returns the transport it actually used. Reading provider
  // from clientRes.value.transport ensures the receipt matches the client.
  const clientRes = resolveDistillClient(vaultRoot, transportFlag);
  if (!clientRes.ok) {
    process.stderr.write(`daftari distill: ${clientRes.error.message}\n`);
    return 3;
  }
  const transport: LlmTransport = clientRes.value.transport;

  const budgetedClient = withCallBudget(clientRes.value.client, config.maxLlmCalls);

  const runId = makeRunId();

  process.stderr.write(
    `daftari distill: extracting claims from ${sourceId} ` +
      `(${chunks.length} chunks, max ${config.maxLlmCalls} LLM calls)...\n`,
  );

  const outcome = await extractClaims(chunks, budgetedClient, {
    model: config.model,
    maxClaims: config.maxClaims,
    inCallInputCap: config.inCallInputCap,
  });

  if (outcome.chunkErrors.length > 0) {
    process.stderr.write(`daftari distill: ${outcome.chunkErrors.length} chunk error(s):\n`);
    for (const ce of outcome.chunkErrors) {
      process.stderr.write(`  [${ce.anchor}] ${ce.error}\n`);
    }
  }

  // U8: build the overlap-hinter from the vault's local search index.
  // No AccessContext on the CLI path (single-user, no RBAC filter needed);
  // vaultSearch tolerates undefined access — RBAC filter only applies when
  // access is present.
  const hinter = makeOverlapHinter(vaultRoot);

  // Stage proposals via distillUpsert (idempotent join).
  const upsertRes = await distillUpsert(vaultRoot, {
    sourceId,
    sourceContent,
    claims: outcome.claims,
    runId,
    overlapSearch: hinter,
  });

  if (!upsertRes.ok) {
    process.stderr.write(`daftari distill: staging error: ${upsertRes.error.message}\n`);
    return 4;
  }

  const upsert = upsertRes.value;

  const receipt = buildReceipt({
    outcome,
    config,
    provider: transport,
    zdr,
    sourceId,
  });

  // Summary to stdout.
  process.stdout.write(
    [
      `distill --propose complete`,
      `  run-id:        ${runId}`,
      `  source-id:     ${sourceId}`,
      `  model:         ${receipt.model}`,
      `  LLM calls:     ${receipt.llmCalls}`,
      `  claims:        ${receipt.claimsProduced}`,
      `  skipped:       ${upsert.skipped.length}`,
      `  updated:       ${upsert.updated.length}`,
      `  created:       ${upsert.created.length}`,
      `  noop:          ${upsert.noop}`,
      `  truncated:     ${receipt.truncated}`,
      `  approx cost:   ~$${receipt.approxCostUSD.toFixed(4)}`,
      `  state written: ${upsert.stateWritten}`,
      ``,
    ].join("\n"),
  );

  // I4: warn on stateWritten:false — proposals staged, but next run will
  // re-distill because the content-hash was not persisted.
  if (!upsert.stateWritten) {
    process.stderr.write(
      `daftari distill: warning: state write failed — next run will re-distill this source\n`,
    );
  }

  if (outcome.budget_exhausted) {
    process.stderr.write(
      `daftari distill: LLM call budget exhausted — run is partial (increase --max-llm-calls to continue)\n`,
    );
  }

  // Exit 4 when any proposals failed to stage.
  if (upsert.propose !== null && upsert.propose.errors.length > 0) {
    process.stderr.write(
      `daftari distill: ${upsert.propose.errors.length} proposal(s) failed to stage\n`,
    );
    return 4;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// --review: batch-ratify a prior run's staged proposals (U9)
// ---------------------------------------------------------------------------

/**
 * Recover the distill source-id and claim-key from a staged action's
 * `proposedDiff.frontmatter.sources[0]` (format `distill:<sourceId>#<claimKey>`).
 * Returns null when the action is not a distill proposal or the ref is
 * malformed — the caller still ratifies, it just cannot advance the landed map.
 */
function parseDistillRef(proposedDiff: unknown): { sourceId: string; claimKey: string } | null {
  if (typeof proposedDiff !== "object" || proposedDiff === null) return null;
  const fm = (proposedDiff as Record<string, unknown>).frontmatter;
  if (typeof fm !== "object" || fm === null) return null;
  const sources = (fm as Record<string, unknown>).sources;
  if (!Array.isArray(sources) || sources.length === 0) return null;
  const ref = sources[0];
  if (typeof ref !== "string") return null;
  const m = /^distill:(.+?)#(.+)$/.exec(ref);
  if (m === null) return null;
  return { sourceId: m[1], claimKey: m[2] };
}

/**
 * Read the corroboration score stamped onto a staged proposal's
 * `proposedDiff` (propose.ts, R7). `proposedDiff` is `unknown` at the
 * staged-action layer, so parse defensively: a missing/non-finite value
 * yields 0, mirroring the write side's default-0 semantics.
 */
function parseCorroboration(proposedDiff: unknown): number {
  if (typeof proposedDiff !== "object" || proposedDiff === null) return 0;
  const c = (proposedDiff as Record<string, unknown>).corroboration;
  return typeof c === "number" && Number.isFinite(c) ? c : 0;
}

/**
 * `daftari distill --review <run_id>` — review and batch-approve the pending
 * proposals emitted by a prior `--propose` run.
 *
 * Dry-run by default: lists the matched proposals and exits 0. With `applied`
 * (the `--yes` flag), each pending proposal is dispatched through the existing
 * `vault_ratify` path (F2: CLI-first, the MCP ratify tool is untouched) with
 * `decision: "approve"`. Each ratify writes its doc and lands its own commit
 * (F3: history per claim). After each successful land, the distill-state
 * landed map is advanced via recordLandedClaim (U5's mark-after-land hook).
 *
 * R8 corroboration gate: with `autoSafe` (and without the stronger `--yes`),
 * only proposals whose stamped corroboration meets `threshold` are ratified;
 * the rest stay queued for a human. Plain `--yes` ratifies everything and
 * ignores the threshold. When both are given, `--yes` wins (with a stderr note).
 *
 * Exit codes: 0 = success (including empty match / dry-run); 4 = one or more
 * ratifies failed.
 */
async function reviewRun(
  vaultRoot: string,
  runId: string,
  principal: string,
  applied: boolean,
  autoSafe = false,
  threshold = DEFAULT_CORROBORATION_THRESHOLD,
  yes = false,
): Promise<number> {
  const listRes = await listStagedActions(vaultRoot, "pending");
  if (!listRes.ok) {
    process.stderr.write(`daftari distill: ${listRes.error.message}\n`);
    return 4;
  }

  const matched = listRes.value.filter((a) => a.runId === runId);

  if (matched.length === 0) {
    process.stdout.write(`distill --review ${runId}\n  no pending proposals for this run.\n`);
    return 0;
  }

  // R8: --yes (plain) is the stronger signal — it ratifies everything and
  // ignores the corroboration gate. --auto-safe (without --yes) ratifies only
  // the corroborated subset. If both are given, --yes wins; note it once.
  const yesAll = yes; // plain --yes ratifies all, threshold ignored
  if (yes && autoSafe) {
    process.stderr.write("daftari distill: --yes overrides --auto-safe; ratifying all proposals\n");
  }
  const toRatify =
    autoSafe && !yesAll
      ? matched.filter((a) => parseCorroboration(a.proposedDiff) >= threshold)
      : matched;

  process.stdout.write(
    [
      `distill --review ${runId}`,
      `  ${matched.length} pending proposal(s):`,
      ...matched.map((a) => {
        const firstLine = a.rationale.split("\n", 1)[0];
        return `    ${a.id}  ${a.targetPath}${firstLine ? `  — ${firstLine}` : ""}`;
      }),
      ``,
    ].join("\n"),
  );

  if (!applied) {
    process.stdout.write(
      `Dry-run: re-run with --yes to approve all ${matched.length} proposal(s).\n`,
    );
    return 0;
  }

  let approved = 0;
  let failed = 0;
  for (const action of toRatify) {
    const ratifyRes = await vaultRatify(vaultRoot, {
      id: action.id,
      decision: "approve",
      principal,
    });
    if (!ratifyRes.ok) {
      failed++;
      process.stderr.write(
        `daftari distill: ratify ${action.id} failed: ${ratifyRes.error.message}\n`,
      );
      continue;
    }
    approved++;

    // Advance U5's landed map so a later re-distill of the same source treats
    // this claim as already-landed. A non-distill proposal sharing the run_id
    // (or a malformed ref) simply skips this step — the ratify still counts.
    const ref = parseDistillRef(action.proposedDiff);
    if (ref === null) {
      process.stderr.write(
        `daftari distill: ${action.id} landed but has no distill source ref — landed map not advanced\n`,
      );
      continue;
    }
    const landed = recordLandedClaim(vaultRoot, ref.sourceId, ref.claimKey, action.targetPath);
    if (!landed.ok) {
      process.stderr.write(
        `daftari distill: ${action.id} landed but state update failed: ${landed.error.message}\n`,
      );
    }
  }

  // queued-below-threshold is only meaningful on the --auto-safe path, where
  // the corroboration gate held some proposals back for a human.
  const queued = matched.length - toRatify.length;
  process.stdout.write(
    [
      `distill --review complete`,
      `  run-id:     ${runId}`,
      `  approved:   ${approved}`,
      ...(autoSafe && !yesAll ? [`  queued (below threshold): ${queued}`] : []),
      `  failed:     ${failed}`,
      ``,
    ].join("\n"),
  );

  return failed > 0 ? 4 : 0;
}
