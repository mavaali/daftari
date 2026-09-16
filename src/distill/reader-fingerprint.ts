// src/distill/reader-fingerprint.ts
//
// Reader provenance fingerprint (f3h). A "reader" is the LLM run configuration
// that compiled a distilled belief: which model was requested/served, at what
// effective temperature, whether it went through the retry branch, and a short
// hash of the effective extraction prompt contract. propose.ts stamps these
// onto each belief's frontmatter (as declared-optional schema_extensions) at
// ingest; later merge/tension/canon beads UNION the `readers` set, so the
// encoder here is the single shared source of truth for that set's element
// format. Keep it stable — a change to encodeReader's shape re-keys every
// parentage entry those beads compare.

import { sha256Hex } from "../utils/hash.js";
import type { ClaimRunMeta } from "./extract.js";
import { EXTRACT_SCHEMA, EXTRACT_SYSTEM } from "./extract.js";

/** First 8 hex chars of sha256(text). The short, stable version token form. */
export function hash8(text: string): string {
  return sha256Hex(text).slice(0, 8);
}

// The effective extraction prompt contract, serialized exactly as llm.ts's
// completeJsonWithRetry injects the schema into the system prompt
// (`JSON.stringify(opts.schema, null, 2)`). We hash EXTRACT_SYSTEM concatenated
// with that serialization so ANY change to either the system text or the JSON
// schema revs the version. We deliberately do NOT fold in the retry-prompt
// suffix (the "Your previous reply was NOT valid JSON…" reprompt): reader_via_retry
// already captures whether a belief came off the retry path, so the fingerprint
// stays keyed to the base contract rather than splitting into two versions.
const EFFECTIVE_EXTRACTION_PROMPT_CONTRACT = `${EXTRACT_SYSTEM}${JSON.stringify(
  EXTRACT_SCHEMA,
  null,
  2,
)}`;

/**
 * The 8-hex-char version token of the effective extraction prompt contract.
 * Computed once at module load — it is a pure function of two module constants,
 * so it is a stable constant for a given build. Changing EXTRACT_SYSTEM or
 * EXTRACT_SCHEMA changes this value.
 */
export const READER_PROMPT_VERSION: string = hash8(EFFECTIVE_EXTRACTION_PROMPT_CONTRACT);

// Sentinel used when effectiveTemperature is undefined, only inside the compact
// `readers` set string (a single-line encoding that cannot carry `undefined`).
// The typed `reader_temperature` frontmatter field is OMITTED entirely in that
// case — a number field cannot hold a sentinel — so this "na" lives only here.
const TEMP_NA = "na";

/**
 * Encode one reader as a compact, stable, single-line string suitable as an
 * element of the `readers` parentage SET. Shape:
 *
 *   `${requestedModel}@${effTempOrNA}|prompt=${promptVersion}|retry=${viaRetry}`
 *
 * - requestedModel is always present on ClaimRunMeta.
 * - effTempOrNA is the effective temperature, or "na" when undefined.
 * - promptVersion is the caller-supplied version token (READER_PROMPT_VERSION at
 *   ingest) — passed in rather than read from the module constant so a future
 *   caller stamping historical content can encode against the version that
 *   actually produced it.
 * - viaRetry defaults to false when undefined (mirrors reader_via_retry).
 *
 * One belief carries exactly ONE reader at ingest; the SET grows only when a
 * merge unions parents. The encoding is intentionally free of characters that a
 * later parser would need to escape (no commas, no newlines).
 */
export function encodeReader(runMeta: ClaimRunMeta, promptVersion: string): string {
  const effTemp =
    runMeta.effectiveTemperature === undefined ? TEMP_NA : String(runMeta.effectiveTemperature);
  const retry = runMeta.viaRetry ?? false;
  return `${runMeta.requestedModel}@${effTemp}|prompt=${promptVersion}|retry=${retry}`;
}

// ---------------------------------------------------------------------------
// Reader lineage (6mf.4)
// ---------------------------------------------------------------------------

/** Discriminant for the operation that produced a lineage entry. */
export type LineageOp = "ingest" | "update" | "revision";

/** A parsed lineage entry. `reader` is the full `encodeReader` string (may contain pipes). */
export interface ParsedLineageEntry {
  ts: string;
  op: string;
  reader: string;
}

/**
 * Encode one lineage entry as `<ts>|<op>|<reader>`.
 * `reader` is an already-encoded reader string (may itself contain pipes);
 * the first two pipes are the field delimiters — all further pipes belong to reader.
 */
export function encodeLineageEntry(ts: string, op: LineageOp, reader: string): string {
  return `${ts}|${op}|${reader}`;
}

/**
 * Parse a lineage entry produced by `encodeLineageEntry`.
 * Splits on the FIRST two `|` only so the reader (which may contain pipes) is preserved.
 * Returns null for malformed input (fewer than 2 separators or empty string).
 */
export function parseLineageEntry(entry: string): ParsedLineageEntry | null {
  if (!entry) return null;
  const first = entry.indexOf("|");
  if (first === -1) return null;
  const second = entry.indexOf("|", first + 1);
  if (second === -1) return null;
  const ts = entry.slice(0, first);
  const op = entry.slice(first + 1, second);
  const reader = entry.slice(second + 1);
  if (!ts || !op || !reader) return null;
  return { ts, op, reader };
}

/**
 * Materialise the SET-projection of a lineage: the deduplicated list of reader
 * strings, in first-seen order. Malformed entries are silently skipped.
 */
export function readersFromLineage(lineage: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of lineage) {
    const parsed = parseLineageEntry(entry);
    if (!parsed) continue;
    if (!seen.has(parsed.reader)) {
      seen.add(parsed.reader);
      result.push(parsed.reader);
    }
  }
  return result;
}

/**
 * Append-only union of two lineages.
 * Starts from `existing` (order preserved, never re-sorted).
 * For each entry in `incoming`, appends iff no existing entry shares the same `(op, reader)` pair
 * (timestamp is ignored for dedup — a duplicate re-append is declined).
 */
export function unionLineage(existing: string[], incoming: string[]): string[] {
  // Build a set of (op,reader) keys from existing
  const existingKeys = new Set<string>();
  for (const entry of existing) {
    const parsed = parseLineageEntry(entry);
    if (parsed) existingKeys.add(`${parsed.op}\x00${parsed.reader}`);
  }
  const result = [...existing];
  for (const entry of incoming) {
    const parsed = parseLineageEntry(entry);
    if (!parsed) continue;
    const key = `${parsed.op}\x00${parsed.reader}`;
    if (!existingKeys.has(key)) {
      existingKeys.add(key);
      result.push(entry);
    }
  }
  return result;
}

/**
 * Encode a revision-panel reader fingerprint.
 * Shape: `<model>@na|prompt=<hash8(SYSTEM_BASE+templates)>|retry=false`
 * The prompt hash here is the READER_PROMPT_VERSION (extraction contract),
 * re-used as the closest stable contract identifier for the revision panel.
 */
export function encodeRevisionReader(model: string): string {
  return `${model}@${TEMP_NA}|prompt=${READER_PROMPT_VERSION}|retry=false`;
}
