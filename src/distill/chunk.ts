// src/distill/chunk.ts
//
// Turn-window chunker (U3, distill stage 2). Splits a chronological
// NormalizedMessage[] into fixed-size windows of consecutive messages. Each
// chunk carries locator info (index range, first-message ts) plus a stable
// content-derived anchor, so downstream claim keys survive re-runs of the
// same source (the load-bearing contract for U5's idempotent upsert).

import { sha256Hex } from "../utils/hash.js";
import type { NormalizedMessage } from "./adapters/types.js";

/**
 * Number of consecutive messages per chunk. Turn-window chunking is the
 * deliberately simple v1 strategy; the strategy itself (window size, overlap,
 * topic-boundary splitting) is a deferred-to-implementation knob — revisit
 * once real transcripts show where claims straddle window boundaries.
 */
export const CHUNK_WINDOW = 30;

/** One turn-window over the source message array. */
export interface Chunk {
  /** 0-based position of this chunk within the run. */
  index: number;
  /** Index of the first message in the source array (inclusive). */
  startIndex: number;
  /** Index of the last message in the source array (inclusive). */
  endIndex: number;
  /** Timestamp of the chunk's first message — human-readable locator. */
  firstTs: string;
  /** The messages in this window. */
  messages: NormalizedMessage[];
  /** Rendered transcript of the window, fed to the extraction prompt. */
  text: string;
  /**
   * Stable anchor: hex digest of (start index, first ts, rendered text).
   * Same source ⇒ same anchors on a re-run; content edits change it.
   */
  anchor: string;
}

// One line per message: "[ts] sender: text". Attachment-only messages render
// their filename so the LLM sees that something was shared.
function renderMessage(m: NormalizedMessage): string {
  const body =
    m.type === "attachment" && m.text.length === 0
      ? `<attached: ${m.attachment ?? "file"}>`
      : m.text;
  return `[${m.ts}] ${m.sender}: ${body}`;
}

/**
 * Split `messages` into consecutive windows of `window` messages. The final
 * chunk may be shorter. Empty input returns `[]`. Pure — no I/O, no LLM.
 */
export function chunkMessages(
  messages: NormalizedMessage[],
  window: number = CHUNK_WINDOW,
): Chunk[] {
  const chunks: Chunk[] = [];
  for (let start = 0; start < messages.length; start += window) {
    const slice = messages.slice(start, start + window);
    const text = slice.map(renderMessage).join("\n");
    const firstTs = slice[0].ts;
    chunks.push({
      index: chunks.length,
      startIndex: start,
      endIndex: start + slice.length - 1,
      firstTs,
      messages: slice,
      text,
      anchor: sha256Hex(`${start}|${firstTs}|${text}`).slice(0, 12),
    });
  }
  return chunks;
}
