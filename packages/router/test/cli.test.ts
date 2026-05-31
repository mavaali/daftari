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

  it("registers SIGINT and SIGTERM handlers before attempting config load", async () => {
    // Spy on process.once to capture which signal names are registered.
    // main() registers them before readFileSync, so they appear even when
    // the config path is invalid and main() returns code 1 immediately after.
    const onceCalls: string[] = [];
    const originalOnce = process.once.bind(process);
    // Patch: record calls, then also forward to originalOnce so handlers are
    // actually registered (avoids leaking unregistered state).
    process.once = ((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        onceCalls.push(event as string);
      }
      return originalOnce(event as NodeJS.Signals, handler as () => void);
    }) as typeof process.once;

    try {
      const stderrLines: string[] = [];
      const origWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((s: string) => {
        stderrLines.push(s);
        return true;
      }) as never;
      try {
        const code = await main(["--config", "/nonexistent/test/vaults.yaml"]);
        // main() still returns 1 because config load fails
        expect(code).toBe(1);
      } finally {
        process.stderr.write = origWrite;
      }
      // Both signal handlers must have been registered before config load bailed.
      expect(onceCalls).toContain("SIGINT");
      expect(onceCalls).toContain("SIGTERM");
    } finally {
      process.once = originalOnce;
    }
  });
});
