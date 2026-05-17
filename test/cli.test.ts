import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initVault } from "../src/cli.js";
import { cleanupVault, makeTempVault } from "./helpers/temp-vault.js";

describe("daftari --init", () => {
  let parent: string;
  let vault: string;

  beforeEach(() => {
    parent = mkdtempSync(join(tmpdir(), "daftari-cli-"));
    vault = join(parent, "vault");
  });

  afterEach(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  it("scaffolds the directory structure, config, and example docs", async () => {
    const code = await initVault(vault);
    expect(code).toBe(0);

    expect(existsSync(join(vault, ".daftari", "config.yaml"))).toBe(true);
    expect(existsSync(join(vault, ".gitignore"))).toBe(true);
    for (const collection of ["competitive-intel", "pricing", "moonshot", "_drafts"]) {
      expect(existsSync(join(vault, collection))).toBe(true);
    }

    expect(existsSync(join(vault, "competitive-intel", "aurora-pipelines-overview.md"))).toBe(true);
    expect(existsSync(join(vault, "pricing", "helios-consumption-pricing.md"))).toBe(true);
    expect(existsSync(join(vault, "moonshot", "zero-config-ingestion.md"))).toBe(true);

    // The scaffold is committed: the vault has git history from the start.
    expect(existsSync(join(vault, ".git"))).toBe(true);

    // The initial index build ran.
    expect(existsSync(join(vault, ".daftari", "index.db"))).toBe(true);
  }, 60_000);

  it("scaffolds only fictional, generic example content", async () => {
    await initVault(vault);
    const overview = readFileSync(
      join(vault, "competitive-intel", "aurora-pipelines-overview.md"),
      "utf-8",
    );
    expect(overview).toContain("Aurora Pipelines");
    expect(overview.toLowerCase()).not.toMatch(/microsoft|fabric|databricks|snowflake|bigquery/);
  }, 60_000);

  it("refuses to scaffold into a non-empty directory", async () => {
    const first = await initVault(vault);
    expect(first).toBe(0);
    const second = await initVault(vault);
    expect(second).toBe(1);
  }, 60_000);
});

describe("daftari --vault", () => {
  // Boots the CLI as a subprocess and waits for the server to report it is
  // serving over stdio. A clean boot proves --vault wiring (config load, index
  // build, server connect) works end to end.
  function bootServer(vault: string): Promise<{ ok: boolean; stderr: string }> {
    return new Promise((resolveBoot) => {
      const tsx = resolve("node_modules/.bin/tsx");
      const proc = spawn(tsx, [
        "src/cli.ts",
        "--vault",
        vault,
        "--user",
        "tester",
        "--role",
        "admin",
      ]);
      let stderr = "";
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        proc.kill();
        resolveBoot({ ok, stderr });
      };
      const timer = setTimeout(() => finish(false), 50_000);
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.includes("serving vault at")) finish(true);
      });
      proc.on("exit", () => {
        clearTimeout(timer);
        resolveBoot({ ok: stderr.includes("serving vault at"), stderr });
      });
    });
  }

  it("boots the MCP server without crashing", async () => {
    const vault = makeTempVault();
    try {
      const result = await bootServer(vault);
      expect(result.ok).toBe(true);
      expect(result.stderr).toContain("role=admin");
    } finally {
      cleanupVault(vault);
    }
  }, 60_000);
});
