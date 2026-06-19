import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock runBackfill to capture delegation without touching the filesystem.
vi.mock("../../src/backfill/index.js", () => ({
  runBackfill: vi.fn(async () => 0),
}));

import { runBackfill } from "../../src/backfill/index.js";
import { runImport } from "../../src/import/index.js";

describe("runImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an unsupported import type", async () => {
    const code = await runImport(["notion", "./v", "--plan"]);
    expect(code).toBe(1);
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it("delegates obsidian import to runBackfill with the obsidian flag and --vault", async () => {
    // Use a real existing dir for the vault so the directoryExists check passes.
    await runImport(["obsidian", process.cwd(), "--plan", "--scope", "notes"]);
    expect(runBackfill).toHaveBeenCalledWith(
      expect.arrayContaining(["--vault", process.cwd(), "--plan", "--scope", "notes"]),
      { obsidian: true },
    );
  });

  it("defaults the vault to '.' when no positional path is given", async () => {
    // Note: '.' resolves against the test process cwd, which exists, so the
    // directoryExists check passes — this case is implicitly cwd-dependent.
    await runImport(["obsidian", "--plan"]);
    expect(runBackfill).toHaveBeenCalledWith(expect.arrayContaining(["--vault", "."]), {
      obsidian: true,
    });
  });

  it("errors (exit 1) and does not delegate when the vault dir does not exist", async () => {
    const code = await runImport(["obsidian", "/no/such/vault/path", "--plan"]);
    expect(code).toBe(1);
    expect(runBackfill).not.toHaveBeenCalled();
  });

  it("prints help and returns 0 on --help", async () => {
    const code = await runImport(["--help"]);
    expect(code).toBe(0);
  });

  it("returns 1 with no args", async () => {
    expect(await runImport([])).toBe(1);
  });
});
