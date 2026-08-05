import { describe, expect, it } from "vitest";
import { BUILTIN_FRONTMATTER_FIELDS, CRITICALITIES } from "../../src/frontmatter/types.js";

describe("criticality builtin field", () => {
  it("declares the three levels", () => {
    expect(CRITICALITIES).toEqual(["low", "medium", "high"]);
  });
  it("is a registered builtin field name", () => {
    expect(BUILTIN_FRONTMATTER_FIELDS).toContain("criticality");
  });
});
