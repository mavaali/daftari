// src/distill/adapters/types.ts
//
// Shared types for the distill source-adapter interface. Every adapter
// implements `SourceAdapter` and produces an array of `NormalizedMessage`
// records that the distill pipeline can chunk, extract, and propose from.

/** Structural classification of a single chat message body. */
export type MessageType = "text" | "system" | "call" | "attachment" | "edited" | "deleted";

/** One normalized message from any supported chat-export source. */
export interface NormalizedMessage {
  /** ISO 8601 timestamp: `YYYY-MM-DDTHH:MM:SS` (local time as exported). */
  ts: string;
  /** Display name of the sender, bidi marks stripped. */
  sender: string;
  /** Structural classification of the message body. */
  type: MessageType;
  /** Message text (edited-marker stripped when type === "edited"). */
  text: string;
  /**
   * Filename captured from `<attached: …>`, or `null` when the attachment is
   * present but unnamed (e.g. "image omitted"). Always `null` for non-attachment
   * types.
   */
  attachment: string | null;
}

/**
 * Contract every chat-export adapter must satisfy.
 *
 * Implementations are pure functions over a raw string: no I/O, no state.
 * The caller is responsible for reading the file; the adapter only parses.
 */
export interface SourceAdapter {
  /**
   * Stable identifier for this adapter (e.g. `"chat-transcript"`).
   * Used for logging and adapter-registry lookup.
   */
  sourceId(): string;

  /**
   * Parse the raw content of a chat export and return normalized messages in
   * chronological order. Must not throw on malformed input — skip unparseable
   * lines instead. Empty input returns `[]`.
   */
  parse(raw: string): NormalizedMessage[];
}
