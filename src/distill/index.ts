// src/distill/index.ts
//
// `distill` module — compile-on-ingest pipeline orchestrator.
//
// Pipeline shape:
//
//   distill(raw, adapter)
//     -> parse   : adapter.parse(raw)         → NormalizedMessage[]   [U1 DONE]
//     -> chunk   : split messages into chunks  → Chunk[]               [U3 DONE]
//     -> extract : LLM-driven claim extraction → RawClaim[]            [U3 DONE — extractClaims, CLI-wired in U7]
//     -> propose : map to vault proposals      → VaultProposal[]       [U4 TODO]
//
// The orchestrator stays a thin synchronous stub: it parses and chunks, but
// extraction (needs an LLM client + call budget) and proposals return empty
// arrays until the CLI orchestration wires them.
//
// runDistill (U7) is the async CLI front door that wires --plan / --propose.

export type { DistillConfig } from "../utils/config.js";
export { ChatTranscriptAdapter } from "./adapters/chat-transcript.js";
export type { MessageType, NormalizedMessage, SourceAdapter } from "./adapters/types.js";
export { CHUNK_WINDOW, type Chunk, chunkMessages } from "./chunk.js";
export {
  type ExtractedClaim,
  type ExtractOpts,
  type ExtractOutcome,
  extractClaims,
} from "./extract.js";

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { withCallBudget } from "../consolidate/call-budget.js";
import { createAnthropicClient, type LlmClient } from "../eval/llm.js";
import {
  createOpenRouterClient,
  type LlmTransport,
  resolveTransport,
} from "../eval/llm-openrouter.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { type DistillConfig, loadConfig } from "../utils/config.js";
import { ChatTranscriptAdapter } from "./adapters/chat-transcript.js";
import type { SourceAdapter } from "./adapters/types.js";
import { type Chunk, chunkMessages } from "./chunk.js";
import { buildReceipt, planDistill } from "./cost.js";
import type { ExtractedClaim } from "./extract.js";
import { extractClaims } from "./extract.js";
import { distillUpsert } from "./state.js";

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

/** Built-in adapter registry, keyed by sourceId(). */
export const ADAPTER_REGISTRY: Record<string, SourceAdapter> = {
  "chat-transcript": new ChatTranscriptAdapter(),
};

// ---------------------------------------------------------------------------
// Internal LLM client + config gate (U2)
// ---------------------------------------------------------------------------

/**
 * Resolved distill client and config, returned by `resolveDistillClient`.
 * Later units receive this via dependency injection so they never re-load
 * config or re-construct the client.
 */
export interface ResolvedDistill {
  client: LlmClient;
  config: DistillConfig;
  /** The transport that was actually resolved and used to build `client`. */
  transport: LlmTransport;
}

// ---------------------------------------------------------------------------
// Shared error messages (m1 — deduplicate refuse string)
// ---------------------------------------------------------------------------

const DISTILL_NOT_CONFIGURED_MSG =
  "distill not configured: add a 'distill:' block to .daftari/config.yaml " +
  "with at least 'model' set before running the distill pipeline";

// Transport-aware LLM construction — mirrors the pattern in src/consolidate
// and src/sleep: check the API key BEFORE calling the constructor so a
// missing key produces a clear error rather than the client's internal throw.
function constructLlm(transport: "anthropic" | "openrouter"): Result<LlmClient, Error> {
  const keyVar = transport === "openrouter" ? "OPENROUTER_API_KEY" : "ANTHROPIC_API_KEY";
  if (!process.env[keyVar]) {
    return err(new Error(`${keyVar} env var is required (transport: ${transport})`));
  }
  try {
    return ok(transport === "openrouter" ? createOpenRouterClient() : createAnthropicClient());
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * Resolves the distill config from `vaultRoot` and constructs an LLM client.
 *
 * Refuses to run (returns `err`) when:
 *   - The config cannot be loaded (malformed yaml, I/O error).
 *   - The `distill:` block is absent — no silent default spend.
 *   - The resolved transport's API key is missing — fail-fast before any
 *     network call (mirrors the consolidate/sleep posture).
 *
 * Transport defaults to `anthropic`; the caller may override via the
 * `DAFTARI_LLM_TRANSPORT` env var or by passing an explicit value.
 *
 * @param vaultRoot - Absolute path to the vault root.
 * @param transport - Optional explicit transport override (CLI flag value).
 */
export function resolveDistillClient(
  vaultRoot: string,
  transport?: string,
): Result<ResolvedDistill, Error> {
  const cfg = loadConfig(vaultRoot);
  if (!cfg.ok) return err(cfg.error);

  if (!cfg.value.distill) {
    return err(new Error(DISTILL_NOT_CONFIGURED_MSG));
  }
  const distillCfg = cfg.value.distill;

  const transportRes = resolveTransport(transport);
  if (!transportRes.ok) return err(transportRes.error);

  const llmRes = constructLlm(transportRes.value);
  if (!llmRes.ok) return err(llmRes.error);

  return ok({ client: llmRes.value, config: distillCfg, transport: transportRes.value });
}

// ---------------------------------------------------------------------------
// Pipeline stub
// ---------------------------------------------------------------------------

// Placeholder types for the stages that later units will fill in.
// Defined here so the orchestrator's return type is stable across unit work.

/** Extracted claims are the distill pipeline's "raw claim" (U3). */
export type RawClaim = ExtractedClaim;

/** Placeholder — U4 will replace with a real VaultProposal definition. */
// biome-ignore lint/suspicious/noEmptyInterface: intentional stub for U4
export interface VaultProposal {}

export interface DistillResult {
  /** Parsed messages from the adapter (U1). */
  messages: ReturnType<SourceAdapter["parse"]>;
  /** Chunked message windows (U3). */
  chunks: Chunk[];
  /**
   * Extracted raw claims. The extract stage (extractClaims, U3) needs an LLM
   * client + budget, which only the CLI orchestration (U7) has — so this
   * synchronous entry point keeps the stub and the CLI wires extraction.
   */
  claims: RawClaim[];
  /** Vault write proposals (U4 — stub, always []). */
  proposals: VaultProposal[];
}

/**
 * Entry point for the distill pipeline.
 *
 * Currently implements only the parse stage (U1). Chunk, extract, and propose
 * stages are stubs that return empty arrays — later units will replace them
 * in-place without changing this function's signature.
 *
 * @param raw     - Raw content of the source file (e.g. a chat export .txt).
 * @param adapter - SourceAdapter instance to use for parsing.
 */
export function distill(raw: string, adapter: SourceAdapter): DistillResult {
  // U1: parse
  const messages = adapter.parse(raw);

  // U3: chunk messages into turn windows
  const chunks = chunkMessages(messages);

  // U3: extraction lives in extractClaims (needs an LLM client + budget) —
  // the CLI (U7) wires it; this synchronous stub keeps claims empty.
  const claims: RawClaim[] = [];

  // U4 TODO: map raw claims to vault write proposals
  const proposals: VaultProposal[] = [];

  return { messages, chunks, claims, proposals };
}

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
  --plan               Print a cost/call estimate without making any LLM calls.
                       This is the default when neither --plan nor --propose is given.
  --propose            Run the full pipeline: extract claims and stage proposals
                       into the vault. Requires an API key and a distill: config block.
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
  4   Partial-emit failure (some claims failed to stage on --propose).
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
 * Parses argv, validates inputs, then routes to either:
 *   --plan (default): zero-spend pre-flight estimate.
 *   --propose:        full LLM-driven extraction + staged proposals.
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

  const sourceIdRes = readString(argv, "--source-id");
  if (sourceIdRes === MISSING_FLAG_VALUE) {
    process.stderr.write(`daftari distill: --source-id requires a value\n\n${DISTILL_USAGE}`);
    return 2;
  }
  const sourceIdFlag = sourceIdRes;

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
    "--transport",
    "--max-llm-calls",
    "--max-claims",
    "--model",
  ]);
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--plan" || a === "--propose" || a === "--zdr" || a === "--help" || a === "-h") {
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

  // Adapter selection: v1 uses chat-transcript for all sources.
  // Future adapters plug in here once the registry grows.
  const adapter: SourceAdapter = ADAPTER_REGISTRY["chat-transcript"];
  const messages = adapter.parse(sourceContent);
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

  // Stage proposals via distillUpsert (idempotent join).
  const upsertRes = await distillUpsert(vaultRoot, {
    sourceId,
    sourceContent,
    claims: outcome.claims,
    runId,
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
