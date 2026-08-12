// src/distill/adapters/chat-transcript.ts
//
// SourceAdapter for generic messaging-app chat exports (.txt).
// Supports both iOS export format ([M/D/YY, H:MM:SS AM/PM] Sender: body)
// and Android export format (M/D/YY, HH:MM - Sender: body).
//
// Parser rules:
//   - Unrecognized lines are treated as continuations of the previous message.
//   - Bidi control characters are stripped from sender names and body text.
//   - Timestamps are normalized to ISO 8601 (YYYY-MM-DDTHH:MM:SS).
//   - 2-digit years are expanded: "26" → "2026".
//   - Message bodies are classified into MessageType by content pattern.

import type { MessageType, NormalizedMessage, SourceAdapter } from "./types.js";

// ---------------------------------------------------------------------------
// Bidi stripping
// ---------------------------------------------------------------------------

// Unicode bidirectional control characters present in some messaging exports.
// U+200E, U+200F, U+202A–U+202C, U+2066–U+2069
const BIDI_RE = /[\u200E\u200F\u202A-\u202C\u2066-\u2069]/g;

function stripBidi(s: string): string {
  return s.replace(BIDI_RE, "");
}

// ---------------------------------------------------------------------------
// Line-start patterns
// ---------------------------------------------------------------------------

// iOS: optional leading bidi chars, then [M/D/YY, H:MM:SS AM/PM] Sender: body
// Groups: 1=date, 2=time (with optional seconds), 3=sender, 4=body
const IOS_LINE_RE =
  /^[\u200E\u200F\u202A-\u202C\u2066-\u2069]*\[(\d{1,2}\/\d{1,2}\/\d{2,4}), (\d{1,2}:\d{2}(?::\d{2})? ?[AP]M)\] (.+?): (.*)$/;

// Android: M/D/YY, HH:MM - Sender: body  (24-hour, no seconds)
// Groups: 1=date, 2=time (HH:MM), 3=sender, 4=body
const ANDROID_LINE_RE = /^(\d{1,2}\/\d{1,2}\/\d{2,4}), (\d{2}:\d{2}) - (.+?): (.*)$/;

// ---------------------------------------------------------------------------
// Timestamp normalisation
// ---------------------------------------------------------------------------

function expandYear(y: string): number {
  const n = Number.parseInt(y, 10);
  if (y.length <= 2) return n < 100 ? 2000 + n : n;
  return n;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Parse an iOS-style time string ("6:57:23 PM", "9:05 AM") to { h, m, s },
 * or null when the hour is outside the valid 12-hour range (1–12).
 * Handles 12-hour clock correctly: 12 AM → 0, 12 PM → 12.
 * Returns null for malformed inputs such as "13:00:00 PM" (raw hour 13),
 * which would otherwise produce an out-of-range ISO hour like 25.
 */
function parseIosTime(t: string): { h: number; m: number; s: number } | null {
  const cleaned = t.trim();
  const isPM = /PM$/i.test(cleaned);
  const isAM = /AM$/i.test(cleaned);
  const timePart = cleaned.replace(/ ?[AP]M$/i, "").trim();
  const parts = timePart.split(":").map((p) => Number.parseInt(p, 10));
  let h = parts[0];
  const m = parts[1] ?? 0;
  const s = parts[2] ?? 0;

  // A valid 12-hour clock hour is 1–12; 0 and 13+ are not representable.
  if (h < 1 || h > 12) return null;

  if (isAM && h === 12) h = 0;
  else if (isPM && h !== 12) h += 12;

  return { h, m, s };
}

function iosToIso(date: string, time: string): string | null {
  const [mStr, dStr, yStr] = date.split("/");
  const year = expandYear(yStr);
  const month = Number.parseInt(mStr, 10);
  const day = Number.parseInt(dStr, 10);
  const parsed = parseIosTime(time);
  if (parsed === null) return null;
  const { h, m, s } = parsed;
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function androidToIso(date: string, time: string): string {
  const [mStr, dStr, yStr] = date.split("/");
  const year = expandYear(yStr);
  const month = Number.parseInt(mStr, 10);
  const day = Number.parseInt(dStr, 10);
  const [hStr, mStr2] = time.split(":");
  const h = Number.parseInt(hStr, 10);
  const min = Number.parseInt(mStr2, 10);
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(h)}:${pad2(min)}:00`;
}

// ---------------------------------------------------------------------------
// Body classification
// ---------------------------------------------------------------------------

const OMITTED_RE = /\b(image|document|audio|video|sticker|GIF|Contact card) omitted\b/i;
const ATTACHED_RE = /^<attached: (.+?)>$/;
const EDITED_SUFFIX = "<This message was edited>";

// Classification is first-match: the order below is significant.
// A body is tested against each pattern in sequence and the first match wins.
// Order: system → deleted → call → attached → omitted → edited → text.
function classifyBody(body: string): {
  type: MessageType;
  text: string;
  attachment: string | null;
} {
  // End-to-end encryption system notice
  if (body.includes("end-to-end encrypted")) {
    return { type: "system", text: body, attachment: null };
  }

  // Deleted messages
  if (body === "You deleted this message." || body === "This message was deleted.") {
    return { type: "deleted", text: body, attachment: null };
  }

  // Voice / video calls
  if (body.startsWith("Video call") || body.startsWith("Voice call")) {
    return { type: "call", text: body, attachment: null };
  }

  // <attached: filename>
  const attachedMatch = ATTACHED_RE.exec(body);
  if (attachedMatch) {
    return { type: "attachment", text: body, attachment: attachedMatch[1] };
  }

  // "image omitted" / "document omitted" / etc.
  if (OMITTED_RE.test(body)) {
    return { type: "attachment", text: body, attachment: null };
  }

  // Edited message — strip marker, trim trailing space
  if (body.endsWith(EDITED_SUFFIX)) {
    const text = body.slice(0, body.length - EDITED_SUFFIX.length).trimEnd();
    return { type: "edited", text, attachment: null };
  }

  return { type: "text", text: body, attachment: null };
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Parses a messaging-app chat-export `.txt` file into `NormalizedMessage[]`.
 *
 * Supports both iOS (`[M/D/YY, H:MM:SS AM/PM] Sender: body`) and Android
 * (`M/D/YY, HH:MM - Sender: body`) export formats. Continuation lines
 * (those without a leading timestamp bracket) are appended to the previous
 * message's text. Bidi marks are stripped; timestamps are normalised to ISO
 * 8601.
 */
export class ChatTranscriptAdapter implements SourceAdapter {
  sourceId(): string {
    return "chat-transcript";
  }

  parse(raw: string): NormalizedMessage[] {
    if (!raw.trim()) return [];

    const messages: NormalizedMessage[] = [];
    const lines = raw.split("\n");

    for (const line of lines) {
      const iosMatch = IOS_LINE_RE.exec(line);
      if (iosMatch) {
        const [, date, time, rawSender, rawBody] = iosMatch;
        const ts = iosToIso(date, time);
        // Malformed timestamp (e.g. hour outside 1–12): skip the line entirely.
        if (ts === null) continue;
        const sender = stripBidi(rawSender.trim());
        const body = stripBidi(rawBody);
        const { type, text, attachment } = classifyBody(body);
        messages.push({ ts, sender, type, text, attachment });
        continue;
      }

      const androidMatch = ANDROID_LINE_RE.exec(line);
      if (androidMatch) {
        const [, date, time, rawSender, rawBody] = androidMatch;
        const sender = stripBidi(rawSender.trim());
        const body = stripBidi(rawBody);
        const ts = androidToIso(date, time);
        const { type, text, attachment } = classifyBody(body);
        messages.push({ ts, sender, type, text, attachment });
        continue;
      }

      // Continuation: append to the last message's text.
      if (messages.length > 0) {
        const last = messages[messages.length - 1];
        last.text += `\n${line}`;
      }
      // No prior message: ignore the line (orphan continuation).
    }

    return messages;
  }
}
