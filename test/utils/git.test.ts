import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  catFileBlob,
  commit,
  ensureGitRepo,
  fileGitMeta,
  gitIdentity,
  hashObjectFile,
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

  // --- serve-concurrency commit serialization -------------------------------
  // Two serve requests writing DIFFERENT files hold different leases, so
  // their add/commit sequences interleaved freely: A's pathless `git commit`
  // swallowed B's staged file under A's author and message, then B's commit
  // failed "nothing to commit" (or died on .git/index.lock). commit() must
  // serialize in-process and commit only its own paths.

  // The file list of one commit, straight from git.
  function commitFiles(hash: string): string[] {
    return execFileSync("git", ["-C", vault, "show", "--name-only", "--format=", hash], {
      encoding: "utf-8",
    })
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
  }

  it("concurrent commits of different files each land as their own commit", async () => {
    await writeFile(join(vault, "a.md"), "a\n", "utf-8");
    await writeFile(join(vault, "b.md"), "b\n", "utf-8");

    const [a, b] = await Promise.all([
      commit(vault, ["a.md"], "commit a", "agent:a"),
      commit(vault, ["b.md"], "commit b", "agent:b"),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    const history = await log(vault);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value).toHaveLength(2);

    // Each commit contains exactly its own file — no swallowing.
    expect(commitFiles(a.value.hash)).toEqual(["a.md"]);
    expect(commitFiles(b.value.hash)).toEqual(["b.md"]);
    // And each is attributed to its own author.
    const bySubject = new Map(history.value.map((c) => [c.subject, c.author]));
    expect(bySubject.get("commit a")).toBe("agent:a");
    expect(bySubject.get("commit b")).toBe("agent:b");
  }, 60_000);

  it("a commit never sweeps up a file some other flow left staged", async () => {
    await ensureGitRepo(vault);
    await writeFile(join(vault, "mine.md"), "mine\n", "utf-8");
    await writeFile(join(vault, "theirs.md"), "theirs\n", "utf-8");
    // Another flow staged its file but has not committed yet.
    execFileSync("git", ["-C", vault, "add", "--", "theirs.md"]);

    const result = await commit(vault, ["mine.md"], "commit mine", "agent:mine");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Only mine.md is in the commit; theirs.md is still staged, uncommitted.
    expect(commitFiles(result.value.hash)).toEqual(["mine.md"]);
    const staged = execFileSync("git", ["-C", vault, "diff", "--cached", "--name-only"], {
      encoding: "utf-8",
    }).trim();
    expect(staged).toBe("theirs.md");
  }, 60_000);

  // --- blob plumbing for JIT anchor pins (U3) -------------------------------

  it("hashObjectFile returns a stable blob id and catFileBlob round-trips it", async () => {
    await writeFile(join(vault, "code.ts"), "line1\nline2\nline3\n", "utf-8");
    await commit(vault, ["code.ts"], "add code", "agent:tester");

    const sha = await hashObjectFile(vault, "code.ts");
    expect(sha.ok).toBe(true);
    if (!sha.ok) return;
    expect(sha.value).toMatch(/^[0-9a-f]{40}$/);

    const blob = await catFileBlob(vault, sha.value);
    expect(blob.ok).toBe(true);
    if (!blob.ok) return;
    expect(blob.value).toBe("line1\nline2\nline3\n");
  });

  it("hashObjectFile of a dirty (uncommitted) file returns the working-tree blob, not HEAD's", async () => {
    await writeFile(join(vault, "code.ts"), "original\n", "utf-8");
    await commit(vault, ["code.ts"], "add code", "agent:tester");
    const committed = await hashObjectFile(vault, "code.ts");

    await writeFile(join(vault, "code.ts"), "modified\n", "utf-8"); // dirty, not committed
    const dirty = await hashObjectFile(vault, "code.ts");

    expect(committed.ok && dirty.ok).toBe(true);
    if (!committed.ok || !dirty.ok) return;
    expect(dirty.value).not.toBe(committed.value); // hashes the current working tree
  });

  it("hashObjectFile of an absent path fails (feeds `missing`)", async () => {
    const result = await hashObjectFile(vault, "does-not-exist.ts");
    expect(result.ok).toBe(false);
  });

  it("catFileBlob of a sha not in the odb fails (feeds `moved`)", async () => {
    await ensureGitRepo(vault);
    const result = await catFileBlob(vault, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
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
