import { describe, expect, it } from "vitest";
import {
  coerceDatePrefix,
  harvestInlineTags,
  webClipperSources,
} from "../../src/backfill/obsidian.js";

describe("harvestInlineTags", () => {
  it("finds simple and nested tags, order-preserved and deduped", () => {
    expect(harvestInlineTags("intro #alpha then #beta/gamma and #alpha again")).toEqual([
      "alpha",
      "beta/gamma",
    ]);
  });
  it("ignores ATX headings (# followed by space)", () => {
    expect(harvestInlineTags("# Heading\n## Sub\n#realtag")).toEqual(["realtag"]);
  });
  it("ignores tags inside fenced code blocks", () => {
    expect(harvestInlineTags("```\n#notatag\n```\n#yes")).toEqual(["yes"]);
  });
  it("ignores tags inside inline code", () => {
    expect(harvestInlineTags("use `#define` in C, but #macro is a tag")).toEqual(["macro"]);
  });
  it("does not match a # in the middle of a word or URL", () => {
    expect(harvestInlineTags("see http://x.com/page#frag and foo#bar")).toEqual([]);
  });
  it("requires at least one letter (so #1234 is not a tag)", () => {
    expect(harvestInlineTags("#1234 #2026 #v2")).toEqual(["v2"]);
  });
  it("returns [] for a body with no tags", () => {
    expect(harvestInlineTags("plain text, no tags")).toEqual([]);
  });
});

describe("coerceDatePrefix", () => {
  it("coerces an ISO datetime with timezone to the date prefix", () => {
    expect(coerceDatePrefix("2026-03-05T04:13:05+00:00")).toBe("2026-03-05");
  });
  it("coerces a space-separated datetime to the date prefix", () => {
    expect(coerceDatePrefix("2026-03-05 04:13:05")).toBe("2026-03-05");
  });
  it("leaves a bare YYYY-MM-DD date unchanged", () => {
    expect(coerceDatePrefix("2026-03-05")).toBe("2026-03-05");
  });
  it("leaves a non-date string unchanged", () => {
    expect(coerceDatePrefix("sometime last year")).toBe("sometime last year");
  });
  it("returns non-string input unchanged", () => {
    expect(coerceDatePrefix(42)).toBe(42);
    expect(coerceDatePrefix(null)).toBe(null);
  });
});

describe("webClipperSources", () => {
  it("returns [url] when raw.source is a URL string and sources is absent", () => {
    expect(webClipperSources({ source: "https://example.com/post" })).toEqual([
      "https://example.com/post",
    ]);
  });
  it("returns undefined when sources is already present and non-empty", () => {
    expect(webClipperSources({ source: "https://x.com", sources: ["already"] })).toBeUndefined();
  });
  it("returns undefined when there is no source", () => {
    expect(webClipperSources({})).toBeUndefined();
    expect(webClipperSources({ source: "" })).toBeUndefined();
    expect(webClipperSources({ source: 42 })).toBeUndefined();
  });
});
