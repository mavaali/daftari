import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("upgrades an older Daftari block with local integration state rules", async () => {
    const path = join(dir, ".gitignore");
    writeFileSync(path, "# old Daftari block\n.daftari/index.db\n.daftari/distill-state.json\n");

    const result = await ensureVaultGitignore(dir);

    expect(result).toBe("appended");
    const content = readFileSync(path, "utf-8");
    expect(content).toContain(".daftari/integrations.state.enc.*.tmp");
    expect(content).toContain(".daftari/integration-queue.json.tmp-*");
    expect(content).toContain(".daftari/integration-review.jsonl");
  });

  it("makes every integration state file and temporary variant ignored by git", async () => {
    await ensureVaultGitignore(dir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    const paths = [
      ".daftari/integrations.state.enc",
      ".daftari/integrations.state.enc.42.abcdef.tmp",
      ".daftari/integration-queue.json",
      ".daftari/integration-queue.json.tmp-42-abcdef",
      ".daftari/integration-review.jsonl",
    ];
    for (const relativePath of paths) writeFileSync(join(dir, relativePath), "local state\n");

    const ignored = execFileSync("git", ["check-ignore", "--stdin"], {
      cwd: dir,
      input: `${paths.join("\n")}\n`,
      encoding: "utf-8",
    })
      .trim()
      .split("\n");
    expect(ignored).toEqual(paths);
  });
});
