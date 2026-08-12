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

import { createAnthropicClient, type LlmClient } from "../eval/llm.js";
import { createOpenRouterClient, resolveTransport } from "../eval/llm-openrouter.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { type DistillConfig, loadConfig } from "../utils/config.js";
import { ChatTranscriptAdapter } from "./adapters/chat-transcript.js";
import type { SourceAdapter } from "./adapters/types.js";
import { type Chunk, chunkMessages } from "./chunk.js";
import type { ExtractedClaim } from "./extract.js";

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
}

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
    return err(
      new Error(
        "distill not configured: add a 'distill:' block to .daftari/config.yaml " +
          "with at least 'model' set before running the distill pipeline",
      ),
    );
  }
  const distillCfg = cfg.value.distill;

  const transportRes = resolveTransport(transport);
  if (!transportRes.ok) return err(transportRes.error);

  const llmRes = constructLlm(transportRes.value);
  if (!llmRes.ok) return err(llmRes.error);

  return ok({ client: llmRes.value, config: distillCfg });
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
