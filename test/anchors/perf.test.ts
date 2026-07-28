// test/anchors/perf.test.ts
// CI tripwire (2026-07-26 spec, C1): 24 intact pins across 2 repos must
// classify in well under the batched budget. This is NOT the authoritative
// check — the spec's 50ms p95 live-vault measurement is — but it is fast and
// deterministic enough to run on every CI pass, catching a regression back
// toward one git subprocess per pin (24 spawns) before it ships.

import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeAnchors } from "../../src/anchors/read.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: GIT_ENV, stdio: "ignore" });
}

function hashOf(repo: string, relPath: string): string {
  return execFileSync("git", ["-C", repo, "hash-object", relPath], { env: GIT_ENV })
    .toString()
    .trim();
}

describe("computeAnchors perf tripwire — 24 intact pins across 2 repos", () => {
  let repoA: string;
  let repoB: string;
  let describes: string[];
  let codeRepos: Record<string, string>;

  beforeAll(() => {
    repoA = realpathSync(mkdtempSync(join(tmpdir(), "daftari-anchors-perf-a-")));
    repoB = realpathSync(mkdtempSync(join(tmpdir(), "daftari-anchors-perf-b-")));
    git(repoA, ["init", "-q"]);
    git(repoB, ["init", "-q"]);

    describes = [];
    for (const [name, repo] of [["a", repoA] as const, ["b", repoB] as const]) {
      for (let i = 0; i < 12; i++) {
        writeFileSync(join(repo, `f${i}.ts`), `export const v${i} = ${i};\n`);
      }
      git(repo, ["add", "."]);
      git(repo, ["commit", "-q", "-m", "init"]);
      for (let i = 0; i < 12; i++) {
        describes.push(`${name}:f${i}.ts@${hashOf(repo, `f${i}.ts`)}`);
      }
    }
    codeRepos = { a: repoA, b: repoB };
  });

  afterAll(() => {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  });

  it("classifies all 24 intact pins in well under 150ms", async () => {
    // One warmup call so the timed run isn't paying for a cold `git`
    // process-spawn cache the OS builds on first exec.
    await computeAnchors(describes, codeRepos);

    const t0 = performance.now();
    const result = await computeAnchors(describes, codeRepos);
    const elapsed = performance.now() - t0;

    expect(result).not.toBeNull();
    expect(result?.checked).toBe(24);
    expect(result?.skipped).toBe(0);
    expect(result?.errored).toBe(0);
    expect(result?.entries.every((e) => e.state === "intact")).toBe(true);
    expect(elapsed).toBeLessThan(150);
  });
});
