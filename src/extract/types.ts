// src/extract/types.ts
// Provider-neutral document-extraction contract. Defines request/result
// shapes and the failure taxonomy for src/extract/. No Graph/Microsoft
// imports belong here — the real docx/pptx/pdf parsers are wired in by
// later units (U7/U8/U9); this unit only builds the harness they plug into.

export const EXTRACT_KINDS = ["docx", "pptx", "pdf"] as const;
export type ExtractKind = (typeof EXTRACT_KINDS)[number];

export function isExtractKind(value: unknown): value is ExtractKind {
  return (EXTRACT_KINDS as readonly unknown[]).includes(value);
}

// Mirrors the extraction-relevant subset of SourceFailureReason
// (src/integrations/types.ts, added under U2) — string values are kept
// identical so a caller mapping an extract failure into
// SourceState.lastFailure.reason needs no translation table.
export const EXTRACT_REASONS = [
  "too_large",
  "encrypted",
  "malformed",
  "empty",
  "unsupported_type",
  "timeout",
  "malware",
  "permission_revoked",
  "converted_unavailable",
] as const;

export type ExtractReason = (typeof EXTRACT_REASONS)[number];

export function isExtractReason(value: unknown): value is ExtractReason {
  return (EXTRACT_REASONS as readonly unknown[]).includes(value);
}

export interface ExtractLimits {
  /** Cap on inflated bytes for a single archive entry (docx/pptx are zips). */
  maxInflatedBytesPerEntry: number;
  /** Cap on total inflated bytes across all entries in an archive. */
  maxInflatedBytesTotal: number;
  /** Cap on pages processed for a PDF. */
  maxPdfPages: number;
  /** Wall-clock budget for the whole extraction, enforced by the harness (not the worker itself). */
  wallClockMs: number;
  /**
   * Worker heap cap in MiB, enforced via worker_threads resourceLimits
   * (maxOldGenerationSizeMb). Not a hard ceiling on process memory: the
   * worker also gets a maxYoungGenerationSizeMb allowance on top, so
   * worst-case heap is old+young combined (~1.25x this value).
   */
  workerHeapMb: number;
}

// The extraction-relevant bounds from spec §11. The 25 MiB download cap is
// adapter-side (fetching the file), not part of this extraction-time budget.
export const DEFAULT_EXTRACT_LIMITS: ExtractLimits = {
  maxInflatedBytesPerEntry: 32 * 1024 * 1024,
  maxInflatedBytesTotal: 96 * 1024 * 1024,
  maxPdfPages: 500,
  wallClockMs: 60_000,
  workerHeapMb: 512,
};

export interface ExtractResult {
  text: string;
  pages?: number;
  notes?: string;
}

export interface ExtractError {
  reason: ExtractReason;
  message?: string;
}

// Shared wire contract between index.ts (main thread) and worker.ts (the
// worker_threads entry) — workerData in, postMessage out.
export interface ExtractRequest {
  bytes: Uint8Array;
  kind: ExtractKind;
  limits: ExtractLimits;
  /**
   * pptx-only: whether to append each slide's speaker notes (spec §3.2).
   * Structured-cloned into the worker alongside `limits` — unlike
   * ExtractOptions.workerUrl/execArgv (main-thread-only Worker-construction
   * seams), this is real request data the worker driver reads. Ignored by
   * the docx driver. Defaults to `true` when unset (U8).
   */
  includeSpeakerNotes?: boolean;
}

export type ExtractWorkerResponse =
  | { ok: true; value: ExtractResult }
  | { ok: false; error: ExtractError };

export function isExtractWorkerResponse(value: unknown): value is ExtractWorkerResponse {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  const v = value as { ok: unknown };
  if (v.ok === true) return "value" in value;
  if (v.ok === false) return "error" in value;
  return false;
}
