// Pin-mint unit (U1). mintDescribesPins enriches shaless `describes` entries
// of the form `[<repo>:]<path>#L<start>[-<end>]` to `...@<sha12>` using the
// configured code repo's working-tree blob id. All operations are read-only;
// the vault and any code repos are never written to.

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyPin } from "../../src/tools/anchors.js";
import { formatPin, mintDescribesPins } from "../../src/tools/pin-mint.js";
import { clearConfigCache, configPath } from "../../src/utils/config.js";
import { commit, ensureGitRepo, hashObjectFile } from "../../src/utils/git.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A temp vault with a .daftari/config.yaml pointing at `codeRepo`. */
function makeVaultWithConfig(codeRepoPath: string, repoName = "repo"): string {
  const v = makeTempVault();
  mkdirSync(join(v, ".daftari"), { recursive: true });
  writeFileSync(configPath(v), `code_repos:\n  ${repoName}: ${codeRepoPath}\n`);
  clearConfigCache();
  return v;
}

/** A temp vault with jit_anchors: false. */
function makeVaultKillSwitch(): string {
  const v = makeTempVault();
  mkdirSync(join(v, ".daftari"), { recursive: true });
  writeFileSync(configPath(v), "jit_anchors: false\n");
  clearConfigCache();
  return v;
}

/** Commit a file to `repo` at `relPath` and return its full blob sha. */
async function commitFile(repo: string, relPath: string, content: string): Promise<string> {
  mkdirSync(join(repo, relPath, ".."), { recursive: true });
  await writeFile(join(repo, relPath), content, "utf-8");
  await commit(repo, [relPath], `add ${relPath}`, "agent:tester");
  const sha = await hashObjectFile(repo, relPath);
  if (!sha.ok) throw new Error(`hashObjectFile failed: ${sha.error.message}`);
  return sha.value;
}

// ---------------------------------------------------------------------------
// formatPin helper
// ---------------------------------------------------------------------------

describe("formatPin", () => {
  it("formats a range pin", () => {
    expect(formatPin("repo:src/a.ts", 10, 20, "abc123def456")).toBe(
      "repo:src/a.ts#L10-20@abc123def456",
    );
  });

  it("formats a single-line pin (start === end)", () => {
    expect(formatPin("repo:src/a.ts", 10, 10, "abc123def456")).toBe(
      "repo:src/a.ts#L10-10@abc123def456",
    );
  });

  it("preserves ::symbol in head verbatim", () => {
    expect(formatPin("repo:src/a.ts::MyClass", 5, 8, "deadbeef1234")).toBe(
      "repo:src/a.ts::MyClass#L5-8@deadbeef1234",
    );
  });
});

// ---------------------------------------------------------------------------
// mintDescribesPins
// ---------------------------------------------------------------------------

describe("mintDescribesPins", () => {
  let codeRepo: string;
  let vault: string;

  beforeEach(async () => {
    codeRepo = mkdtempSync(join(tmpdir(), "daftari-code-"));
    await ensureGitRepo(codeRepo);
  });

  afterEach(() => {
    rmSync(codeRepo, { recursive: true, force: true });
    if (vault) cleanupVault(vault);
    clearConfigCache();
  });

  // --- Happy path -----------------------------------------------------------

  it("happy: mints a range entry and produces an intact classifyPin result", async () => {
    const sha = await commitFile(codeRepo, "src/a.ts", "line1\nline2\nline3\n");
    vault = makeVaultWithConfig(codeRepo);

    const entries = ["repo:src/a.ts#L10-20"];
    const outcome = await mintDescribesPins(vault, entries);

    expect(outcome.minted).toHaveLength(1);
    const m = outcome.minted[0] as NonNullable<(typeof outcome.minted)[0]>;
    expect(m.entry).toBe("repo:src/a.ts#L10-20");
    // pinned should be "repo:src/a.ts#L10-20@<sha12>"
    expect(m.pinned).toMatch(/^repo:src\/a\.ts#L10-20@[0-9a-f]{12}$/);
    expect(m.committed).toBe(true);

    // The returned entries array has the rewritten entry at index 0.
    expect(outcome.entries[0]).toBe(m.pinned);
    expect(outcome.unresolved).toHaveLength(0);

    // classifyPin should report intact for the minted pin.
    const parts = m.pinned.split("@");
    const sha12 = parts[parts.length - 1] as string;
    expect(sha.startsWith(sha12)).toBe(true);

    // Build a DescribesPin from the minted pin and classify it.
    const cls = await classifyPin(codeRepo, "src/a.ts", {
      start: 10,
      end: 20,
      sha: sha12,
    });
    expect(cls?.state).toBe("intact");
  });

  it("happy: single-line #L10 normalises to #L10-10@<sha12>", async () => {
    await commitFile(codeRepo, "src/a.ts", "a\nb\nc\n");
    vault = makeVaultWithConfig(codeRepo);

    const outcome = await mintDescribesPins(vault, ["repo:src/a.ts#L10"]);

    expect(outcome.minted).toHaveLength(1);
    const m0 = outcome.minted[0] as NonNullable<(typeof outcome.minted)[0]>;
    expect(m0.pinned).toMatch(/^repo:src\/a\.ts#L10-10@[0-9a-f]{12}$/);
    expect(outcome.entries[0]).toBe(m0.pinned);
  });

  // --- Edge: uncommitted file -----------------------------------------------

  it("edge (uncommitted): mint hashes working-tree bytes, committed:false", async () => {
    // Write but do NOT commit.
    mkdirSync(join(codeRepo, "src"), { recursive: true });
    await writeFile(join(codeRepo, "src/a.ts"), "dirty content\n", "utf-8");
    vault = makeVaultWithConfig(codeRepo);

    const outcome = await mintDescribesPins(vault, ["repo:src/a.ts#L1-1"]);

    expect(outcome.minted).toHaveLength(1);
    const m = outcome.minted[0] as NonNullable<(typeof outcome.minted)[0]>;
    // sha12 is derived from working-tree bytes
    expect(m.pinned).toMatch(/^repo:src\/a\.ts#L1-1@[0-9a-f]{12}$/);
    expect(m.committed).toBe(false);
    // classifyPin uses hashObjectFile (same working-tree hash) → intact
    const mparts = m.pinned.split("@");
    const sha12 = mparts[mparts.length - 1] as string;
    const cls = await classifyPin(codeRepo, "src/a.ts", { start: 1, end: 1, sha: sha12 });
    expect(cls?.state).toBe("intact");
  });

  // --- Edge: no mapping for repo prefix -------------------------------------

  it("edge (no mapping): unrecognised repo prefix → unresolved, entry unchanged", async () => {
    vault = makeVaultWithConfig(codeRepo); // has "repo", not "ghost"

    const entries = ["ghost:src/a.ts#L10-20"];
    const outcome = await mintDescribesPins(vault, entries);

    expect(outcome.minted).toHaveLength(0);
    expect(outcome.unresolved).toHaveLength(1);
    const u0 = outcome.unresolved[0] as NonNullable<(typeof outcome.unresolved)[0]>;
    expect(u0.entry).toBe("ghost:src/a.ts#L10-20");
    expect(u0.reason).toMatch(/no configured repo/i);
    // entry byte-identical
    expect(outcome.entries[0]).toBe("ghost:src/a.ts#L10-20");
  });

  // --- Edge: bare and already-pinned entries are pass-through ---------------

  it("edge (pass-through): bare binding with no #L suffix is untouched", async () => {
    vault = makeVaultWithConfig(codeRepo);

    const entries = ["repo:src/a.ts"]; // no #L tail
    const outcome = await mintDescribesPins(vault, entries);

    expect(outcome.minted).toHaveLength(0);
    expect(outcome.unresolved).toHaveLength(0);
    expect(outcome.entries).toEqual(["repo:src/a.ts"]);
  });

  it("edge (pass-through): already-pinned entry is untouched", async () => {
    vault = makeVaultWithConfig(codeRepo);

    const pinned = "repo:src/a.ts#L10-20@abc1234abcd5"; // already has @sha
    const entries = [pinned];
    const outcome = await mintDescribesPins(vault, entries);

    expect(outcome.minted).toHaveLength(0);
    expect(outcome.unresolved).toHaveLength(0);
    expect(outcome.entries).toEqual([pinned]);
  });

  // --- Edge: kill-switch ----------------------------------------------------

  it("edge (kill-switch): jit_anchors:false → all entries untouched, empty report", async () => {
    vault = makeVaultKillSwitch();

    const entries = ["repo:src/a.ts#L10-20", "repo:src/b.ts"];
    const outcome = await mintDescribesPins(vault, entries);

    expect(outcome.minted).toHaveLength(0);
    expect(outcome.unresolved).toHaveLength(0);
    expect(outcome.entries).toEqual(entries);
  });

  // --- Error: malformed range -----------------------------------------------

  it("error (inverted range): #L20-10 → unresolved, entry unchanged", async () => {
    await commitFile(codeRepo, "src/a.ts", "a\nb\n");
    vault = makeVaultWithConfig(codeRepo);

    const entries = ["repo:src/a.ts#L20-10"];
    const outcome = await mintDescribesPins(vault, entries);

    expect(outcome.minted).toHaveLength(0);
    expect(outcome.unresolved).toHaveLength(1);
    expect(outcome.unresolved[0]!.reason).toMatch(/inverted|end.*start|range/i);
    expect(outcome.entries[0]).toBe("repo:src/a.ts#L20-10");
  });

  it("error (missing path): path absent from repo → unresolved, no throw", async () => {
    vault = makeVaultWithConfig(codeRepo); // codeRepo has no files

    const entries = ["repo:missing.ts#L1-5"];
    const outcome = await mintDescribesPins(vault, entries);

    expect(outcome.minted).toHaveLength(0);
    expect(outcome.unresolved).toHaveLength(1);
    expect(outcome.unresolved[0]!.entry).toBe("repo:missing.ts#L1-5");
    expect(outcome.entries[0]).toBe("repo:missing.ts#L1-5");
  });

  it("error (checkout absent): configured repo path does not exist → unresolved, no throw", async () => {
    const gone = join(tmpdir(), `daftari-gone-${Date.now()}`);
    // Do NOT create `gone`. Use its path as the code repo path.
    vault = makeVaultWithConfig(gone);

    const entries = ["repo:src/a.ts#L1-5"];
    const outcome = await mintDescribesPins(vault, entries);

    expect(outcome.minted).toHaveLength(0);
    expect(outcome.unresolved).toHaveLength(1);
    expect(outcome.unresolved[0]!.entry).toBe("repo:src/a.ts#L1-5");
    // Function must not throw regardless of filesystem state.
  });

  // --- R7 invariant: no writes anywhere -------------------------------------

  it("R7: vault mtime unchanged after mint (no writes to vault)", async () => {
    await commitFile(codeRepo, "src/a.ts", "hello\n");
    vault = makeVaultWithConfig(codeRepo);

    const vaultMtime = statSync(vault).mtimeMs;
    await mintDescribesPins(vault, ["repo:src/a.ts#L1-1"]);
    expect(statSync(vault).mtimeMs).toBe(vaultMtime);
  });

  it("R7: code repo mtime unchanged after mint (no writes to code repo)", async () => {
    await commitFile(codeRepo, "src/a.ts", "hello\n");
    vault = makeVaultWithConfig(codeRepo);

    const repoMtime = statSync(codeRepo).mtimeMs;
    await mintDescribesPins(vault, ["repo:src/a.ts#L1-1"]);
    expect(statSync(codeRepo).mtimeMs).toBe(repoMtime);
  });

  it("R7: source FILE mtime and content unchanged after mint (file-level write guard)", async () => {
    await commitFile(codeRepo, "src/a.ts", "line1\nline2\n");
    vault = makeVaultWithConfig(codeRepo);

    const filePath = join(codeRepo, "src/a.ts");
    const { readFileSync } = await import("node:fs");
    const beforeMtime = statSync(filePath).mtimeMs;
    const beforeContent = readFileSync(filePath, "utf-8");

    await mintDescribesPins(vault, ["repo:src/a.ts#L1-2"]);

    expect(statSync(filePath).mtimeMs).toBe(beforeMtime);
    expect(readFileSync(filePath, "utf-8")).toBe(beforeContent);
  });

  // --- Error: line number <= 0 ----------------------------------------------

  it("error (line<=0): #L0-5 → unresolved, reason mentions invalid line numbers, minted empty", async () => {
    await commitFile(codeRepo, "src/a.ts", "a\nb\nc\n");
    vault = makeVaultWithConfig(codeRepo);

    const entries = ["repo:src/a.ts#L0-5"];
    const outcome = await mintDescribesPins(vault, entries);

    expect(outcome.minted).toHaveLength(0);
    expect(outcome.unresolved).toHaveLength(1);
    const u0 = outcome.unresolved[0] as NonNullable<(typeof outcome.unresolved)[0]>;
    expect(u0.entry).toBe("repo:src/a.ts#L0-5");
    expect(u0.reason).toMatch(/invalid line|line.*must be|start=0/i);
    // entry byte-identical
    expect(outcome.entries[0]).toBe("repo:src/a.ts#L0-5");
  });

  it("error (line<=0): single #L0 → unresolved, minted empty", async () => {
    await commitFile(codeRepo, "src/a.ts", "a\nb\n");
    vault = makeVaultWithConfig(codeRepo);

    const entries = ["repo:src/a.ts#L0"];
    const outcome = await mintDescribesPins(vault, entries);

    expect(outcome.minted).toHaveLength(0);
    expect(outcome.unresolved).toHaveLength(1);
    expect(outcome.unresolved[0]?.reason).toMatch(/invalid line|line.*must be|start=0/i);
    expect(outcome.entries[0]).toBe("repo:src/a.ts#L0");
  });

  // --- Error: bare path with #L tail (no repo prefix) -----------------------

  it("error (bare with #L): src/a.ts#L5-10 (no repo: prefix) → unresolved, entry unchanged", async () => {
    await commitFile(codeRepo, "src/a.ts", "a\nb\nc\n");
    vault = makeVaultWithConfig(codeRepo); // configured repo is "repo", not ""

    const entries = ["src/a.ts#L5-10"];
    const outcome = await mintDescribesPins(vault, entries);

    expect(outcome.minted).toHaveLength(0);
    expect(outcome.unresolved).toHaveLength(1);
    const u0 = outcome.unresolved[0] as NonNullable<(typeof outcome.unresolved)[0]>;
    expect(u0.entry).toBe("src/a.ts#L5-10");
    expect(u0.reason).toMatch(/no configured repo/i);
    // entry must be byte-identical — not silently passed through as minted
    expect(outcome.entries[0]).toBe("src/a.ts#L5-10");
  });
});
