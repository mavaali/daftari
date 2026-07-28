import { describe, expect, it } from "vitest";
import { looksLikeMalformedPin, PIN_RE, splitPin } from "../../src/anchors/pin.js";

describe("splitPin", () => {
  it("passes a bare binding through byte-identical", () => {
    expect(splitPin("api:src/retry.ts")).toEqual({ binding: "api:src/retry.ts", pin: null });
  });

  it("passes a ::symbol binding through byte-identical", () => {
    expect(splitPin("api:src/retry.ts::withRetry")).toEqual({
      binding: "api:src/retry.ts::withRetry",
      pin: null,
    });
  });

  it("parses a whole-file pin", () => {
    expect(splitPin("api:src/retry.ts@9f3c2ab")).toEqual({
      binding: "api:src/retry.ts",
      pin: { start: null, end: null, sha: "9f3c2ab" },
    });
  });

  it("parses a range pin", () => {
    expect(splitPin("api:src/retry.ts#L40-58@9f3c2ab")).toEqual({
      binding: "api:src/retry.ts",
      pin: { start: 40, end: 58, sha: "9f3c2ab" },
    });
  });

  it("parses a symbol + range pin", () => {
    expect(splitPin("api:src/retry.ts::withRetry#L40-58@9f3c2ab")).toEqual({
      binding: "api:src/retry.ts::withRetry",
      pin: { start: 40, end: 58, sha: "9f3c2ab" },
    });
  });

  it("a bare #L40 means the single line 40", () => {
    expect(splitPin("api:src/retry.ts#L40@9f3c2ab")).toEqual({
      binding: "api:src/retry.ts",
      pin: { start: 40, end: 40, sha: "9f3c2ab" },
    });
  });

  it("accepts a full 40-char sha", () => {
    const sha = "a".repeat(40);
    const result = splitPin(`api:src/retry.ts@${sha}`);
    expect(result.pin).toEqual({ start: null, end: null, sha });
  });

  it("rejects a sha shorter than 7 chars — degrades to bare binding", () => {
    expect(splitPin("api:src/retry.ts@abc12")).toEqual({
      binding: "api:src/retry.ts@abc12",
      pin: null,
    });
  });

  it("is end-anchored: an @ mid-path is unaffected", () => {
    expect(splitPin("api:src/@scope/pkg.ts")).toEqual({
      binding: "api:src/@scope/pkg.ts",
      pin: null,
    });
  });

  it("bundle@<hex>.js is NOT reinterpreted as a pin (trailing .js defeats the end anchor)", () => {
    expect(splitPin("api:dist/bundle@9f3c2ab1.js")).toEqual({
      binding: "api:dist/bundle@9f3c2ab1.js",
      pin: null,
    });
  });

  it("a path that itself ends in pin-shaped text: the pin wins (accepted ambiguity)", () => {
    // Pathological but explicitly accepted by the spec: a literal path
    // component that happens to look like a pin suffix parses as a pin.
    const result = splitPin("api:weird/file#L1-2@abcdef0");
    expect(result.pin).toEqual({ start: 1, end: 2, sha: "abcdef0" });
    expect(result.binding).toBe("api:weird/file");
  });

  it("an inverted range degrades the WHOLE entry to a bare binding", () => {
    expect(splitPin("api:src/retry.ts#L58-40@9f3c2ab")).toEqual({
      binding: "api:src/retry.ts#L58-40@9f3c2ab",
      pin: null,
    });
  });

  it("trims surrounding whitespace", () => {
    expect(splitPin("  api:src/retry.ts@9f3c2ab  ")).toEqual({
      binding: "api:src/retry.ts",
      pin: { start: null, end: null, sha: "9f3c2ab" },
    });
  });
});

describe("PIN_RE", () => {
  it("matches the grammar's own examples", () => {
    expect(PIN_RE.test("api:src/retry.ts@9f3c2ab")).toBe(true);
    expect(PIN_RE.test("api:src/retry.ts#L40-58@9f3c2ab")).toBe(true);
    expect(PIN_RE.test("api:src/retry.ts::withRetry#L40-58@9f3c2ab")).toBe(true);
    expect(PIN_RE.test("api:src/retry.ts")).toBe(false);
  });
});

describe("looksLikeMalformedPin", () => {
  it("flags a range marker with a non-hex/uppercase sha near-miss", () => {
    expect(looksLikeMalformedPin("api:src/retry.ts#L40-58@ZZZZZZZ")).toBe(true);
    expect(looksLikeMalformedPin("api:src/retry.ts#L40@notahash")).toBe(true);
  });

  it("flags a trailing @<hex> that is too short or uppercase", () => {
    expect(looksLikeMalformedPin("api:src/retry.ts@abcd")).toBe(true); // 4 chars, below 7
    expect(looksLikeMalformedPin("api:src/retry.ts@ABCDEF1")).toBe(true); // uppercase
  });

  it("flags a structural match with an inverted range", () => {
    expect(looksLikeMalformedPin("api:src/retry.ts#L58-40@9f3c2ab")).toBe(true);
  });

  it("does NOT flag ::@property (non-hex letters defeat the near-miss)", () => {
    expect(looksLikeMalformedPin("component.css::@property")).toBe(false);
  });

  it("does NOT flag ::render@v2 ('v' is not hex)", () => {
    expect(looksLikeMalformedPin("api:src/view.ts::render@v2")).toBe(false);
  });

  it("does NOT flag bundle@<hex>.js (trailing .js defeats the end anchor)", () => {
    expect(looksLikeMalformedPin("api:dist/bundle@9f3c2ab1.js")).toBe(false);
  });

  it("does NOT flag a well-formed pin", () => {
    expect(looksLikeMalformedPin("api:src/retry.ts#L40-58@9f3c2ab")).toBe(false);
    expect(looksLikeMalformedPin("api:src/retry.ts@9f3c2ab")).toBe(false);
    expect(looksLikeMalformedPin("api:src/retry.ts")).toBe(false);
  });
});
