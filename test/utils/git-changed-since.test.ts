import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { changedSince, commit, log } from "../../src/utils/git.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "daftari-cs-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("changedSince", () => {
  it("lists .md files changed between a commit and HEAD", async () => {
    writeFileSync(join(dir, "a.md"), "# a\n");
    const first = await commit(dir, ["."], "first", "agent:test");
    expect(first.ok).toBe(true);
    const commits = await log(dir, { limit: 1 });
    const sha = commits.ok ? (commits.value[0]?.hash ?? "") : "";

    writeFileSync(join(dir, "b.md"), "# b\n");
    await commit(dir, ["."], "second", "agent:test");

    const res = await changedSince(dir, sha);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual(["b.md"]);
  });

  it("returns an error for an unknown commit", async () => {
    writeFileSync(join(dir, "a.md"), "# a\n");
    await commit(dir, ["."], "first", "agent:test");
    const res = await changedSince(dir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(res.ok).toBe(false);
  });
});
