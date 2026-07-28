// Citation-anchors JIT verification on vault_read (2026-07-26 spec,
// Decisions 1-2, 4; role gate per the 2026-07-27 resolution).

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { readReadLog } from "../../src/curation/read-log.js";
import { readTools, vaultRead } from "../../src/tools/read.js";
import { hashObjects } from "../../src/utils/git.js";
import { expectMatchesOutputSchema } from "../helpers/output-schema.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const readTool = readTools.find((t) => t.name === "vault_read");
if (!readTool) throw new Error("vault_read not registered");

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

function frontmatter(describes: string[], over: Record<string, string> = {}): string {
  const base: Record<string, string> = {
    title: "Retry logic notes",
    domain: "accumulation",
    collection: "engineering",
    status: "canonical",
    confidence: "high",
    created: "2026-01-05",
    updated: "2026-01-05",
    updated_by: "agent:test",
    provenance: "direct",
    ...over,
  };
  const lines = Object.entries(base).map(([k, v]) => `${k}: ${v}`);
  const describesYaml =
    describes.length > 0
      ? `describes:\n${describes.map((d) => `  - "${d}"`).join("\n")}\n`
      : "describes: []\n";
  return `---\n${lines.join("\n")}\ntags: []\n${describesYaml}---\n\nThe retry loop lives in the code repo.\n`;
}

describe("vault_read — citation anchors", () => {
  let vault: string;
  let codeRepo: string;
  let sha: string;

  beforeEach(() => {
    vault = makeTempVault();
    codeRepo = realpathSync(mkdtempSync(join(tmpdir(), "daftari-anchors-code-")));
    git(codeRepo, ["init", "-q"]);
    writeFileSync(join(codeRepo, "retry.ts"), "export function retry() {}\n");
    git(codeRepo, ["add", "."]);
    git(codeRepo, ["commit", "-q", "-m", "init"]);
    const hashes = execFileSync("git", ["-C", codeRepo, "hash-object", "retry.ts"], {
      env: GIT_ENV,
    })
      .toString()
      .trim();
    sha = hashes;

    mkdirSync(join(vault, ".daftari"), { recursive: true });
    mkdirSync(join(vault, "engineering"), { recursive: true });
  });

  afterEach(() => {
    cleanupVault(vault);
    rmSync(codeRepo, { recursive: true, force: true });
  });

  function writeConfig(extra = ""): void {
    writeFileSync(
      join(vault, ".daftari", "config.yaml"),
      `code_repos:\n  api: ${codeRepo}\n${extra}`,
    );
  }

  it("returns null when there are no pinned bindings", async () => {
    writeConfig();
    writeFileSync(join(vault, "engineering/no-pins.md"), frontmatter(["api:retry.ts"]));
    const r = await vaultRead(vault, "engineering/no-pins.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.anchors).toBeNull();
  });

  it("returns null when code_repos is empty (no config)", async () => {
    writeFileSync(join(vault, "engineering/pinned.md"), frontmatter([`api:retry.ts@${sha}`]));
    const r = await vaultRead(vault, "engineering/pinned.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.anchors).toBeNull();
  });

  it("returns null when jit_anchors: false", async () => {
    writeConfig("jit_anchors: false\n");
    writeFileSync(join(vault, "engineering/pinned.md"), frontmatter([`api:retry.ts@${sha}`]));
    const r = await vaultRead(vault, "engineering/pinned.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.anchors).toBeNull();
  });

  it("returns null when the configured repo dir does not exist", async () => {
    writeFileSync(join(vault, ".daftari", "config.yaml"), "code_repos:\n  api: /nowhere/at/all\n");
    writeFileSync(join(vault, "engineering/pinned.md"), frontmatter([`api:retry.ts@${sha}`]));
    const r = await vaultRead(vault, "engineering/pinned.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.anchors).toBeNull();
  });

  it("classifies an intact whole-file pin, no access context (operator posture)", async () => {
    writeConfig();
    writeFileSync(join(vault, "engineering/pinned.md"), frontmatter([`api:retry.ts@${sha}`]));
    const r = await vaultRead(vault, "engineering/pinned.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.anchors).not.toBeNull();
    expect(r.value.anchors?.entries).toHaveLength(1);
    expect(r.value.anchors?.entries[0]?.state).toBe("intact");
    expect(r.value.anchors?.checked).toBe(1);
    expect(r.value.anchors?.skipped).toBe(0);
    expect(r.value.anchors?.errored).toBe(0);
    expect(r.value.anchors?.banner).toBeNull();
    expectMatchesOutputSchema(readTool, r.value);
  });

  it("reports a drift banner when the pinned blob has moved", async () => {
    writeConfig();
    writeFileSync(join(vault, "engineering/pinned.md"), frontmatter(["api:retry.ts@0000000"]));
    const r = await vaultRead(vault, "engineering/pinned.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.anchors?.entries[0]?.state).toBe("moved");
    expect(r.value.anchors?.banner).toContain("CODE DRIFT");
    expectMatchesOutputSchema(readTool, r.value);
  });

  it("reports missing when the pinned file no longer exists", async () => {
    writeConfig();
    writeFileSync(join(vault, "engineering/pinned.md"), frontmatter(["api:gone.ts@0000000"]));
    const r = await vaultRead(vault, "engineering/pinned.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.anchors?.entries[0]?.state).toBe("missing");
    expect(r.value.anchors?.banner).toContain("CODE DRIFT");
  });

  it("caps at MAX_PINS_PER_READ (24): 25 pins -> checked 24, skipped 1", async () => {
    writeConfig();
    // 25 distinct paths, all missing (cheap: no per-candidate git work needed
    // to prove the cap, since missing short-circuits before hashObjects).
    const describes = Array.from({ length: 25 }, (_, i) => `api:missing-${i}.ts@0000000`);
    writeFileSync(join(vault, "engineering/many-pins.md"), frontmatter(describes));
    const r = await vaultRead(vault, "engineering/many-pins.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.anchors?.checked).toBe(24);
    expect(r.value.anchors?.skipped).toBe(1);
    expect(r.value.anchors?.entries).toHaveLength(24);
  });

  it("bare (prefix-less) bindings are never JIT-checked even if pin-shaped", async () => {
    writeConfig();
    writeFileSync(join(vault, "engineering/bare.md"), frontmatter([`retry.ts@${sha}`]));
    const r = await vaultRead(vault, "engineering/bare.md");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.anchors).toBeNull();
  });

  it("records anchors_moved/anchors_missing/anchors_errored in the read log, uncensored", async () => {
    writeConfig();
    writeFileSync(
      join(vault, "engineering/mixed.md"),
      frontmatter([`api:retry.ts@${sha}`, "api:gone.ts@0000000"]),
    );
    await vaultRead(vault, "engineering/mixed.md");
    const log = await readReadLog(vault);
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    const entry = log.value.find((e) => e.file === "engineering/mixed.md");
    expect(entry?.anchors_missing).toBe(1);
    expect(entry?.anchors_moved).toBe(0);
    expect(entry?.anchors_errored).toBe(0);
  });

  describe("Decision 4 — intact-pin softening of the decay banner", () => {
    it("softens a past-TTL banner when every pin is intact", async () => {
      writeConfig();
      const doc = frontmatter([`api:retry.ts@${sha}`], {
        created: "2020-01-01",
        updated: "2020-01-01",
      }).replace("tags: []\n", "tags: []\nttl_days: 30\n");
      writeFileSync(join(vault, "engineering/stale-but-intact.md"), doc);

      const r = await vaultRead(vault, "engineering/stale-but-intact.md");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.decay?.banner).toContain("STALE");
      expect(r.value.decay?.banner).toContain("past TTL, but its 1 code pin");
      expect(r.value.decay?.banner).toContain("has not changed since the pins were written");
    });

    it("does NOT soften when a pin is moved", async () => {
      writeConfig();
      const doc = frontmatter(["api:retry.ts@0000000"], {
        created: "2020-01-01",
        updated: "2020-01-01",
      }).replace("tags: []\n", "tags: []\nttl_days: 30\n");
      writeFileSync(join(vault, "engineering/stale-and-moved.md"), doc);

      const r = await vaultRead(vault, "engineering/stale-and-moved.md");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.decay?.banner).toContain("STALE");
      expect(r.value.decay?.banner).not.toContain("code pin");
    });

    it("vault_status's staleness distribution stays byte-identical (computeDecay is untouched)", async () => {
      // Spot check: computeDecay's pure output shape is unaffected by pins —
      // the level and reasons are identical regardless of anchors, only the
      // banner gains an appended line inside vaultRead.
      writeConfig();
      const doc = frontmatter([`api:retry.ts@${sha}`], {
        created: "2020-01-01",
        updated: "2020-01-01",
      }).replace("tags: []\n", "tags: []\nttl_days: 30\n");
      writeFileSync(join(vault, "engineering/stale-but-intact-2.md"), doc);
      const r = await vaultRead(vault, "engineering/stale-but-intact-2.md");
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.decay?.level).toBe("warn");
    });
  });

  describe("role gate — code_repo_visibility (2026-07-27 resolution)", () => {
    const baseRole = { read: ["engineering"], write: [], promote: false, ratify: false };

    it("a role WITHOUT code_repo_visibility never sees the anchors field, even though the read succeeds", async () => {
      writeConfig();
      writeFileSync(join(vault, "engineering/gated.md"), frontmatter([`api:retry.ts@${sha}`]));
      const access: AccessContext = { user: "human:analyst", roleName: "analyst", role: baseRole };
      const r = await vaultRead(vault, "engineering/gated.md", access);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.anchors).toBeNull();
      expectMatchesOutputSchema(readTool, r.value);
    });

    it("a role WITH code_repo_visibility sees the anchors field", async () => {
      writeConfig();
      writeFileSync(join(vault, "engineering/granted.md"), frontmatter([`api:retry.ts@${sha}`]));
      const access: AccessContext = {
        user: "human:operator",
        roleName: "operator",
        role: { ...baseRole, codeRepoVisibility: true },
      };
      const r = await vaultRead(vault, "engineering/granted.md", access);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.anchors).not.toBeNull();
      expect(r.value.anchors?.entries[0]?.state).toBe("intact");
    });

    it("the read log still records the true anchors_* counts for a gated-off role (telemetry is unfiltered)", async () => {
      writeConfig();
      writeFileSync(join(vault, "engineering/gated2.md"), frontmatter(["api:gone.ts@0000000"]));
      const access: AccessContext = { user: "human:analyst", roleName: "analyst", role: baseRole };
      const r = await vaultRead(vault, "engineering/gated2.md", access);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.anchors).toBeNull(); // caller-facing surface: gated off

      const log = await readReadLog(vault);
      if (!log.ok) return;
      const entry = log.value.find((e) => e.file === "engineering/gated2.md");
      expect(entry?.anchors_missing).toBe(1); // telemetry: unfiltered
    });

    it("decay softening is also gated off for a role without code_repo_visibility", async () => {
      writeConfig();
      const doc = frontmatter([`api:retry.ts@${sha}`], {
        created: "2020-01-01",
        updated: "2020-01-01",
      }).replace("tags: []\n", "tags: []\nttl_days: 30\n");
      writeFileSync(join(vault, "engineering/gated-stale.md"), doc);
      const access: AccessContext = { user: "human:analyst", roleName: "analyst", role: baseRole };
      const r = await vaultRead(vault, "engineering/gated-stale.md", access);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.decay?.banner).toContain("STALE");
      expect(r.value.decay?.banner).not.toContain("code pin");
    });
  });

  describe("errored classification (C8)", () => {
    it("a classifier failure is counted in errored and dropped from entries, never softens decay", async () => {
      // Force the batch hash-object call to fail on an otherwise-confined,
      // stat-visible file by revoking read permission on it: fs.statSync
      // (used for confinement) does not require read permission, but `git
      // hash-object` opening the file for reading does.
      const restrictedRepo = realpathSync(
        mkdtempSync(join(tmpdir(), "daftari-anchors-restricted-")),
      );
      try {
        git(restrictedRepo, ["init", "-q"]);
        writeFileSync(join(restrictedRepo, "locked.ts"), "export const x = 1;\n");
        git(restrictedRepo, ["add", "."]);
        git(restrictedRepo, ["commit", "-q", "-m", "init"]);
        chmodSync(join(restrictedRepo, "locked.ts"), 0o000);

        // Skip this test outright if the sandbox runs as root (chmod 000 is
        // then ineffective) — verify the precondition holds before asserting.
        const check = await hashObjects(restrictedRepo, ["locked.ts"]);
        if (check.ok) return; // running as root or on a fs that ignores perms; nothing to assert

        writeFileSync(
          join(vault, ".daftari", "config.yaml"),
          `code_repos:\n  restricted: ${restrictedRepo}\n`,
        );
        writeFileSync(
          join(vault, "engineering/errored.md"),
          frontmatter(["restricted:locked.ts@0000000"]),
        );
        const r = await vaultRead(vault, "engineering/errored.md");
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.anchors?.errored).toBe(1);
        expect(r.value.anchors?.entries).toHaveLength(0);
        expectMatchesOutputSchema(readTool, r.value);
      } finally {
        chmodSync(join(restrictedRepo, "locked.ts"), 0o644);
        rmSync(restrictedRepo, { recursive: true, force: true });
      }
    });
  });
});
