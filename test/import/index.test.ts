import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock runBackfill to capture delegation without touching the filesystem.
vi.mock("../../src/backfill/index.js", () => ({
  runBackfill: vi.fn(async () => 0),
}));

import { runBackfill } from "../../src/backfill/index.js";
import { runImport } from "../../src/import/index.js";

describe("runImport", () => {
  const tmpDirs: string[] = [];

  function makeNonGitVault(): string {
    const dir = mkdtempSync(join(tmpdir(), "daftari-import-"));
    tmpDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("does not write a .gitignore on a --plan dry-run against a non-git vault", async () => {
    const tmpDir = makeNonGitVault();
    const code = await runImport(["obsidian", tmpDir, "--plan"]);

    expect(code).toBe(0);
    // plan is a dry-run — nothing should be written to the vault.
    expect(existsSync(join(tmpDir, ".gitignore"))).toBe(false);
    // delegation still happens.
    expect(runBackfill).toHaveBeenCalledWith(
      expect.arrayContaining(["--vault", tmpDir, "--plan"]),
      { obsidian: true },
    );
  });

  it("scaffolds a .daftari .gitignore on --apply against a non-git vault", async () => {
    const tmpDir = makeNonGitVault();
    const code = await runImport(["obsidian", tmpDir, "--apply", "--scope", "x"]);

    expect(code).toBe(0);
    const gitignore = join(tmpDir, ".gitignore");
    expect(existsSync(gitignore)).toBe(true);
    expect(readFileSync(gitignore, "utf-8")).toContain(".daftari/index.db");
    expect(runBackfill).toHaveBeenCalledWith(
      expect.arrayContaining(["--vault", tmpDir, "--apply", "--scope", "x"]),
      { obsidian: true },
    );
  });

  it("--external-git-dir writes git_dir: external + auto_commit: true on apply", async () => {
    const v = makeNonGitVault();
    await runImport(["obsidian", v, "--apply", "--scope", "x", "--external-git-dir"]);
    const cfg = load(readFileSync(join(v, ".daftari", "config.yaml"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(cfg.git_dir).toBe("external");
    expect(cfg.auto_commit).toBe(true);
    const lastCall = (runBackfill as any).mock.calls.at(-1);
    expect(lastCall[0]).not.toContain("--external-git-dir"); // stripped before delegation
  });

  it("--external-git-dir=/p writes the explicit path", async () => {
    const v = makeNonGitVault();
    await runImport(["obsidian", v, "--apply", "--scope", "x", "--external-git-dir=/tmp/ext-git"]);
    const cfg = load(readFileSync(join(v, ".daftari", "config.yaml"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(cfg.git_dir).toBe("/tmp/ext-git");
  });

  it("merges into an existing config without dropping other keys", async () => {
    const v = makeNonGitVault();
    mkdirSync(join(v, ".daftari"), { recursive: true });
    writeFileSync(
      join(v, ".daftari", "config.yaml"),
      "auto_commit: false\nwarm_embeddings: false\n",
    );
    await runImport(["obsidian", v, "--apply", "--scope", "x", "--external-git-dir"]);
    const cfg = load(readFileSync(join(v, ".daftari", "config.yaml"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(cfg.git_dir).toBe("external");
    expect(cfg.auto_commit).toBe(true); // overridden
    expect(cfg.warm_embeddings).toBe(false); // preserved
  });

  it("does NOT write config on --plan (dry-run)", async () => {
    const v = makeNonGitVault();
    await runImport(["obsidian", v, "--plan", "--external-git-dir"]);
    expect(existsSync(join(v, ".daftari", "config.yaml"))).toBe(false);
  });

  describe("post-apply tension-scan hint", () => {
    it("prints the scan hint after a successful --apply (never auto-runs)", async () => {
      const v = makeNonGitVault();
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const code = await runImport(["obsidian", v, "--apply", "--scope", "x"]);
        expect(code).toBe(0);
        const out = stderr.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toContain("daftari sleep --dream tension-scan");
        expect(out).toContain(v);
      } finally {
        stderr.mockRestore();
      }
    });

    it("does not print the hint on --plan", async () => {
      const v = makeNonGitVault();
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await runImport(["obsidian", v, "--plan"]);
        const out = stderr.mock.calls.map((c) => String(c[0])).join("");
        expect(out).not.toContain("tension-scan");
      } finally {
        stderr.mockRestore();
      }
    });

    it("does not print the hint when the apply fails", async () => {
      const v = makeNonGitVault();
      vi.mocked(runBackfill).mockResolvedValueOnce(2);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const code = await runImport(["obsidian", v, "--apply", "--scope", "x"]);
        expect(code).toBe(2);
        const out = stderr.mock.calls.map((c) => String(c[0])).join("");
        expect(out).not.toContain("tension-scan");
      } finally {
        stderr.mockRestore();
      }
    });
  });
});
