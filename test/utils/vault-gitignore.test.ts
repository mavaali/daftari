import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureVaultGitignore, VAULT_GITIGNORE } from "../../src/utils/vault-gitignore.js";

describe("ensureVaultGitignore", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-gitignore-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates .gitignore when none exists", async () => {
    const path = join(dir, ".gitignore");
    expect(existsSync(path)).toBe(false);

    const result = await ensureVaultGitignore(dir);

    expect(result).toBe("created");
    expect(readFileSync(path, "utf-8")).toContain(".daftari/index.db");
  });

  it("appends the block to an existing .gitignore that lacks it", async () => {
    const path = join(dir, ".gitignore");
    writeFileSync(path, ".obsidian/workspace.json\n");

    const result = await ensureVaultGitignore(dir);

    expect(result).toBe("appended");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain(".obsidian/workspace.json");
    expect(content).toContain(".daftari/index.db");
  });

  it("leaves an existing .gitignore untouched when the block is already present", async () => {
    const path = join(dir, ".gitignore");
    writeFileSync(path, VAULT_GITIGNORE);
    const before = readFileSync(path, "utf-8");

    const result = await ensureVaultGitignore(dir);

    expect(result).toBe("present");
    const after = readFileSync(path, "utf-8");
    expect(after).toBe(before);
    expect(after.length).toBe(before.length);
  });

  // C7 (2026-07-26 independence-aware-promotion spec): a vault whose
  // .gitignore carries the marker but predates a later pattern-line addition
  // to VAULT_GITIGNORE (e.g. the independence shadow journal, added after
  // some vaults were already scaffolded) must pick up exactly what's missing.
  it("per-line reconciliation: an old block gains exactly the new .daftari/ lines", async () => {
    const path = join(dir, ".gitignore");
    const oldBlock = VAULT_GITIGNORE.split("\n")
      .filter(
        (l) => l !== ".daftari/independence-shadow.jsonl" && l !== ".daftari/revision-trace.jsonl",
      )
      .join("\n");
    // Sanity: the marker survives the filter, so the block is still detected.
    expect(oldBlock).toContain(".daftari/index.db");
    writeFileSync(path, oldBlock);

    const result = await ensureVaultGitignore(dir);

    expect(result).toBe("appended");
    const after = readFileSync(path, "utf-8");
    expect(after).toContain(".daftari/independence-shadow.jsonl");
    expect(after).toContain(".daftari/revision-trace.jsonl");
    // Idempotent: a second call against the now-current file is a no-op.
    const second = await ensureVaultGitignore(dir);
    expect(second).toBe("present");
    expect(readFileSync(path, "utf-8")).toBe(after);
  });

  it("a fully current .gitignore (all pattern lines present) is untouched", async () => {
    const path = join(dir, ".gitignore");
    writeFileSync(path, VAULT_GITIGNORE);
    const before = readFileSync(path, "utf-8");

    const result = await ensureVaultGitignore(dir);

    expect(result).toBe("present");
    expect(readFileSync(path, "utf-8")).toBe(before);
  });
});
