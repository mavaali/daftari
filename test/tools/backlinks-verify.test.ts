// R3: opt-in live pin-state on code-facet vault_backlinks hits. Mirrors the
// read-path anchor setup (a real code git repo + a code_repos config).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultBacklinks } from "../../src/tools/backlinks.js";
import { configPath } from "../../src/utils/config.js";
import { commit, ensureGitRepo, hashObjectFile } from "../../src/utils/git.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

describe("vault_backlinks — verify (R3)", () => {
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
    writeFileSync(
      join(vault, name),
      [
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
      ].join("\n"),
    );
  }

  it("classifies an intact pin as 'intact' when verify is set", async () => {
    const sha = await commitCode("src/x.ts", "l1\nl2\nl3\n");
    writeConfig(`code_repos:\n  api: ${codeRepo}\n`);
    writeDoc("note.md", [`api:src/x.ts#L1-2@${sha.slice(0, 10)}`]);

    const res = await vaultBacklinks(vault, { target: "api:src/x.ts", verify: true });
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    const hit = res.value.references.find((r) => (r as { doc: string }).doc === "note.md") as {
      state?: string;
    };
    expect(hit?.state).toBe("intact");
  });

  it("classifies a changed pin as 'moved'", async () => {
    const sha = await commitCode("src/x.ts", "keep\nOLD_A\nOLD_B\nkeep\n");
    await writeFile(join(codeRepo, "src/x.ts"), "keep\nNEW_A\nNEW_B\nkeep\n", "utf-8");
    writeConfig(`code_repos:\n  api: ${codeRepo}\n`);
    writeDoc("note.md", [`api:src/x.ts#L2-3@${sha.slice(0, 10)}`]);

    const res = await vaultBacklinks(vault, { target: "api:src/x.ts", verify: true });
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    const hit = res.value.references[0] as { state?: string };
    expect(hit.state).toBe("moved");
  });

  it("attaches no state without verify", async () => {
    const sha = await commitCode("src/x.ts", "l1\nl2\n");
    writeConfig(`code_repos:\n  api: ${codeRepo}\n`);
    writeDoc("note.md", [`api:src/x.ts#L1@${sha.slice(0, 10)}`]);

    const res = await vaultBacklinks(vault, { target: "api:src/x.ts" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    const hit = res.value.references[0] as { state?: string };
    expect(hit.state).toBeUndefined();
  });

  it("verify with an unconfigured repo leaves the hit stateless (no false state)", async () => {
    const sha = await commitCode("src/x.ts", "l1\nl2\n");
    // No code_repos config written → nothing resolves.
    writeDoc("note.md", [`api:src/x.ts#L1@${sha.slice(0, 10)}`]);

    const res = await vaultBacklinks(vault, { target: "api:src/x.ts", verify: true });
    expect(res.ok).toBe(true);
    if (!res.ok) throw res.error;
    const hit = res.value.references[0] as { state?: string };
    expect(hit.state).toBeUndefined();
  });
});
