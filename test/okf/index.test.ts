import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the translation modules so this suite exercises only dispatch, arg
// parsing, and existence/required-flag checks — no filesystem writes.
vi.mock("../../src/okf/export.js", () => ({
  exportBundle: vi.fn(async (_v: string, out: string) => ({
    ok: true,
    value: { outDir: out, documentCount: 0, skipped: 0, warnings: [] },
  })),
}));
vi.mock("../../src/okf/import.js", () => ({
  importBundle: vi.fn(async (_b: string, vaultRoot: string) => ({
    ok: true,
    value: {
      vaultRoot,
      imported: 0,
      skipped: 0,
      commit: null,
      reindexed: true,
      dryRun: false,
      warnings: [],
      plan: [],
    },
  })),
}));

import { exportBundle } from "../../src/okf/export.js";
import { importBundle } from "../../src/okf/import.js";
import { runOkf } from "../../src/okf/index.js";

describe("runOkf", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("prints help and returns 1 with no subcommand", async () => {
    expect(await runOkf([])).toBe(1);
    expect(exportBundle).not.toHaveBeenCalled();
  });

  it("returns 0 for --help", async () => {
    expect(await runOkf(["--help"])).toBe(0);
  });

  it("rejects an unknown subcommand", async () => {
    expect(await runOkf(["translate"])).toBe(1);
  });

  describe("export", () => {
    it("requires --out", async () => {
      expect(await runOkf(["export", process.cwd()])).toBe(1);
      expect(exportBundle).not.toHaveBeenCalled();
    });

    it("errors when the vault does not exist", async () => {
      expect(await runOkf(["export", "/no/such/vault", "--out", "/tmp/x"])).toBe(1);
      expect(exportBundle).not.toHaveBeenCalled();
    });

    it("resolves paths and forwards the collection filter", async () => {
      const code = await runOkf([
        "export",
        process.cwd(),
        "--out",
        "./bundle",
        "--collection",
        "pricing",
      ]);
      expect(code).toBe(0);
      expect(exportBundle).toHaveBeenCalledWith(process.cwd(), resolve("./bundle"), {
        collection: "pricing",
      });
    });
  });

  describe("import", () => {
    it("requires --into", async () => {
      expect(await runOkf(["import", process.cwd()])).toBe(1);
      expect(importBundle).not.toHaveBeenCalled();
    });

    it("errors when the bundle does not exist", async () => {
      expect(await runOkf(["import", "/no/such/bundle", "--into", process.cwd()])).toBe(1);
      expect(importBundle).not.toHaveBeenCalled();
    });

    it("forwards --agent and --dry-run", async () => {
      const code = await runOkf([
        "import",
        process.cwd(),
        "--into",
        process.cwd(),
        "--agent",
        "agent:test",
        "--dry-run",
      ]);
      expect(code).toBe(0);
      expect(importBundle).toHaveBeenCalledWith(process.cwd(), process.cwd(), {
        agent: "agent:test",
        dryRun: true,
      });
    });
  });
});
