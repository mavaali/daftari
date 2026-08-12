// src/distill/index.ts
//
// `distill` module — compile-on-ingest pipeline orchestrator.
//
// Pipeline shape (U1 stub — later units fill chunk/extract/propose):
//
//   distill(raw, adapter)
//     -> parse   : adapter.parse(raw)         → NormalizedMessage[]   [U1 DONE]
//     -> chunk   : split messages into chunks  → Chunk[]               [U2 TODO]
//     -> extract : LLM-driven claim extraction → RawClaim[]            [U3 TODO]
//     -> propose : map to vault proposals      → VaultProposal[]       [U4 TODO]
//
// The orchestrator is intentionally a thin stub at this stage. Importing and
// calling it is safe; it will return the parsed messages and empty arrays for
// the downstream stages until those units are implemented.

export { ChatTranscriptAdapter } from "./adapters/chat-transcript.js";
export type { MessageType, NormalizedMessage, SourceAdapter } from "./adapters/types.js";

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

import { ChatTranscriptAdapter } from "./adapters/chat-transcript.js";
import type { SourceAdapter } from "./adapters/types.js";

/** Built-in adapter registry, keyed by sourceId(). */
export const ADAPTER_REGISTRY: Record<string, SourceAdapter> = {
  "chat-transcript": new ChatTranscriptAdapter(),
};

// ---------------------------------------------------------------------------
// Pipeline stub
// ---------------------------------------------------------------------------

// Placeholder types for the stages that later units will fill in.
// Defined here so the orchestrator's return type is stable across unit work.

/** Placeholder — U2 will replace with a real Chunk definition. */
// biome-ignore lint/suspicious/noEmptyInterface: intentional stub for U2
export interface Chunk {}

/** Placeholder — U3 will replace with a real RawClaim definition. */
// biome-ignore lint/suspicious/noEmptyInterface: intentional stub for U3
export interface RawClaim {}

/** Placeholder — U4 will replace with a real VaultProposal definition. */
// biome-ignore lint/suspicious/noEmptyInterface: intentional stub for U4
export interface VaultProposal {}

export interface DistillResult {
  /** Parsed messages from the adapter (U1). */
  messages: ReturnType<SourceAdapter["parse"]>;
  /** Chunked message windows (U2 — stub, always []). */
  chunks: Chunk[];
  /** Extracted raw claims (U3 — stub, always []). */
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

  // U2 TODO: chunk messages into overlapping windows
  const chunks: Chunk[] = [];

  // U3 TODO: extract raw claims from each chunk via LLM
  const claims: RawClaim[] = [];

  // U4 TODO: map raw claims to vault write proposals
  const proposals: VaultProposal[] = [];

  return { messages, chunks, claims, proposals };
}
