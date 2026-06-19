import { describe, expect, it } from "vitest";
import { harvestInlineTags, webClipperSources } from "../../src/backfill/obsidian.js";

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
