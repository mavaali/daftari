import { describe, expect, it } from "vitest";
import { main } from "../src/index.js";

describe("cli", () => {
  it("returns exit code 2 when --config is missing", async () => {
    expect(await main([])).toBe(2);
  });

  it("returns exit code 1 with stderr when --config points at a nonexistent file", async () => {
    const stderrLines: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      stderrLines.push(s);
      return true;
    }) as never;
    try {
      const code = await main(["--config", "/nonexistent/path/vaults.yaml"]);
      expect(code).toBe(1);
      expect(stderrLines.join("")).toMatch(/failed to load config/);
    } finally {
      process.stderr.write = orig;
    }
  });
});
