import { describe, expect, it } from "vitest";
import { main } from "../src/index.js";

describe("cli", () => {
  it("returns exit code 2 when --config is missing", async () => {
    expect(await main([])).toBe(2);
  });
  it("accepts --config <path>", async () => {
    expect(await main(["--config", "x.yaml"])).toBe(0);
  });
});
