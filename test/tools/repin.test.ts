// computeRepin unit (U3). Given a vault doc's pinned `describes` entries,
// classify each one and return a RepinPlan: replacements for relocated pins
// and a skipped list for everything that cannot be re-pinned (moved, missing,
// already-intact, unmapped repo, unpinned entry). Never throws on per-entry
// problems; doc-level failures (unreadable doc, config failure) return err.

import { mkdirSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyPin } from "../../src/tools/anchors.js";
import { computeRepin } from "../../src/tools/repin.js";
import { clearConfigCache, configPath } from "../../src/utils/config.js";
import { commit, ensureGitRepo, hashObjectFile } from "../../src/utils/git.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Temp git repo for code (not a vault). */
async function makeCodeRepo(): Promise<string> {
  const { mkdtempSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "daftari-code-"));
  await ensureGitRepo(dir);
  return dir;
}

/** Commit `content` at `relPath` in `repo`; return the full blob sha. */
async function commitFile(repo: string, relPath: string, content: string): Promise<string> {
  mkdirSync(join(repo, relPath, ".."), { recursive: true });
  await writeFile(join(repo, relPath), content, "utf-8");
  await commit(repo, [relPath], `add ${relPath}`, "agent:tester");
  const sha = await hashObjectFile(repo, relPath);
  if (!sha.ok) throw new Error(`hashObjectFile failed: ${sha.error.message}`);
  return sha.value;
}

/** Create a vault with a .daftari/config.yaml pointing at `codeRepo`. */
function makeVaultWithConfig(codeRepoPath: string, repoName = "repo"): string {
  const v = makeTempVault();
  mkdirSync(join(v, ".daftari"), { recursive: true });
  writeFileSync(configPath(v), `code_repos:\n  ${repoName}: ${codeRepoPath}\n`);
  clearConfigCache();
  return v;
}

/**
 * Write a vault doc at `docRelPath` with the given `describes` entries in its
 * frontmatter. Content body is irrelevant for repin; we write a minimal doc.
 */
function writeVaultDoc(vault: string, docRelPath: string, describes: string[]): void {
  const describesYaml =
    describes.length === 0 ? "" : `describes:\n${describes.map((e) => `  - "${e}"`).join("\n")}\n`;
  const content = `---\ntitle: test doc\nstatus: draft\ncollection: knowledge\n${describesYaml}---\n\nbody\n`;
  mkdirSync(join(vault, docRelPath, ".."), { recursive: true });
  writeFileSync(join(vault, docRelPath), content, "utf-8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeRepin", () => {
  let codeRepo: string;
  let vault: string;

  beforeEach(async () => {
    codeRepo = await makeCodeRepo();
  });

  afterEach(() => {
    if (vault) cleanupVault(vault);
    const { rmSync } = require("node:fs");
    rmSync(codeRepo, { recursive: true, force: true });
    clearConfigCache();
  });

  // -------------------------------------------------------------------------
  // Happy path: relocated pin → replacement produced
  // -------------------------------------------------------------------------

  it("happy: relocated pin produces one replacement; applying it yields plain intact", async () => {
    // Commit original file: pin lines 5-8.
    const original = "line1\nline2\nline3\nline4\nTARGET_A\nTARGET_B\nTARGET_C\nTARGET_D\nline9\n";
    const sha = await commitFile(codeRepo, "src/mod.ts", original);
    const sha12 = sha.slice(0, 12);

    // The pin entry as it would appear in the doc.
    const pinEntry = `repo:src/mod.ts#L5-8@${sha12}`;

    vault = makeVaultWithConfig(codeRepo);
    writeVaultDoc(vault, "note.md", [pinEntry]);

    // Now prepend 10 lines so the target block shifts to lines 15-18.
    const prefix = Array.from({ length: 10 }, (_, i) => `inserted${i + 1}`).join("\n") + "\n";
    await writeFile(join(codeRepo, "src/mod.ts"), prefix + original, "utf-8");

    // Compute the repin plan.
    const result = await computeRepin(vault, "note.md");
    expect(result.ok, "computeRepin should succeed").toBe(true);
    if (!result.ok) return;

    const plan = result.value;
    expect(plan.replacements).toHaveLength(1);
    expect(plan.skipped).toHaveLength(0);

    const rep = plan.replacements[0]!;
    // old must match the original pin entry
    expect(rep.old).toBe(pinEntry);
    // new must encode the relocated range (lines 15-18) and the CURRENT sha12
    expect(rep.new).toMatch(/^repo:src\/mod\.ts#L15-18@[0-9a-f]{12}$/);

    // Round-trip: applying the replacement and reclassifying must yield
    // plain intact (no `relocated`).
    const newParts = rep.new.split("@");
    const newSha12 = newParts[newParts.length - 1] as string;
    const cls = await classifyPin(codeRepo, "src/mod.ts", {
      start: 15,
      end: 18,
      sha: newSha12,
    });
    expect(cls?.state).toBe("intact");
    expect(cls?.relocated).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Edge: moved (content gone) → skipped, zero replacements
  // -------------------------------------------------------------------------

  it("edge: moved pin (block deleted) → zero replacements, entry in skipped with state=moved", async () => {
    const sha = await commitFile(codeRepo, "src/mod.ts", "A\nB\nC\nD\n");
    const sha12 = sha.slice(0, 12);
    const pinEntry = `repo:src/mod.ts#L2-3@${sha12}`;

    vault = makeVaultWithConfig(codeRepo);
    writeVaultDoc(vault, "note.md", [pinEntry]);

    // Overwrite with content that does NOT contain B/C.
    await writeFile(join(codeRepo, "src/mod.ts"), "X\nY\nZ\n", "utf-8");

    const result = await computeRepin(vault, "note.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.replacements).toHaveLength(0);
    expect(result.value.skipped).toHaveLength(1);
    expect(result.value.skipped[0]!.state).toBe("moved");
    expect(result.value.skipped[0]!.entry).toBe(pinEntry);
  });

  // -------------------------------------------------------------------------
  // Edge: file deleted → skipped with state=missing
  // -------------------------------------------------------------------------

  it("edge: file deleted → zero replacements, entry in skipped with state=missing", async () => {
    const sha = await commitFile(codeRepo, "src/mod.ts", "A\nB\nC\n");
    const sha12 = sha.slice(0, 12);
    const pinEntry = `repo:src/mod.ts#L1-2@${sha12}`;

    vault = makeVaultWithConfig(codeRepo);
    writeVaultDoc(vault, "note.md", [pinEntry]);

    // Delete the file.
    const { rmSync } = require("node:fs");
    rmSync(join(codeRepo, "src/mod.ts"));

    const result = await computeRepin(vault, "note.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.replacements).toHaveLength(0);
    expect(result.value.skipped).toHaveLength(1);
    expect(result.value.skipped[0]!.state).toBe("missing");
    expect(result.value.skipped[0]!.entry).toBe(pinEntry);
  });

  // -------------------------------------------------------------------------
  // Edge: all pins plain-intact → empty replacements
  // -------------------------------------------------------------------------

  it("edge: all pins plain-intact (no relocation) → empty replacements list", async () => {
    // Commit file and do NOT modify it — blob matches the pin.
    const sha = await commitFile(codeRepo, "src/mod.ts", "A\nB\nC\n");
    const sha12 = sha.slice(0, 12);
    const pinEntry = `repo:src/mod.ts#L1-2@${sha12}`;

    vault = makeVaultWithConfig(codeRepo);
    writeVaultDoc(vault, "note.md", [pinEntry]);

    const result = await computeRepin(vault, "note.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.replacements).toHaveLength(0);
    // A plain-intact pin has nothing to do; it should NOT appear in skipped
    // either (skipped is for problems, not for "nothing to do").
    expect(result.value.skipped).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Edge: unmapped repo + unpinned entries → absent from both lists
  // -------------------------------------------------------------------------

  it("edge: unmapped repo prefix and unpinned entries → absent from replacements and skipped", async () => {
    vault = makeVaultWithConfig(codeRepo); // configured: "repo", not "other"

    writeVaultDoc(vault, "note.md", [
      "other:src/mod.ts#L1-5@abc1234abcd5", // mapped to "other" — not in config
      "repo:src/mod.ts", // no pin suffix — not a candidate
    ]);

    const result = await computeRepin(vault, "note.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.replacements).toHaveLength(0);
    expect(result.value.skipped).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Error: unreadable doc → err result, no partial plan
  // -------------------------------------------------------------------------

  it("error: unreadable doc path → err result", async () => {
    vault = makeVaultWithConfig(codeRepo);
    // Do NOT write the doc — path does not exist.

    const result = await computeRepin(vault, "does-not-exist.md");
    expect(result.ok).toBe(false);
  });
});
