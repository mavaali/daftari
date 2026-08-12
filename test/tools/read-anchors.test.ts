// Read-path JIT anchor annotation (U5). vault_read attaches an advisory
// `anchors` annotation classifying pinned `describes` bindings against a
// configured code repo — null-when-silent, capped, best-effort. No network.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultRead } from "../../src/tools/read.js";
import { configPath } from "../../src/utils/config.js";
import { commit, ensureGitRepo, hashObjectFile } from "../../src/utils/git.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

describe("vaultRead — anchors annotation", () => {
  let vault: string;
  let codeRepo: string;

  beforeEach(() => {
    vault = makeTempVault();
    codeRepo = mkdtempSync(join(tmpdir(), "daftari-code-"));
  });
  afterEach(() => {
    cleanupVault(vault);
    rmSync(codeRepo, { recursive: true, force: true });
  });

  // Commit a file into the code repo and return its committed blob sha.
  async function commitCode(relPath: string, content: string): Promise<string> {
    await ensureGitRepo(codeRepo);
    mkdirSync(join(codeRepo, relPath, ".."), { recursive: true });
    await writeFile(join(codeRepo, relPath), content, "utf-8");
    await commit(codeRepo, [relPath], `add ${relPath}`, "agent:tester");
    const sha = await hashObjectFile(codeRepo, relPath);
    if (!sha.ok) throw new Error("test setup: hashObjectFile failed");
    return sha.value;
  }

  function writeConfig(yaml: string): void {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(configPath(vault), yaml);
  }

  function writeDoc(name: string, describes: string[]): void {
    const list = describes.map((d) => `  - "${d}"`).join("\n");
    const fm = [
      "---",
      "title: Note",
      "domain: accumulation",
      "collection: notes",
      "status: draft",
      "confidence: low",
      "created: 2026-08-04",
      "provenance: direct",
      "describes:",
      list,
      "---",
      "body",
      "",
    ].join("\n");
    writeFileSync(join(vault, name), fm);
  }

  it("classifies an intact pin — non-null, checked:1, no drift banner", async () => {
    const sha = await commitCode("src/x.ts", "l1\nl2\nl3\n");
    writeConfig(`code_repos:\n  api: ${codeRepo}\n`);
    writeDoc("note.md", [`api:src/x.ts#L1-2@${sha.slice(0, 10)}`]);

    const res = await vaultRead(vault, "note.md");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.anchors).not.toBeNull();
    expect(res.value.anchors?.checked).toBe(1);
    expect(res.value.anchors?.skipped).toBe(0);
    expect(res.value.anchors?.entries[0]?.state).toBe("intact");
    expect(res.value.anchors?.banner).toBeNull();
  });

  it("surfaces a moved pin — non-null entry naming it, drift banner set", async () => {
    const sha = await commitCode("src/x.ts", "keep\nOLD_A\nOLD_B\nkeep\n");
    await writeFile(join(codeRepo, "src/x.ts"), "keep\nNEW_A\nNEW_B\nkeep\n", "utf-8");
    writeConfig(`code_repos:\n  api: ${codeRepo}\n`);
    writeDoc("note.md", [`api:src/x.ts#L2-3@${sha.slice(0, 10)}`]);

    const res = await vaultRead(vault, "note.md");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.anchors).not.toBeNull();
    expect(res.value.anchors?.entries[0]?.state).toBe("moved");
    expect(res.value.anchors?.entries[0]?.path).toBe("src/x.ts");
    expect(res.value.anchors?.banner).not.toBeNull();
  });

  it("anchors is null when jit_anchors is false (kill-switch)", async () => {
    const sha = await commitCode("src/x.ts", "l1\nl2\n");
    writeConfig(`jit_anchors: false\ncode_repos:\n  api: ${codeRepo}\n`);
    writeDoc("note.md", [`api:src/x.ts#L1-2@${sha.slice(0, 10)}`]);

    const res = await vaultRead(vault, "note.md");
    expect(res.ok && res.value.anchors).toBeNull();
  });

  it("anchors is null when the repo prefix does not resolve (disclosure rule)", async () => {
    const sha = await commitCode("src/x.ts", "l1\nl2\n");
    writeConfig(`code_repos:\n  api: ${codeRepo}\n`);
    writeDoc("note.md", [`unknown:src/x.ts#L1-2@${sha.slice(0, 10)}`]); // 'unknown' not configured

    const res = await vaultRead(vault, "note.md");
    expect(res.ok && res.value.anchors).toBeNull();
  });

  it("anchors is null when the doc has no pinned bindings", async () => {
    writeConfig(`code_repos:\n  api: ${codeRepo}\n`);
    writeDoc("note.md", ["api:src/x.ts"]); // bare binding, no pin

    const res = await vaultRead(vault, "note.md");
    expect(res.ok && res.value.anchors).toBeNull();
  });

  it("caps at 24 candidates — checked+skipped equals the pinned count", async () => {
    const sha = await commitCode("src/x.ts", "l1\nl2\n");
    writeConfig(`code_repos:\n  api: ${codeRepo}\n`);
    const many = Array.from({ length: 25 }, () => `api:src/x.ts#L1-2@${sha.slice(0, 10)}`);
    writeDoc("note.md", many);

    const res = await vaultRead(vault, "note.md");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.anchors?.checked).toBe(24);
    expect(res.value.anchors?.skipped).toBe(1);
    expect((res.value.anchors?.checked ?? 0) + (res.value.anchors?.skipped ?? 0)).toBe(25);
  });

  it("best-effort: a malformed config degrades to anchors:null, read still ok", async () => {
    writeConfig("code_repos: not-a-mapping\n");
    const sha = "deadbeef1";
    writeDoc("note.md", [`api:src/x.ts#L1-2@${sha}`]);

    const res = await vaultRead(vault, "note.md");
    expect(res.ok).toBe(true); // read never fails on the anchors check
    if (!res.ok) return;
    expect(res.value.anchors).toBeNull();
  });

  // --- U7: softened decay copy when past TTL but pins all intact -------------

  // A past-TTL doc (old `updated`, small `ttl_days`). `describes` optional.
  function writeStaleDoc(name: string, describes: string[]): void {
    const list = describes.length
      ? ["describes:", ...describes.map((d) => `  - "${d}"`)].join("\n")
      : "";
    const fm = [
      "---",
      "title: Note",
      "domain: accumulation",
      "collection: notes",
      "status: draft",
      "confidence: high",
      "created: 2020-01-01",
      "updated: 2020-01-01",
      "ttl_days: 30",
      "provenance: direct",
      list,
      "---",
      "body",
      "",
    ]
      .filter((l) => l !== "")
      .join("\n");
    writeFileSync(join(vault, name), fm);
  }

  it("softens the decay banner when past TTL and all pins are intact (append-only, level unchanged)", async () => {
    const sha = await commitCode("src/x.ts", "l1\nl2\nl3\n");
    writeConfig(`code_repos:\n  api: ${codeRepo}\n`);

    // Baseline: the same stale doc with no pins — capture its unsoftened banner.
    writeStaleDoc("base.md", []);
    const base = await vaultRead(vault, "base.md");
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const baseBanner = base.value.decay?.banner ?? "";
    expect(baseBanner.length).toBeGreaterThan(0); // it IS past TTL

    writeStaleDoc("pinned.md", [`api:src/x.ts#L1-2@${sha.slice(0, 10)}`]);
    const pinned = await vaultRead(vault, "pinned.md");
    expect(pinned.ok).toBe(true);
    if (!pinned.ok) return;
    // Append-only: level unchanged, banner starts with the base banner + softening.
    expect(pinned.value.decay?.level).toBe(base.value.decay?.level);
    expect(pinned.value.decay?.banner?.startsWith(baseBanner)).toBe(true);
    expect(pinned.value.decay?.banner).toContain("intact — the code it describes has not changed");
  });

  it("does NOT soften when a pin has moved", async () => {
    const sha = await commitCode("src/x.ts", "keep\nOLD\nkeep\n");
    await writeFile(join(codeRepo, "src/x.ts"), "keep\nNEW\nkeep\n", "utf-8");
    writeConfig(`code_repos:\n  api: ${codeRepo}\n`);
    writeStaleDoc("moved.md", [`api:src/x.ts#L2-2@${sha.slice(0, 10)}`]);

    const res = await vaultRead(vault, "moved.md");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.decay?.banner).not.toContain("code pin");
  });
});
