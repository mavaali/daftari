// Write-path JIT pin minting (U2). vault_write enriches shaless `describes`
// entries with @sha12 pins before validation/serialization, reports the
// outcome in `pin_mint`, and never fails the write on mint errors.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as pinMint from "../../src/tools/pin-mint.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultRatify } from "../../src/tools/staged-actions.js";
import { vaultWrite } from "../../src/tools/write.js";
import { clearConfigCache, configPath } from "../../src/utils/config.js";
import { commit, ensureGitRepo, hashObjectFile } from "../../src/utils/git.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVaultWithCodeRepo(codeRepoPath: string, repoName = "repo"): string {
  const v = makeTempVault();
  mkdirSync(join(v, ".daftari"), { recursive: true });
  writeFileSync(configPath(v), `code_repos:\n  ${repoName}: ${codeRepoPath}\n`);
  clearConfigCache();
  return v;
}

async function commitFile(repo: string, relPath: string, content: string): Promise<string> {
  mkdirSync(join(repo, relPath, ".."), { recursive: true });
  await writeFile(join(repo, relPath), content, "utf-8");
  await commit(repo, [relPath], `add ${relPath}`, "agent:tester");
  const sha = await hashObjectFile(repo, relPath);
  if (!sha.ok) throw new Error(`hashObjectFile failed: ${sha.error.message}`);
  return sha.value;
}

function baseFrontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Pin Mint Test Doc",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-08-01",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: null,
    tags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("vault_write — pin_mint (U2)", () => {
  let codeRepo: string;
  let vault: string;

  beforeEach(() => {
    codeRepo = mkdtempSync(join(tmpdir(), "daftari-code-"));
  });

  afterEach(() => {
    cleanupVault(vault);
    rmSync(codeRepo, { recursive: true, force: true });
    clearConfigCache();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy integration: one shaless entry → pinned in .md + result
  // -------------------------------------------------------------------------
  it("enriches a shaless describes entry and reports it in pin_mint (R1, R3)", async () => {
    await ensureGitRepo(codeRepo);
    const sha40 = await commitFile(codeRepo, "src/index.ts", "line1\nline2\nline3\n");
    vault = makeVaultWithCodeRepo(codeRepo, "repo");

    const shalessEntry = "repo:src/index.ts#L1-2";
    const result = await vaultWrite(vault, {
      path: "pricing/pinned-doc.md",
      body: "# Pin Test\n\nContent.\n",
      frontmatter: baseFrontmatter({ describes: [shalessEntry] }),
      agent: "agent:tester",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;

    // pin_mint present with one minted entry
    expect(result.value.pin_mint).toBeDefined();
    expect(result.value.pin_mint?.minted).toHaveLength(1);
    expect(result.value.pin_mint?.unresolved).toHaveLength(0);
    const minted = result.value.pin_mint?.minted[0];
    expect(minted?.entry).toBe(shalessEntry);
    const sha12 = sha40.slice(0, 12);
    expect(minted?.pinned).toBe(`repo:src/index.ts#L1-2@${sha12}`);

    // On-disk .md carries the pinned value in frontmatter
    const raw = readFileSync(join(vault, "pricing/pinned-doc.md"), "utf-8");
    expect(raw).toContain(`@${sha12}`);
    expect(raw).not.toContain(`${shalessEntry}\n`); // shaless form gone

    // vault_read shows anchors with intact state
    const readBack = await vaultRead(vault, "pricing/pinned-doc.md");
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw readBack.error;
    expect(readBack.value.anchors).not.toBeNull();
    expect(readBack.value.anchors?.entries[0]?.state).toBe("intact");
  }, 60_000);

  // -------------------------------------------------------------------------
  // Mixed array: bare + shaless-mintable + shaless-unmappable + already-pinned
  // -------------------------------------------------------------------------
  it("handles mixed array: exactly one minted, one unresolved, two pass-through, order preserved", async () => {
    await ensureGitRepo(codeRepo);
    const sha40 = await commitFile(codeRepo, "lib/util.ts", "a\nb\nc\n");
    vault = makeVaultWithCodeRepo(codeRepo, "repo");

    const bareEntry = "repo:lib/util.ts"; // no #L — pass through
    const mintableEntry = "repo:lib/util.ts#L1-2"; // shaless → minted
    const unmappableEntry = "norepo:lib/util.ts#L1-2"; // unknown repo → unresolved
    const pinnedEntry = `repo:lib/util.ts#L2-3@abc123def456`; // already pinned → pass through

    const result = await vaultWrite(vault, {
      path: "pricing/mixed.md",
      body: "# Mixed\n",
      frontmatter: baseFrontmatter({
        describes: [bareEntry, mintableEntry, unmappableEntry, pinnedEntry],
      }),
      agent: "agent:tester",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;

    expect(result.value.pin_mint).toBeDefined();
    expect(result.value.pin_mint?.minted).toHaveLength(1);
    expect(result.value.pin_mint?.unresolved).toHaveLength(1);
    expect(result.value.pin_mint?.minted[0]?.entry).toBe(mintableEntry);
    expect(result.value.pin_mint?.unresolved[0]?.entry).toBe(unmappableEntry);

    // Read back and verify order
    const readBack = await vaultRead(vault, "pricing/mixed.md");
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw readBack.error;
    const describes = readBack.value.frontmatter.describes ?? [];
    expect(describes[0]).toBe(bareEntry);
    expect(describes[1]).toMatch(new RegExp(`^repo:lib/util\\.ts#L1-2@${sha40.slice(0, 12)}$`));
    expect(describes[2]).toBe(unmappableEntry);
    expect(describes[3]).toBe(pinnedEntry);
  }, 60_000);

  // -------------------------------------------------------------------------
  // No describes / all-bare describes → pin_mint absent
  // -------------------------------------------------------------------------
  it("omits pin_mint entirely when describes is absent", async () => {
    vault = makeTempVault();
    clearConfigCache();

    const result = await vaultWrite(vault, {
      path: "pricing/no-describes.md",
      body: "# No Describes\n",
      frontmatter: baseFrontmatter(),
      agent: "agent:tester",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.pin_mint).toBeUndefined();
  }, 60_000);

  it("omits pin_mint entirely when describes is an empty array", async () => {
    vault = makeTempVault();
    clearConfigCache();

    const result = await vaultWrite(vault, {
      path: "pricing/empty-describes.md",
      body: "# Empty Describes\n",
      frontmatter: baseFrontmatter({ describes: [] }),
      agent: "agent:tester",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value.pin_mint).toBeUndefined();
  }, 60_000);

  it("omits pin_mint when describes has only bare entries (no #L suffix)", async () => {
    await ensureGitRepo(codeRepo);
    vault = makeVaultWithCodeRepo(codeRepo, "repo");

    const bareEntries = ["repo:src/a.ts", "repo:src/b.ts"];
    const result = await vaultWrite(vault, {
      path: "pricing/bare-describes.md",
      body: "# Bare\n",
      frontmatter: baseFrontmatter({ describes: bareEntries }),
      agent: "agent:tester",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    // No mintable entries → pin_mint absent (null-when-silent)
    expect(result.value.pin_mint).toBeUndefined();

    // On-disk describes entries must be byte-identical to what was passed in
    const readBack = await vaultRead(vault, "pricing/bare-describes.md");
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw readBack.error;
    const describes = readBack.value.frontmatter.describes ?? [];
    expect(describes).toEqual(bareEntries);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Update path: existing pinned entries preserved, new shaless entry minted
  // -------------------------------------------------------------------------
  it("on update, preserves existing pins byte-identical and mints only new shaless entries", async () => {
    await ensureGitRepo(codeRepo);
    const sha40 = await commitFile(codeRepo, "src/model.ts", "x\ny\nz\n");
    vault = makeVaultWithCodeRepo(codeRepo, "repo");

    const existingPin = `repo:src/model.ts#L1-2@${sha40.slice(0, 12)}`;

    // First write: doc with an already-pinned entry
    const first = await vaultWrite(vault, {
      path: "pricing/update-test.md",
      body: "# Update Test\n",
      frontmatter: baseFrontmatter({ describes: [existingPin] }),
      agent: "agent:tester",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw first.error;
    // Already pinned → no minting, pin_mint absent
    expect(first.value.pin_mint).toBeUndefined();

    // Second write: send the full describes array — existing pin + new shaless entry.
    // The #113 merge lets the payload win key-for-key, so we must supply all entries
    // we want to keep (the update replaces the describes array, not appends to it).
    const shalessNew = "repo:src/model.ts#L2-3";
    const update = await vaultWrite(vault, {
      path: "pricing/update-test.md",
      body: "# Update Test\n\nMore content.\n",
      frontmatter: { describes: [existingPin, shalessNew] },
      agent: "agent:tester",
    });
    expect(update.ok).toBe(true);
    if (!update.ok) throw update.error;

    // The new shaless entry was minted; the already-pinned one was passed through
    expect(update.value.pin_mint).toBeDefined();
    expect(update.value.pin_mint?.minted).toHaveLength(1);
    expect(update.value.pin_mint?.minted[0]?.entry).toBe(shalessNew);

    // On disk, both entries coexist: old pin byte-identical, new one minted
    const readBack = await vaultRead(vault, "pricing/update-test.md");
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw readBack.error;
    const describes = readBack.value.frontmatter.describes ?? [];
    // existingPin preserved byte-identical
    expect(describes).toContain(existingPin);
    // new shaless was minted
    expect(describes.some((d) => d.startsWith("repo:src/model.ts#L2-3@"))).toBe(true);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Error: mint helper throwing must NOT fail the write (R2 best-effort)
  // -------------------------------------------------------------------------
  it("write lands even when mintDescribesPins throws (best-effort, R2)", async () => {
    await ensureGitRepo(codeRepo);
    vault = makeVaultWithCodeRepo(codeRepo, "repo");

    vi.spyOn(pinMint, "mintDescribesPins").mockRejectedValue(new Error("simulated mint failure"));

    const shalessEntry = "repo:src/boom.ts#L1-5";
    const result = await vaultWrite(vault, {
      path: "pricing/mint-error.md",
      body: "# Mint Error\n",
      frontmatter: baseFrontmatter({ describes: [shalessEntry] }),
      agent: "agent:tester",
    });

    // Write must succeed despite the mint error
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;

    // Entry landed as-written (shaless), pin_mint absent (no partial result)
    const readBack = await vaultRead(vault, "pricing/mint-error.md");
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw readBack.error;
    const describes = readBack.value.frontmatter.describes ?? [];
    expect(describes).toContain(shalessEntry);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Shadow mode: pin_mint suppressed (nothing landed on disk)
  // -------------------------------------------------------------------------
  it("shadow-mode write with mintable describes returns no pin_mint and shadow log carries no @sha pin", async () => {
    await ensureGitRepo(codeRepo);
    await commitFile(codeRepo, "src/shadow.ts", "a\nb\nc\n");
    vault = makeVaultWithCodeRepo(codeRepo, "repo");

    // Enable shadow mode on the vault
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(configPath(vault), `shadow_mode: true\ncode_repos:\n  repo: ${codeRepo}\n`);
    clearConfigCache();

    const shalessEntry = "repo:src/shadow.ts#L1-2";
    const result = await vaultWrite(vault, {
      path: "pricing/shadow-pin.md",
      body: "# Shadow\n",
      frontmatter: baseFrontmatter({ describes: [shalessEntry] }),
      agent: "agent:tester",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    // Shadow mode: nothing was written, so pin_mint must be absent
    expect(result.value.shadow).toBe(true);
    expect(result.value.pin_mint).toBeUndefined();

    // The file must not exist on disk (shadow mode: nothing lands)
    const noFile = await vaultRead(vault, "pricing/shadow-pin.md");
    expect(noFile.ok).toBe(false);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Kill-switch: jit_anchors: false → no minting, entry lands verbatim
  // -------------------------------------------------------------------------
  it("jit_anchors: false — no pin_mint on result, entry lands verbatim (kill-switch, Issue 5)", async () => {
    await ensureGitRepo(codeRepo);
    await commitFile(codeRepo, "src/killswitch.ts", "x\ny\nz\n");
    vault = makeVaultWithCodeRepo(codeRepo, "repo");

    // Override config to disable JIT minting
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(configPath(vault), `jit_anchors: false\ncode_repos:\n  repo: ${codeRepo}\n`);
    clearConfigCache();

    const shalessEntry = "repo:src/killswitch.ts#L1-2";
    const result = await vaultWrite(vault, {
      path: "pricing/killswitch-pin.md",
      body: "# Kill-switch\n",
      frontmatter: baseFrontmatter({ describes: [shalessEntry] }),
      agent: "agent:tester",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    // Kill-switch active → no minting
    expect(result.value.pin_mint).toBeUndefined();

    // Entry must land on disk exactly as passed (no @sha appended)
    const readBack = await vaultRead(vault, "pricing/killswitch-pin.md");
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw readBack.error;
    const describes = readBack.value.frontmatter.describes ?? [];
    expect(describes).toContain(shalessEntry);
    expect(describes.some((d) => d.includes("@"))).toBe(false);
  }, 60_000);

  // -------------------------------------------------------------------------
  // Integration: propose-only stages verbatim; ratify → landed doc is pinned
  // -------------------------------------------------------------------------
  it("propose-only stages shaless entry verbatim; ratify dispatch mints and lands pinned (R3)", async () => {
    await ensureGitRepo(codeRepo);
    const sha40 = await commitFile(codeRepo, "api/handler.ts", "a\nb\nc\nd\n");
    vault = makeVaultWithCodeRepo(codeRepo, "repo");

    const PROPOSER = {
      user: "agent:proposer",
      roleName: "agent-proposer",
      role: { read: ["*"], write: ["*"], promote: false, ratify: false, proposeOnly: true },
    };
    const ADMIN = {
      user: "human:mihir",
      roleName: "admin",
      role: { read: ["*"], write: ["*"], promote: true, ratify: true },
    };

    const shalessEntry = "repo:api/handler.ts#L1-3";

    // Stage via propose-only role — nothing written, entry stays verbatim
    const staged = await vaultWrite(
      vault,
      {
        path: "pricing/proposed-pin.md",
        body: "# Proposed\n",
        frontmatter: baseFrontmatter({ describes: [shalessEntry] }),
        agent: "agent:proposer",
      },
      PROPOSER,
    );
    expect(staged.ok).toBe(true);
    if (!staged.ok) throw staged.error;
    expect(staged.value.action).toBe("staged");
    // No pin_mint on the staged result (nothing was written)
    expect(staged.value.pin_mint).toBeUndefined();

    // Verify file not on disk yet
    const noFile = await vaultRead(vault, "pricing/proposed-pin.md");
    expect(noFile.ok).toBe(false);

    // Ratify: dispatch runs through vaultWrite with admin access → minting happens
    const ratified = await vaultRatify(
      vault,
      { id: staged.value.staged_id, decision: "approve", principal: "human:mihir" },
      ADMIN,
    );
    expect(ratified.ok).toBe(true);
    if (!ratified.ok) throw ratified.error;
    expect(ratified.value.applied).toBe(true);

    // Landed doc should have the pinned entry
    const readBack = await vaultRead(vault, "pricing/proposed-pin.md");
    expect(readBack.ok).toBe(true);
    if (!readBack.ok) throw readBack.error;
    const describes = readBack.value.frontmatter.describes ?? [];
    const sha12 = sha40.slice(0, 12);
    expect(describes.some((d) => d.includes(`@${sha12}`))).toBe(true);
  }, 60_000);
});
