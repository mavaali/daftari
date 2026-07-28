import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyAgainstHash,
  classifyPin,
  resolveConfinedFile,
} from "../../src/anchors/classify.js";
import type { PinSpec } from "../../src/anchors/pin.js";
import { hashObjects } from "../../src/utils/git.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV }).toString();
}

function initRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "daftari-anchors-")));
  git(dir, ["init", "-q"]);
  return dir;
}

function commitAll(dir: string, message: string): void {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", message]);
}

function wholeFilePin(sha: string): PinSpec {
  return { start: null, end: null, sha };
}

describe("resolveConfinedFile", () => {
  let repo: string;
  beforeEach(() => {
    repo = initRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("resolves a plain file inside the repo", () => {
    writeFileSync(join(repo, "a.ts"), "hello\n");
    const c = resolveConfinedFile(repo, "a.ts");
    expect(c).not.toBeNull();
    expect(c?.relPath).toBe("a.ts");
  });

  it("returns null for a missing file", () => {
    expect(resolveConfinedFile(repo, "nope.ts")).toBeNull();
  });

  it("returns null for a symlink escaping the repo (never reads its bytes)", () => {
    // `outside` is a SIBLING of the repo root under its own isolated temp
    // dir, not nested inside the repo — the symlink genuinely escapes.
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "daftari-anchors-escape-")));
    try {
      const nestedRepo = join(outer, "repo");
      mkdirSync(nestedRepo);
      mkdirSync(join(outer, "outside"));
      writeFileSync(join(outer, "outside", "secret.ts"), "secret\n");
      symlinkSync(join(outer, "outside"), join(nestedRepo, "escape"));
      expect(resolveConfinedFile(nestedRepo, "escape/secret.ts")).toBeNull();
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("returns null for a directory (must be a regular file)", () => {
    mkdirSync(join(repo, "dir"));
    expect(resolveConfinedFile(repo, "dir")).toBeNull();
  });
});

describe("classifyPin — whole-file pins", () => {
  let repo: string;
  beforeEach(() => {
    repo = initRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("intact: current hash matches the pinned sha", async () => {
    writeFileSync(join(repo, "retry.ts"), "export function retry() {}\n");
    commitAll(repo, "init");
    const hashes = await hashObjects(repo, ["retry.ts"]);
    expect(hashes.ok).toBe(true);
    if (!hashes.ok) return;
    const sha = hashes.value[0] as string;

    const result = await classifyPin(repo, "retry.ts", wholeFilePin(sha));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ state: "intact" });
  });

  it("intact via a short (7-char) sha prefix", async () => {
    writeFileSync(join(repo, "retry.ts"), "export function retry() {}\n");
    commitAll(repo, "init");
    const hashes = await hashObjects(repo, ["retry.ts"]);
    if (!hashes.ok) throw hashes.error;
    const shortSha = (hashes.value[0] as string).slice(0, 7);

    const result = await classifyPin(repo, "retry.ts", wholeFilePin(shortSha));
    expect(result.ok && result.value.state).toBe("intact");
  });

  it("moved: file content changed since the pin", async () => {
    writeFileSync(join(repo, "retry.ts"), "export function retry() {}\n");
    commitAll(repo, "init");
    const hashes = await hashObjects(repo, ["retry.ts"]);
    if (!hashes.ok) throw hashes.error;
    const sha = hashes.value[0] as string;

    writeFileSync(join(repo, "retry.ts"), "export function retry(n) { return n; }\n");
    const result = await classifyPin(repo, "retry.ts", wholeFilePin(sha));
    expect(result.ok && result.value.state).toBe("moved");
  });

  it("missing: target file absent from the working tree", async () => {
    const result = await classifyPin(repo, "gone.ts", wholeFilePin("abcdef1"));
    expect(result.ok && result.value.state).toBe("missing");
  });

  it("missing: a symlink escaping the repo, bytes never read", async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "daftari-anchors-escape2-")));
    try {
      const nestedRepo = join(outer, "repo");
      mkdirSync(nestedRepo);
      git(nestedRepo, ["init", "-q"]);
      mkdirSync(join(outer, "outside"));
      writeFileSync(join(outer, "outside", "secret.ts"), "TOP SECRET CONTENT\n");
      symlinkSync(join(outer, "outside"), join(nestedRepo, "escape"));
      commitAll(nestedRepo, "init");
      const result = await classifyPin(nestedRepo, "escape/secret.ts", wholeFilePin("abcdef1"));
      expect(result.ok && result.value.state).toBe("missing");
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

describe("classifyAgainstHash — range pins (step 3)", () => {
  let repo: string;
  beforeEach(() => {
    repo = initRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("intact via relocation: exact text found at a new line range", async () => {
    const original =
      [
        "line1",
        "line2",
        "TARGET BLOCK START",
        "some meaningful content here",
        "TARGET BLOCK END",
        "line6",
      ].join("\n") + "\n";
    writeFileSync(join(repo, "f.ts"), original);
    commitAll(repo, "init");
    const pinnedHashes = await hashObjects(repo, ["f.ts"]);
    if (!pinnedHashes.ok) throw pinnedHashes.error;
    const pinnedSha = pinnedHashes.value[0] as string;
    const pin: PinSpec = { start: 3, end: 5, sha: pinnedSha };

    // Move the pinned block down by adding lines above it — text unchanged,
    // location changed.
    const relocated =
      [
        "padding1",
        "padding2",
        "line1",
        "line2",
        "TARGET BLOCK START",
        "some meaningful content here",
        "TARGET BLOCK END",
        "line6",
      ].join("\n") + "\n";
    writeFileSync(join(repo, "f.ts"), relocated);

    const currentHashes = await hashObjects(repo, ["f.ts"]);
    if (!currentHashes.ok) throw currentHashes.error;
    const currentHash = currentHashes.value[0] as string;

    const verdict = await classifyAgainstHash(repo, join(repo, "f.ts"), pin, currentHash);
    expect(verdict.state).toBe("intact");
    expect(verdict.relocated).toEqual({ start: 5, end: 7 });
  });

  it("moved: the pinned range's text is gone", async () => {
    const original = ["line1", "TARGET BLOCK marker text here", "line3"].join("\n") + "\n";
    writeFileSync(join(repo, "f.ts"), original);
    commitAll(repo, "init");
    const pinnedHashes = await hashObjects(repo, ["f.ts"]);
    if (!pinnedHashes.ok) throw pinnedHashes.error;
    const pin: PinSpec = { start: 2, end: 2, sha: pinnedHashes.value[0] as string };

    writeFileSync(
      join(repo, "f.ts"),
      ["line1", "COMPLETELY DIFFERENT rewritten text", "line3"].join("\n") + "\n",
    );
    const currentHashes = await hashObjects(repo, ["f.ts"]);
    if (!currentHashes.ok) throw currentHashes.error;

    const verdict = await classifyAgainstHash(
      repo,
      join(repo, "f.ts"),
      pin,
      currentHashes.value[0] as string,
    );
    expect(verdict.state).toBe("moved");
  });

  it("trivial pinned content (a single `}`) never classifies intact — moved instead (C7)", async () => {
    const original = ["function f() {", "  return 1;", "}"].join("\n") + "\n";
    writeFileSync(join(repo, "f.ts"), original);
    commitAll(repo, "init");
    const pinnedHashes = await hashObjects(repo, ["f.ts"]);
    if (!pinnedHashes.ok) throw pinnedHashes.error;
    const pin: PinSpec = { start: 3, end: 3, sha: pinnedHashes.value[0] as string };

    writeFileSync(join(repo, "f.ts"), ["function f() {", "  return 2;", "}"].join("\n") + "\n");
    const currentHashes = await hashObjects(repo, ["f.ts"]);
    if (!currentHashes.ok) throw currentHashes.error;

    const verdict = await classifyAgainstHash(
      repo,
      join(repo, "f.ts"),
      pin,
      currentHashes.value[0] as string,
    );
    expect(verdict.state).toBe("moved");
  });

  it("CRLF working file vs LF-pinned blob still finds the match — intact with relocated", async () => {
    const original =
      ["line1", "MEANINGFUL TARGET LINE for the test case", "line3"].join("\n") + "\n";
    writeFileSync(join(repo, "f.ts"), original);
    commitAll(repo, "init");
    const pinnedHashes = await hashObjects(repo, ["f.ts"]);
    if (!pinnedHashes.ok) throw pinnedHashes.error;
    const pin: PinSpec = { start: 2, end: 2, sha: pinnedHashes.value[0] as string };

    // Current working file uses CRLF line endings and has an extra leading
    // line, so the blob differs but the target text is present, relocated.
    const crlf =
      ["header", "line1", "MEANINGFUL TARGET LINE for the test case", "line3"].join("\r\n") +
      "\r\n";
    writeFileSync(join(repo, "f.ts"), crlf);
    const currentHashes = await hashObjects(repo, ["f.ts"]);
    if (!currentHashes.ok) throw currentHashes.error;

    const verdict = await classifyAgainstHash(
      repo,
      join(repo, "f.ts"),
      pin,
      currentHashes.value[0] as string,
    );
    expect(verdict.state).toBe("intact");
    expect(verdict.relocated).toEqual({ start: 3, end: 3 });
  });

  it("range past the pinned blob's last line -> moved", async () => {
    writeFileSync(join(repo, "f.ts"), "one line only\n");
    commitAll(repo, "init");
    const pinnedHashes = await hashObjects(repo, ["f.ts"]);
    if (!pinnedHashes.ok) throw pinnedHashes.error;
    const pin: PinSpec = { start: 1, end: 50, sha: pinnedHashes.value[0] as string };

    writeFileSync(join(repo, "f.ts"), "changed\n");
    const currentHashes = await hashObjects(repo, ["f.ts"]);
    if (!currentHashes.ok) throw currentHashes.error;
    const verdict = await classifyAgainstHash(
      repo,
      join(repo, "f.ts"),
      pin,
      currentHashes.value[0] as string,
    );
    expect(verdict.state).toBe("moved");
  });

  it("a pinned sha absent from the odb -> moved (not an error)", async () => {
    writeFileSync(join(repo, "f.ts"), "current content\n");
    commitAll(repo, "init");
    const pin: PinSpec = { start: 1, end: 1, sha: "0000000000000000000000000000000000dead" };
    const currentHashes = await hashObjects(repo, ["f.ts"]);
    if (!currentHashes.ok) throw currentHashes.error;
    const verdict = await classifyAgainstHash(
      repo,
      join(repo, "f.ts"),
      pin,
      currentHashes.value[0] as string,
    );
    expect(verdict.state).toBe("moved");
  });
});

describe("classifyPin — non-git / traversal edge cases", () => {
  it("../ traversal outside a real repo -> missing", async () => {
    const outer = realpathSync(mkdtempSync(join(tmpdir(), "daftari-anchors-outer-")));
    const repo = join(outer, "repo");
    mkdirSync(repo);
    writeFileSync(join(outer, "secret.ts"), "top secret\n");
    try {
      const result = await classifyPin(repo, "../secret.ts", wholeFilePin("abcdef1"));
      expect(result.ok && result.value.state).toBe("missing");
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

describe("hashObjects batching", () => {
  let repo: string;
  beforeEach(() => {
    repo = initRepo();
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("hashes many files in one call, mapped back by position", async () => {
    writeFileSync(join(repo, "a.ts"), "aaa\n");
    writeFileSync(join(repo, "b.ts"), "bbb\n");
    writeFileSync(join(repo, "c.ts"), "ccc\n");
    commitAll(repo, "init");
    const result = await hashObjects(repo, ["a.ts", "b.ts", "c.ts"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
    // Each hash should match a single-file hash-object call individually.
    const a = await hashObjects(repo, ["a.ts"]);
    if (!a.ok) throw a.error;
    expect(result.value[0]).toBe(a.value[0]);
  });

  it("errors the whole batch when one candidate file is missing", async () => {
    writeFileSync(join(repo, "a.ts"), "aaa\n");
    commitAll(repo, "init");
    const result = await hashObjects(repo, ["a.ts", "missing.ts"]);
    expect(result.ok).toBe(false);
  });

  it("returns [] for an empty path list without spawning git", async () => {
    const result = await hashObjects(repo, []);
    expect(result).toEqual({ ok: true, value: [] });
  });
});
