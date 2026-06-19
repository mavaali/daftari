import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
      // Resolve only from the exit handler so cleanupVault never races the
      // child's background work (the lazy-model warm in #38 PR 2/5 actively
      // touches the vault directory after "serving vault at" is printed,
      // which previously raced rmSync to ENOTEMPTY).
      const finish = () => {
        clearTimeout(timer);
        proc.kill();
      };
      const timer = setTimeout(finish, 50_000);
      proc.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.includes("serving vault at")) finish();
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

describe("daftari audit subcommand", () => {
  it("prints audit help on `daftari audit --help`", async () => {
    const { vi } = await import("vitest");
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const { run } = await import("../src/cli.js");
    await run(["audit", "--help"]);
    expect(out).toHaveBeenCalledWith(expect.stringContaining("daftari audit"));
    out.mockRestore();
  });

  it("prints audit help on bare `daftari audit` with no args", async () => {
    const { vi } = await import("vitest");
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const { run } = await import("../src/cli.js");
    await run(["audit"]);
    expect(out).toHaveBeenCalledWith(expect.stringContaining("daftari audit"));
    out.mockRestore();
  });
});

describe("daftari import subcommand", () => {
  it("prints import help on `daftari import --help`", async () => {
    const { vi } = await import("vitest");
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const { run } = await import("../src/cli.js");
    await run(["import", "--help"]);
    expect(out).toHaveBeenCalledWith(expect.stringContaining("daftari import"));
    out.mockRestore();
  });

  it("exits 1 on unsupported import type", async () => {
    const { vi } = await import("vitest");
    const errSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const { run } = await import("../src/cli.js");
    process.exitCode = undefined;
    await run(["import", "notion", "./x"]);
    expect(process.exitCode).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("unsupported type 'notion'"));
    errSpy.mockRestore();
    process.exitCode = undefined;
  });
});

describe("daftari invoked through a symlink (npm/npx bin shim)", () => {
  // npm/npx bin shims and `npm i -g` invoke the CLI through a symlinked
  // launcher, so process.argv[1] is the symlink path, not cli.ts's real path.
  // The entry-point guard must resolve symlinks before comparing — without
  // that, the installed `daftari` command silently no-ops. This reproduces
  // that invocation path.
  it("runs --init when launched via a symlink", async () => {
    const parent = mkdtempSync(join(tmpdir(), "daftari-symlink-"));
    const linkPath = join(parent, "daftari-launcher.ts");
    const vault = join(parent, "vault");
    symlinkSync(resolve("src/cli.ts"), linkPath);
    try {
      const tsx = resolve("node_modules/.bin/tsx");
      const exitCode = await new Promise<number | null>((resolveRun) => {
        const proc = spawn(tsx, [linkPath, "--init", vault]);
        proc.on("exit", (code) => resolveRun(code));
        proc.on("error", () => resolveRun(-1));
      });
      expect(exitCode).toBe(0);
      expect(existsSync(join(vault, ".daftari", "config.yaml"))).toBe(true);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 60_000);
});
