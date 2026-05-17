import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commit,
  ensureGitRepo,
  gitIdentity,
  isGitRepo,
  log,
} from "../../src/utils/git.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

describe("git", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("synthesizes a valid git identity from an agent id", () => {
    const id = gitIdentity("agent:claude-code");
    expect(id.name).toBe("agent:claude-code");
    expect(id.email).toBe("agent-claude-code@daftari.local");
  });

  it("reports a fresh directory as not a repo, then inits it", async () => {
    expect(await isGitRepo(vault)).toBe(false);
    const init = await ensureGitRepo(vault);
    expect(init.ok).toBe(true);
    expect(await isGitRepo(vault)).toBe(true);
  });

  it("commits a file and records the author identity", async () => {
    await writeFile(join(vault, "note.md"), "hello\n", "utf-8");
    const result = await commit(vault, ["note.md"], "add note", "agent:tester");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hash).toMatch(/^[0-9a-f]+$/);

    const history = await log(vault);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value[0]?.subject).toBe("add note");
    expect(history.value[0]?.author).toBe("agent:tester");
    expect(history.value[0]?.email).toBe("agent-tester@daftari.local");
  });

  it("scopes the log to a single file's history", async () => {
    await writeFile(join(vault, "a.md"), "a\n", "utf-8");
    await commit(vault, ["a.md"], "commit a", "agent:tester");
    await writeFile(join(vault, "b.md"), "b\n", "utf-8");
    await commit(vault, ["b.md"], "commit b", "agent:tester");

    const aHistory = await log(vault, { path: "a.md" });
    expect(aHistory.ok).toBe(true);
    if (!aHistory.ok) return;
    expect(aHistory.value).toHaveLength(1);
    expect(aHistory.value[0]?.subject).toBe("commit a");
  });

  it("fails a commit with no paths", async () => {
    const result = await commit(vault, [], "empty", "agent:tester");
    expect(result.ok).toBe(false);
  });
});
