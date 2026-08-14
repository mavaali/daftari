// Tests for the distill turn-window chunker (U3).
//
// Scenarios:
//   - Empty input → no chunks.
//   - N messages with window W → expected chunk count and index boundaries.
//   - Default window is the named CHUNK_WINDOW constant.
//   - Anchors are deterministic across runs and unique across chunks.

import { describe, expect, it } from "vitest";
import type { NormalizedMessage } from "../../src/distill/adapters/types.js";
import { CHUNK_WINDOW, chunkMessages } from "../../src/distill/chunk.js";

function msg(i: number, text = `message ${i}`): NormalizedMessage {
  return {
    ts: `2026-05-01T10:${String(i % 60).padStart(2, "0")}:00`,
    sender: i % 2 === 0 ? "Alice" : "Bob",
    type: "text",
    text,
    attachment: null,
  };
}

function msgs(n: number): NormalizedMessage[] {
  return Array.from({ length: n }, (_, i) => msg(i));
}

describe("chunkMessages — boundaries", () => {
  it("returns [] for no messages", () => {
    expect(chunkMessages([], 3)).toEqual([]);
  });

  it("splits 7 messages with window 3 into chunks [0..2],[3..5],[6..6]", () => {
    const chunks = chunkMessages(msgs(7), 3);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => [c.startIndex, c.endIndex])).toEqual([
      [0, 2],
      [3, 5],
      [6, 6],
    ]);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(chunks[0].messages).toHaveLength(3);
    expect(chunks[2].messages).toHaveLength(1);
  });

  it("puts an exact multiple of the window into full chunks only", () => {
    const chunks = chunkMessages(msgs(6), 3);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.messages.length === 3)).toBe(true);
  });

  it("uses CHUNK_WINDOW when no window is given", () => {
    const chunks = chunkMessages(msgs(CHUNK_WINDOW + 1));
    expect(chunks).toHaveLength(2);
    expect(chunks[0].messages).toHaveLength(CHUNK_WINDOW);
    expect(chunks[1].messages).toHaveLength(1);
  });
});

describe("chunkMessages — locator info", () => {
  it("carries the first message's ts", () => {
    const chunks = chunkMessages(msgs(4), 2);
    expect(chunks[0].firstTs).toBe("2026-05-01T10:00:00");
    expect(chunks[1].firstTs).toBe("2026-05-01T10:02:00");
  });

  it("renders a transcript text with sender and body", () => {
    const chunks = chunkMessages([msg(0, "hello world")], 2);
    expect(chunks[0].text).toContain("Alice");
    expect(chunks[0].text).toContain("hello world");
  });
});

describe("chunkMessages — anchor stability", () => {
  it("produces identical anchors on identical input across two runs", () => {
    const a = chunkMessages(msgs(7), 3).map((c) => c.anchor);
    const b = chunkMessages(msgs(7), 3).map((c) => c.anchor);
    expect(a).toEqual(b);
    expect(a.every((x) => x.length > 0)).toBe(true);
  });

  it("produces distinct anchors for distinct chunks", () => {
    const anchors = chunkMessages(msgs(9), 3).map((c) => c.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("changes the anchor when chunk content changes", () => {
    const a = chunkMessages([msg(0, "we picked postgres")], 3)[0].anchor;
    const b = chunkMessages([msg(0, "we picked sqlite")], 3)[0].anchor;
    expect(a).not.toBe(b);
  });
});
