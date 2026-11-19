// ozor: a git clone carries knowledge, not governance. On a vault with
// Daftari write history but no governance journals, stage-/tension- IDs
// restart at 001 and collide with IDs in the history — say so loudly.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { missingGovernanceJournalsWarning } from "../../src/curation/governance-journals.js";
import { type ReindexResult, reindexWarnings } from "../../src/search/reindex.js";

describe("missingGovernanceJournalsWarning", () => {
  let dir: string;

  function commit(message: string): void {
    writeFileSync(join(dir, "notes.md"), `${message}\n`);
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message],
      { cwd: dir },
    );
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-govjournals-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("warns on a clone: Daftari write history, no governance journals", async () => {
    commit("Initialize Daftari vault");
    commit("vault_write: notes.md by agent:alpha");
    const w = await missingGovernanceJournalsWarning(dir);
    expect(w).not.toBeNull();
    expect(w).toMatch(/governance journals are absent/);
    expect(w).toMatch(/IDs restart/);
    expect(w).toMatch(/daftari sync --restore/);
  });

  it("is silent when any governance journal is present", async () => {
    commit("vault_write: notes.md by agent:alpha");
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(join(dir, ".daftari", "curation-log.jsonl"), "{}\n");
    expect(await missingGovernanceJournalsWarning(dir)).toBeNull();
  });

  it("is silent on a fresh vault with no Daftari writes yet", async () => {
    commit("Initialize Daftari vault");
    expect(await missingGovernanceJournalsWarning(dir)).toBeNull();
  });

  it("is silent outside a git repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "daftari-govjournals-plain-"));
    try {
      expect(await missingGovernanceJournalsWarning(plain)).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("reindexWarnings surfaces the governance warning", () => {
    const base: ReindexResult = {
      documentCount: 0,
      chunkCount: 0,
      vectorEnabled: false,
      skipped: [],
      invalidFrontmatter: [],
      indexedAt: "2026-11-18T00:00:00.000Z",
      embeddedCount: 0,
      cacheHits: 0,
      orphansRemoved: 0,
      governanceWarning: "governance journals are absent …",
    };
    expect(reindexWarnings(base)).toEqual(["governance journals are absent …"]);
  });
});
