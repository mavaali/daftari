// src/distill/adapters/claude-session.ts
//
// SourceAdapter for Claude Code / bot session JSONL logs.
// Each input line is one JSON record. Only user/assistant turns become
// NormalizedMessage rows; tool_use/tool_result/thinking blocks and all
// bot/system event types are dropped. Pure: no I/O, never throws on a
// malformed line (that line is skipped).

import type { NormalizedMessage, SourceAdapter } from "./types.js";

// Top-level record types that carry human/assistant prose. Everything else
// (progress, queue-operation, last-prompt, pr-link, system, unknown) is dropped.
const KEPT_TYPES = new Set(["user", "assistant"]);

// Pull human-facing prose out of a record's `.message.content`. A string is
// used verbatim; an array keeps only `type:"text"` blocks (with a string
// `.text`) in order, dropping tool_use / tool_result / thinking blocks (R3).
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "text" &&
      typeof (block as Record<string, unknown>).text === "string"
    ) {
      parts.push((block as Record<string, unknown>).text as string);
    }
  }
  return parts.join("\n");
}

export class ClaudeSessionAdapter implements SourceAdapter {
  sourceId(): string {
    return "claude-session";
  }

  parse(raw: string): NormalizedMessage[] {
    if (!raw.trim()) return [];

    const messages: NormalizedMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;

      let rec: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        if (parsed === null || typeof parsed !== "object") continue;
        rec = parsed as Record<string, unknown>;
      } catch {
        continue; // malformed/truncated line — skip, never throw (R1)
      }

      const topType = rec.type;
      if (typeof topType !== "string" || !KEPT_TYPES.has(topType)) continue;

      const ts = rec.timestamp;
      if (typeof ts !== "string" || ts.length < 19) continue;

      const message = rec.message;
      if (message === null || typeof message !== "object") continue;
      const msg = message as Record<string, unknown>;

      // R4: message.role wins when it names a valid sender, else the top-level type.
      const sender =
        msg.role === "user" || msg.role === "assistant" ? (msg.role as string) : topType;

      const text = extractText(msg.content).trim();
      if (text === "") continue;

      messages.push({ ts: ts.slice(0, 19), sender, type: "text", text, attachment: null });
    }

    return messages;
  }
}
