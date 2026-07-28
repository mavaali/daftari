import { describe, expect, it } from "vitest";
import { clip, SUMMARY_DETAIL_CHARS, SUMMARY_MAX_ROWS } from "../../src/tools/summary.js";

describe("clip", () => {
  it("returns short text unchanged", () => {
    expect(clip("hello", 10)).toBe("hello");
  });

  it("collapses internal whitespace, including newlines, to single spaces", () => {
    expect(clip("hello\n\n  world\tagain", 100)).toBe("hello world again");
  });

  it("trims leading/trailing whitespace", () => {
    expect(clip("  hello  ", 100)).toBe("hello");
  });

  it("truncates with an ellipsis when text exceeds max", () => {
    const out = clip("abcdefghij", 5);
    expect(out).toBe("abcd…");
    expect(out.length).toBe(5);
  });

  it("is idempotent on already-short, already-flat text", () => {
    const once = clip("short text", 110);
    expect(clip(once, 110)).toBe(once);
  });

  it("handles empty input", () => {
    expect(clip("", 10)).toBe("");
  });
});

describe("shared summary constants", () => {
  it("are exported with the values every summarizer assumes", () => {
    expect(SUMMARY_DETAIL_CHARS).toBe(110);
    expect(SUMMARY_MAX_ROWS).toBe(20);
  });
});
