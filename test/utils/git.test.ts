import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  lastCommitContainingPath,
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

  it("treats paths as literal names, never glob pathspecs", async () => {
    await ensureGitRepo(vault);
    // A doc whose NAME contains glob metacharacters, plus a sibling the
    // glob would match. Without literal pathspecs, committing the first
    // sweeps the second into the commit under the wrong author.
    await writeFile(join(vault, "q3-*.md"), "glob-named\n", "utf-8");
    await writeFile(join(vault, "q3-forecast.md"), "sibling\n", "utf-8");

    const result = await commit(vault, ["q3-*.md"], "commit glob-named doc", "agent:a");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(commitFiles(result.value.hash)).toEqual(["q3-*.md"]);
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

  it("finds the last commit whose tree contained a path, not its deletion commit", async () => {
    await writeFile(join(vault, "source.md"), "present\n", "utf-8");
    const added = await commit(vault, ["source.md"], "add source", "agent:tester");
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const containing = execFileSync("git", ["-C", vault, "rev-parse", "HEAD"], {
      encoding: "utf-8",
    }).trim();

    rmSync(join(vault, "source.md"));
    const deleted = await commit(vault, ["source.md"], "delete source", "agent:tester");
    expect(deleted.ok).toBe(true);

    const result = await lastCommitContainingPath(vault, "source.md");
    expect(result).toEqual({ ok: true, value: containing });
  });

  it("returns null when a path never appeared in available history", async () => {
    await writeFile(join(vault, "other.md"), "present\n", "utf-8");
    await commit(vault, ["other.md"], "add other", "agent:tester");

    const result = await lastCommitContainingPath(vault, "never.md");
    expect(result).toEqual({ ok: true, value: null });
  });
});

// --- commit-path timeout hardening ------------------------------------------
// git() runs with no timeout: a hung subprocess (a pre-commit hook that never
// returns, a gpg passphrase prompt, an external .git/index.lock held forever)
// used to wedge every subsequent commit queued behind it in withCommitLock,
// not just the request that caused it. The commit path now bounds every
// invocation with a timeout (default 60s, overridable for tests) and fails
// fast instead of prompting for credentials in a headless server.
//
// Note on the hook fixture: git redirects a pre-commit hook's stdin from
// /dev/null (verified empirically — `read`/`cat` in the hook return instant
// EOF), so a hook that blocks on stdin does NOT reproduce a hang. A hook that
// itself sleeps does — it is a real, if short-lived, subprocess that the git
// invocation waits on. `sleep 3` outlives the 500ms injected timeout (so the
// commit genuinely hangs past it) but self-terminates quickly afterward —
// execFile's timeout only SIGTERMs the immediate `git` child, not the hook
// grandchild, so the orphaned sleep is left to expire on its own.

function writeHook(vault: string, name: string, script: string): string {
  const hooksDir = join(vault, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, name);
  writeFileSync(hookPath, script);
  chmodSync(hookPath, 0o755);
  return hookPath;
}

describe("commit timeout hardening", () => {
  let vault: string;

  beforeEach(async () => {
    vault = makeTempVault();
    const ready = await ensureGitRepo(vault);
    if (!ready.ok) throw ready.error;
  });

  afterEach(() => {
    cleanupVault(vault);
  });

  it("times out a commit whose pre-commit hook hangs, naming the likely causes", async () => {
    writeHook(vault, "pre-commit", "#!/bin/sh\nsleep 3\nexit 0\n");
    await writeFile(join(vault, "note.md"), "hello\n", "utf-8");

    const start = Date.now();
    const result = await commit(vault, ["note.md"], "add note", "agent:tester", {
      timeoutMs: 500,
    });
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/timed out/i);
    // Names at least one of the likely causes.
    expect(result.error.message).toMatch(/hook|stdin|prompt|lock/i);
    // Bounded by the injected timeout, not left hanging.
    expect(elapsed).toBeLessThan(2000);
  }, 3000);

  it("the commit chain survives a timed-out commit: a later commit on the same vault succeeds", async () => {
    writeHook(vault, "pre-commit", "#!/bin/sh\nsleep 3\nexit 0\n");
    await writeFile(join(vault, "a.md"), "a\n", "utf-8");

    const timedOut = await commit(vault, ["a.md"], "commit a", "agent:tester", {
      timeoutMs: 500,
    });
    expect(timedOut.ok).toBe(false);

    // Clear the hang, then prove the in-process chain link settled and a
    // subsequent commit on the SAME vault (same chain key) still runs.
    rmSync(join(vault, ".git", "hooks", "pre-commit"), { force: true });

    const result = await commit(vault, ["a.md"], "commit a (retry)", "agent:tester");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const history = await log(vault);
    expect(history.ok).toBe(true);
    if (!history.ok) return;
    expect(history.value[0]?.subject).toBe("commit a (retry)");
  }, 5000);

  it("sets GIT_TERMINAL_PROMPT=0 and a non-interactive GIT_ASKPASS on commit-path invocations", async () => {
    const envDump = join(vault, "env-dump.txt");
    writeHook(vault, "pre-commit", `#!/bin/sh\nenv > "${envDump}"\nexit 0\n`);
    await writeFile(join(vault, "note.md"), "hello\n", "utf-8");

    const result = await commit(vault, ["note.md"], "add note", "agent:tester");
    expect(result.ok).toBe(true);

    const dumped = readFileSync(envDump, "utf-8");
    expect(dumped).toMatch(/^GIT_TERMINAL_PROMPT=0$/m);
    expect(dumped).toMatch(/^GIT_ASKPASS=true$/m);
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
