import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  commit,
  ensureGitRepo,
  fileGitMeta,
  gitIdentity,
  isGitRepo,
  log,
} from "../../src/utils/git.js";
import {
  buildFrontmatterLessVault,
  cleanupVault as cleanupFmVault,
} from "../helpers/frontmatter-less-vault.js";
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

describe("git external git-dir", () => {
  let vault: string;
  let vault2: string;
  let vault3: string;
  let ext: string;
  let ext3: string;
  const dirs: string[] = [];

  function freshDir(): string {
    const d = mkdtempSync(join(tmpdir(), "git-"));
    dirs.push(d);
    return d;
  }

  beforeEach(() => {
    vault = freshDir();
    vault2 = freshDir();
    vault3 = freshDir();
    ext = join(freshDir(), "repo.git");
    ext3 = join(freshDir(), "repo.git");
  });

  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("ensureGitRepo with gitDir creates an external repo + a .git FILE (no .git/ dir)", async () => {
    const r = await ensureGitRepo(vault, ext);
    expect(r.ok).toBe(true);
    expect(statSync(join(vault, ".git")).isFile()).toBe(true);
    expect(existsSync(join(ext, "HEAD"))).toBe(true);
  });

  it("commit with gitDir lands in the external repo and is readable via log", async () => {
    writeFileSync(join(vault, "note.md"), "# note\n");
    const c = await commit(vault, ["note.md"], "msg", "human:tester", { gitDir: ext });
    expect(c.ok).toBe(true);
    const l = await log(vault, { limit: 1 });
    expect(l.ok && l.value[0]?.subject).toBe("msg");
  });

  it("ensureGitRepo without gitDir creates an in-vault .git/ dir (unchanged)", async () => {
    const r = await ensureGitRepo(vault2);
    expect(r.ok).toBe(true);
    expect(statSync(join(vault2, ".git")).isDirectory()).toBe(true);
  });

  it("re-inits when a dangling .git file points nowhere (second-device case)", async () => {
    writeFileSync(join(vault3, ".git"), "gitdir: /no/such/place\n");
    const r = await ensureGitRepo(vault3, ext3);
    expect(r.ok).toBe(true);
    expect(existsSync(join(ext3, "HEAD"))).toBe(true);
  });
});

describe("fileGitMeta", () => {
  it("reads add-date, last-date, and last author from history", async () => {
    const fmVault = buildFrontmatterLessVault();
    try {
      const meta = await fileGitMeta(fmVault, "specs/data-movement/foo.md");
      expect(meta.created).toBe("2025-04-12"); // first add commit
      expect(meta.updated).toBe("2025-05-01"); // most recent commit
      expect(meta.author).toBe("Mihir Wagle");
    } finally {
      cleanupFmVault(fmVault);
    }
  });

  it("returns nulls outside a git repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "daftari-nogit-"));
    try {
      const meta = await fileGitMeta(dir, "anything.md");
      expect(meta).toEqual({ created: null, updated: null, author: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
