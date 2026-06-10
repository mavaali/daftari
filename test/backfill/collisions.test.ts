import { describe, expect, it } from "vitest";
import { detectCollisions } from "../../src/backfill/collisions.js";

describe("detectCollisions", () => {
  it("flags each enum built-in whose value is out of enum", () => {
    const collisions = detectCollisions({
      status: "ACTIVE",
      confidence: "EXPLICIT",
      domain: "Architecture",
    });
    expect(collisions.map((c) => c.field).sort()).toEqual(["confidence", "domain", "status"]);
    const status = collisions.find((c) => c.field === "status");
    expect(status?.value).toBe("ACTIVE");
    expect(status?.expected).toContain("canonical");
  });

  it("ignores valid enum values and absent/empty fields", () => {
    expect(
      detectCollisions({ status: "draft", confidence: "high", domain: "accumulation" }),
    ).toEqual([]);
    expect(detectCollisions({})).toEqual([]);
    expect(detectCollisions({ status: "", domain: null })).toEqual([]);
  });

  it("flags a non-string value on an enum field as a collision", () => {
    const collisions = detectCollisions({ status: 3 });
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.value).toBe("3");
  });

  it("does not treat non-enum built-ins as collisions", () => {
    expect(detectCollisions({ title: 123, created: "not-a-date", tags: "foo" })).toEqual([]);
  });
});
