// Tests for the chat-transcript SourceAdapter.
// Covers the parser rules spec'd in the U1 task: iOS format, Android format,
// continuation lines, attachment detection, call lines, edited/deleted markers,
// system notices, and empty input.

import { describe, expect, it } from "vitest";
import { ChatTranscriptAdapter } from "../../src/distill/adapters/chat-transcript.js";

const adapter = new ChatTranscriptAdapter();

describe("ChatTranscriptAdapter.sourceId", () => {
  it("returns a stable identifier", () => {
    expect(adapter.sourceId()).toBe("chat-transcript");
  });
});

describe("ChatTranscriptAdapter.parse — empty input", () => {
  it("returns [] for empty string", () => {
    expect(adapter.parse("")).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(adapter.parse("   \n\n   ")).toEqual([]);
  });
});

describe("ChatTranscriptAdapter.parse — iOS format", () => {
  it("parses a single iOS message line", () => {
    const raw = "[5/25/26, 6:57:23 PM] Sandy: hello";
    const msgs = adapter.parse(raw);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].sender).toBe("Sandy");
    expect(msgs[0].text).toBe("hello");
    expect(msgs[0].type).toBe("text");
    // ts must be ISO 8601
    expect(msgs[0].ts).toBe("2026-05-25T18:57:23");
    expect(msgs[0].attachment).toBeNull();
  });

  it("parses AM timestamps correctly", () => {
    const raw = "[1/3/26, 9:05:00 AM] Alice: morning";
    const msgs = adapter.parse(raw);
    expect(msgs[0].ts).toBe("2026-01-03T09:05:00");
  });

  it("parses 12:xx PM as noon (not 00:xx)", () => {
    const raw = "[6/1/26, 12:30:00 PM] Bob: lunch";
    const msgs = adapter.parse(raw);
    expect(msgs[0].ts).toBe("2026-06-01T12:30:00");
  });

  it("parses 12:xx AM as midnight", () => {
    const raw = "[6/1/26, 12:00:00 AM] Alice: midnight";
    const msgs = adapter.parse(raw);
    expect(msgs[0].ts).toBe("2026-06-01T00:00:00");
  });

  it("strips bidi control characters from sender and text", () => {
    // U+200E (left-to-right mark) before sender name, inside text
    const raw = "[5/25/26, 6:57:23 PM] \u200ESandy\u200E: hello\u200F";
    const msgs = adapter.parse(raw);
    expect(msgs[0].sender).toBe("Sandy");
    expect(msgs[0].text).toBe("hello");
  });
});

describe("ChatTranscriptAdapter.parse — Android format", () => {
  it("parses a single Android message line", () => {
    const raw = "5/25/26, 18:57 - Alice: hi there";
    const msgs = adapter.parse(raw);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].sender).toBe("Alice");
    expect(msgs[0].text).toBe("hi there");
    expect(msgs[0].type).toBe("text");
    expect(msgs[0].ts).toBe("2026-05-25T18:57:00");
    expect(msgs[0].attachment).toBeNull();
  });
});

describe("ChatTranscriptAdapter.parse — continuation lines", () => {
  it("appends a continuation line to the previous message text", () => {
    const raw = "[5/25/26, 6:57:23 PM] Sandy: hello\nworld";
    const msgs = adapter.parse(raw);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("hello\nworld");
  });

  it("appends multiple continuation lines in sequence", () => {
    const raw = "[5/25/26, 6:57:23 PM] Sandy: line1\nline2\nline3";
    const msgs = adapter.parse(raw);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].text).toBe("line1\nline2\nline3");
  });

  it("ignores a continuation line with no prior message", () => {
    const raw = "orphan continuation line";
    const msgs = adapter.parse(raw);
    expect(msgs).toHaveLength(0);
  });

  it("does not confuse the second message header as a continuation", () => {
    const raw = "[5/25/26, 6:57:23 PM] Sandy: hello\n[5/25/26, 6:58:00 PM] Bob: bye";
    const msgs = adapter.parse(raw);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].text).toBe("hello");
    expect(msgs[1].text).toBe("bye");
  });
});

describe("ChatTranscriptAdapter.parse — attachment lines", () => {
  it("classifies <attached: file.pdf> as attachment with filename", () => {
    const raw = "[5/25/26, 6:57:23 PM] Sandy: <attached: report.pdf>";
    const msgs = adapter.parse(raw);
    expect(msgs[0].type).toBe("attachment");
    expect(msgs[0].attachment).toBe("report.pdf");
  });

  it("classifies 'image omitted' as attachment with null filename", () => {
    const raw = "[5/25/26, 6:57:23 PM] Sandy: image omitted";
    const msgs = adapter.parse(raw);
    expect(msgs[0].type).toBe("attachment");
    expect(msgs[0].attachment).toBeNull();
  });

  it("classifies 'document omitted' as attachment with null filename", () => {
    const raw = "[5/25/26, 6:57:23 PM] Sandy: document omitted";
    const msgs = adapter.parse(raw);
    expect(msgs[0].type).toBe("attachment");
    expect(msgs[0].attachment).toBeNull();
  });

  it("classifies 'audio omitted' as attachment", () => {
    const raw = "[5/25/26, 6:57:23 PM] Sandy: audio omitted";
    const msgs = adapter.parse(raw);
    expect(msgs[0].type).toBe("attachment");
  });

  it("classifies 'GIF omitted' as attachment (case-insensitive)", () => {
    const raw = "[5/25/26, 6:57:23 PM] Sandy: GIF omitted";
    const msgs = adapter.parse(raw);
    expect(msgs[0].type).toBe("attachment");
  });

  it("classifies 'Contact card omitted' as attachment", () => {
    const raw = "[5/25/26, 6:57:23 PM] Sandy: Contact card omitted";
    const msgs = adapter.parse(raw);
    expect(msgs[0].type).toBe("attachment");
  });
});

describe("ChatTranscriptAdapter.parse — call lines", () => {
  it("classifies 'Video call, 37 min' as call", () => {
    const raw = "[5/25/26, 6:57:23 PM] Sandy: Video call, 37 min";
    const msgs = adapter.parse(raw);
    expect(msgs[0].type).toBe("call");
    expect(msgs[0].attachment).toBeNull();
  });

  it("classifies 'Voice call, 5 min' as call", () => {
    const raw = "[5/25/26, 6:57:23 PM] Alice: Voice call, 5 min";
    const msgs = adapter.parse(raw);
    expect(msgs[0].type).toBe("call");
  });
});

describe("ChatTranscriptAdapter.parse — edited messages", () => {
  it("classifies a line ending with <This message was edited> as edited and strips the marker", () => {
    const raw = "[5/25/26, 6:57:23 PM] Sandy: updated text <This message was edited>";
    const msgs = adapter.parse(raw);
    expect(msgs[0].type).toBe("edited");
    expect(msgs[0].text).toBe("updated text");
  });
});

describe("ChatTranscriptAdapter.parse — deleted messages", () => {
  it("classifies 'You deleted this message.' as deleted", () => {
    const raw = "[5/25/26, 6:57:23 PM] Sandy: You deleted this message.";
    const msgs = adapter.parse(raw);
    expect(msgs[0].type).toBe("deleted");
  });

  it("classifies 'This message was deleted.' as deleted", () => {
    const raw = "[5/25/26, 6:57:23 PM] Bob: This message was deleted.";
    const msgs = adapter.parse(raw);
    expect(msgs[0].type).toBe("deleted");
  });
});

describe("ChatTranscriptAdapter.parse — system notices", () => {
  it("classifies the end-to-end encrypted notice as system", () => {
    const raw =
      "[5/25/26, 6:57:23 PM] Sandy: Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.";
    const msgs = adapter.parse(raw);
    expect(msgs[0].type).toBe("system");
  });
});

describe("ChatTranscriptAdapter.parse — multi-message transcript", () => {
  it("correctly parses a representative multi-line transcript", () => {
    const raw = [
      "[5/25/26, 6:57:23 PM] Sandy: Messages and calls are end-to-end encrypted. No one outside of this chat, not even WhatsApp, can read or listen to them.",
      "[5/25/26, 7:00:00 PM] Alice: hey",
      "how are you",
      "[5/25/26, 7:01:00 PM] Bob: <attached: notes.pdf>",
      "[5/25/26, 7:02:00 PM] Alice: image omitted",
      "[5/25/26, 7:03:00 PM] Bob: Video call, 10 min",
      "[5/25/26, 7:04:00 PM] Alice: typo fix <This message was edited>",
      "[5/25/26, 7:05:00 PM] Bob: You deleted this message.",
    ].join("\n");

    const msgs = adapter.parse(raw);
    expect(msgs).toHaveLength(7);
    expect(msgs[0].type).toBe("system");
    expect(msgs[1].type).toBe("text");
    expect(msgs[1].text).toBe("hey\nhow are you");
    expect(msgs[1].sender).toBe("Alice");
    expect(msgs[2].type).toBe("attachment");
    expect(msgs[2].attachment).toBe("notes.pdf");
    expect(msgs[3].type).toBe("attachment");
    expect(msgs[3].attachment).toBeNull();
    expect(msgs[4].type).toBe("call");
    expect(msgs[5].type).toBe("edited");
    expect(msgs[5].text).toBe("typo fix");
    expect(msgs[6].type).toBe("deleted");
  });
});
