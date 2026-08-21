import { describe, expect, it } from "vitest";
import { requireDefined } from "./require-defined.js";

describe("requireDefined", () => {
  it("returns defined values, including falsy ones", () => {
    expect(requireDefined(0)).toBe(0);
    expect(requireDefined("")).toBe("");
    expect(requireDefined(false)).toBe(false);
  });

  it.each([null, undefined])("rejects missing values (%s)", (value) => {
    expect(() => requireDefined(value, "fixture missing")).toThrow("fixture missing");
  });
});
