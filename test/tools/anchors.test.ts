// Pin classifier for JIT anchors (U4). Classifies one pinned `describes`
// binding against a code repo's working tree via local git plumbing: intact
// (blob unchanged, or pinned lines relocated), moved (pinned content gone), or
// missing (target path absent). No network, no LLM. Any git/read failure on an
// otherwise-present file degrades to null (the caller skips it).

import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DescribesPin } from "../../src/audit/describes.js";
import { classifyPin } from "../../src/tools/anchors.js";
import { commit, hashObjectFile } from "../../src/utils/git.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

describe("classifyPin", () => {
  let repo: string;

  beforeEach(() => {
    repo = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(repo);
  });

  // Commit `content` at `relPath` and return the committed blob sha (full).
  async function commitFile(relPath: string, content: string): Promise<string> {
    await writeFile(join(repo, relPath), content, "utf-8");
    await commit(repo, [relPath], `add ${relPath}`, "agent:tester");
    const sha = await hashObjectFile(repo, relPath);
    if (!sha.ok) throw new Error("hashObjectFile failed in test setup");
    return sha.value;
  }

  function pin(sha: string, start: number | null, end: number | null): DescribesPin {
    return { sha, start, end };
  }

  it("intact — unchanged blob (sha prefix matches current)", async () => {
    const sha = await commitFile("code.ts", "a\nb\nc\n");
    const res = await classifyPin(repo, "code.ts", pin(sha.slice(0, 10), 1, 3));
    expect(res).toEqual({ state: "intact" });
  });

  it("intact — pinned lines relocated after content shifts down", async () => {
    const sha = await commitFile("code.ts", "one\ntwo\nthree\n"); // pin lines 2-3: two/three
    // Prepend lines (blob now differs) but keep 'two\nthree' present, shifted.
    await writeFile(join(repo, "code.ts"), "HEADER\nzero\none\ntwo\nthree\n", "utf-8");
    const res = await classifyPin(repo, "code.ts", pin(sha.slice(0, 10), 2, 3));
    expect(res?.state).toBe("intact");
    expect(res?.relocated).toEqual({ start: 4, end: 5 }); // two/three now on lines 4-5
  });

  it("moved — pinned range text no longer present", async () => {
    const sha = await commitFile("code.ts", "keep\nOLD_A\nOLD_B\nkeep\n"); // pin lines 2-3
    await writeFile(join(repo, "code.ts"), "keep\nNEW_A\nNEW_B\nkeep\n", "utf-8");
    const res = await classifyPin(repo, "code.ts", pin(sha.slice(0, 10), 2, 3));
    expect(res).toEqual({ state: "moved" });
  });

  it("missing — target path absent from the tree", async () => {
    const sha = await commitFile("code.ts", "a\nb\n");
    await rm(join(repo, "code.ts"));
    const res = await classifyPin(repo, "code.ts", pin(sha.slice(0, 10), 1, 2));
    expect(res).toEqual({ state: "missing" });
  });

  it("moved — whole-file pin (no range) with a differing blob", async () => {
    const sha = await commitFile("code.ts", "a\nb\n");
    await writeFile(join(repo, "code.ts"), "a\nb\nc\n", "utf-8"); // blob differs
    const res = await classifyPin(repo, "code.ts", pin(sha.slice(0, 10), null, null));
    expect(res).toEqual({ state: "moved" });
  });

  it("moved — pinned blob not in the odb (never-committed sha)", async () => {
    await commitFile("code.ts", "a\nb\nc\n");
    await writeFile(join(repo, "code.ts"), "x\ny\nz\n", "utf-8"); // differs from any pin
    const ghost = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; // valid hex, not in odb
    const res = await classifyPin(repo, "code.ts", pin(ghost, 1, 2));
    expect(res).toEqual({ state: "moved" });
  });

  it("skips (null) when the current file fails the guarded read (binary)", async () => {
    const sha = await commitFile("code.ts", "a\nb\nc\n");
    // Overwrite with a NUL byte → readTextFile rejects as binary → cannot search.
    await writeFile(join(repo, "code.ts"), Buffer.from([0x61, 0x00, 0x62]));
    const res = await classifyPin(repo, "code.ts", pin(sha.slice(0, 10), 1, 2));
    expect(res).toBeNull();
  });
});
