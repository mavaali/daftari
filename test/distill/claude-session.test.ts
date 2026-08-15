import { describe, expect, it } from "vitest";
import { ClaudeSessionAdapter } from "../../src/distill/adapters/claude-session.js";

const adapter = new ClaudeSessionAdapter();

function jsonl(...records: unknown[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n");
}

describe("ClaudeSessionAdapter", () => {
  it("sourceId is claude-session", () => {
    expect(adapter.sourceId()).toBe("claude-session");
  });

  it("empty input → []", () => {
    expect(adapter.parse("")).toEqual([]);
    expect(adapter.parse("   \n  ")).toEqual([]);
  });

  it("string content is used verbatim; sender + ts mapped", () => {
    const raw = jsonl({
      type: "user",
      timestamp: "2026-07-31T03:47:39.817Z",
      message: { role: "user", content: "pick up bead b6b" },
    });
    expect(adapter.parse(raw)).toEqual([
      {
        ts: "2026-07-31T03:47:39",
        sender: "user",
        type: "text",
        text: "pick up bead b6b",
        attachment: null,
      },
    ]);
  });

  it("array content keeps text blocks in order, drops tool_use/tool_result/thinking", () => {
    const raw = jsonl({
      type: "assistant",
      timestamp: "2026-07-31T03:48:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "scratchpad" },
          { type: "text", text: "First." },
          { type: "tool_use", name: "Bash", input: {} },
          { type: "text", text: "Second." },
          { type: "tool_result", content: "output" },
        ],
      },
    });
    expect(adapter.parse(raw)).toEqual([
      {
        ts: "2026-07-31T03:48:00",
        sender: "assistant",
        type: "text",
        text: "First.\nSecond.",
        attachment: null,
      },
    ]);
  });

  it("thinking-only and tool-only turns are skipped (empty text)", () => {
    const raw = jsonl(
      {
        type: "assistant",
        timestamp: "2026-07-31T03:49:00.000Z",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }] },
      },
      {
        type: "assistant",
        timestamp: "2026-07-31T03:49:01.000Z",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] },
      },
    );
    expect(adapter.parse(raw)).toEqual([]);
  });

  it("drops bot/system event types", () => {
    const raw = jsonl(
      { type: "progress", timestamp: "2026-07-31T03:50:00.000Z", body: "…" },
      { type: "queue-operation", timestamp: "2026-07-31T03:50:01.000Z" },
      { type: "last-prompt", timestamp: "2026-07-31T03:50:02.000Z" },
      { type: "pr-link", timestamp: "2026-07-31T03:50:03.000Z" },
      { type: "system", timestamp: "2026-07-31T03:50:04.000Z", content: "boot" },
      { type: "totally-unknown", timestamp: "2026-07-31T03:50:05.000Z" },
      {
        type: "user",
        timestamp: "2026-07-31T03:50:06.000Z",
        message: { role: "user", content: "kept" },
      },
    );
    const out = adapter.parse(raw);
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("kept");
  });

  it("malformed/truncated JSON line is skipped, not thrown", () => {
    const raw = [
      '{"type":"user","timestamp":"2026-07-31T03:51:00.000Z","message":{"role":"user","content":"a"}}',
      '{"type":"user","timestamp":"2026-07-31T03:51:01.00',
      "",
      '{"type":"user","timestamp":"2026-07-31T03:51:02.000Z","message":{"role":"user","content":"b"}}',
    ].join("\n");
    expect(adapter.parse(raw).map((m) => m.text)).toEqual(["a", "b"]);
  });

  it("record with missing/invalid timestamp is skipped", () => {
    const raw = jsonl(
      { type: "user", message: { role: "user", content: "no ts" } },
      { type: "user", timestamp: 12345, message: { role: "user", content: "num ts" } },
    );
    expect(adapter.parse(raw)).toEqual([]);
  });

  it("sender falls back to top-level type when message.role absent", () => {
    const raw = jsonl({
      type: "assistant",
      timestamp: "2026-07-31T03:52:00.000Z",
      message: { content: "no role field" },
    });
    expect(adapter.parse(raw)[0].sender).toBe("assistant");
  });
});
