// src/import/index.ts
//
// `daftari import <type> <vault> [flags]` — adopt foreign content into a Daftari
// vault in place. v1 supports one type, "obsidian", which delegates to the
// backfill plan/apply flow with Obsidian-aware derivation enabled. The command
// mirrors backfill's two-step UX exactly (spec: 2026-06-19-obsidian-adoption).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { dump, load } from "js-yaml";
import { runBackfill } from "../backfill/index.js";
import { directoryExists } from "../storage/local.js";
import { isGitRepo } from "../utils/git.js";
import { ensureVaultGitignore } from "../utils/vault-gitignore.js";

const SUPPORTED = ["obsidian"] as const;

// Writes git_dir (+ auto_commit:true) into the vault's config.yaml, merging into
// any existing config. Idempotent: returns "present" with no rewrite when already
// at the target. Comments in an existing config are not preserved (js-yaml dump).
function writeGitDirConfig(vaultRoot: string, gitDirValue: string): "written" | "present" {
  const cfgPath = join(vaultRoot, ".daftari", "config.yaml");
  let cfg: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    const parsed = load(readFileSync(cfgPath, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      cfg = parsed as Record<string, unknown>;
    }
  }
  if (cfg.git_dir === gitDirValue && cfg.auto_commit === true) return "present";
  cfg.git_dir = gitDirValue;
  cfg.auto_commit = true;
  mkdirSync(dirname(cfgPath), { recursive: true });
  writeFileSync(cfgPath, dump(cfg), "utf-8");
  return "written";
}

const HELP = `daftari import — adopt an existing vault into Daftari, in place.

Usage:
  daftari import obsidian <vault> --plan [--scope <folder>]
  daftari import obsidian <vault> --apply --scope <folder> [--yes]

Adopts an Obsidian vault *in place*: Daftari indexes and curates the same files
Obsidian authors. Mirrors 'daftari backfill' (two-step plan/apply, per-folder
ratification) and additionally harvests inline #tags and maps a Web Clipper
'source' into Daftari 'sources'. Wikilinks are left untouched — Daftari already
resolves them.

Flags (passed through to backfill):
  --scope <folder>   Folder to act on. Optional on --plan, required on --apply.
  --apply / --plan   Apply a ratified folder, or stage a dry-run plan.
  --yes              Skip the apply confirmation prompt.
  --agent <id>       Acting identity for the apply commit (default human:<user>).
  --help, -h         Show this help.
`;

export async function runImport(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    process.stderr.write(HELP);
    return 1;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const type = argv[0];
  if (!(SUPPORTED as readonly string[]).includes(type as string)) {
    process.stderr.write(
      `daftari import: unsupported type '${type}' — supported: ${SUPPORTED.join(", ")}\n`,
    );
    return 1;
  }

  // The vault is the first non-flag arg after the type; default to ".".
  const rest = argv.slice(1);
  let vault = ".";
  const passthrough: string[] = [];
  let tookVault = false;
  let externalGitDir: string | undefined;
  for (const a of rest) {
    if (!tookVault && !a.startsWith("-")) {
      vault = a;
      tookVault = true;
      continue;
    }
    if (a === "--external-git-dir") {
      externalGitDir = "external";
      continue;
    }
    if (a.startsWith("--external-git-dir=")) {
      externalGitDir = a.slice("--external-git-dir=".length) || "external";
      continue;
    }
    passthrough.push(a);
  }

  // Adoption front door: a typo'd vault should fail loudly, not silently no-op
  // the way backfill does on a missing path.
  const resolvedVault = resolve(vault);
  if (!(await directoryExists(resolvedVault))) {
    process.stderr.write(`daftari import: vault directory not found: ${vault}\n`);
    return 1;
  }

  // Foreign-vault footguns: most Obsidian vaults aren't git repos, and an apply
  // commit will silently `git init` one (via commit → ensureGitRepo). Announce
  // that, and scaffold the .daftari ignore rules so the ephemeral index/lock/log
  // files never leak into the user's repo on a later `git add`.
  const isGit = await isGitRepo(resolvedVault);
  if (!isGit) {
    process.stderr.write(
      externalGitDir !== undefined
        ? `daftari import: '${vault}' is not a git repository — Daftari will initialize git data at an external location (config git_dir), keeping .git out of the vault.\n`
        : `daftari import: '${vault}' is not a git repository — Daftari versions changes with git and will initialize one here.\n`,
    );
  }

  // Only --apply mutates the vault; a --plan dry-run must not write the
  // .gitignore. ensureVaultGitignore runs before runBackfill so the ignore file
  // exists before any commit. It's left untracked (git honors that) — backfill's
  // apply commits only doc paths.
  const isApply = passthrough.includes("--apply");
  if (isApply) {
    const result = await ensureVaultGitignore(resolvedVault);
    if (result !== "present") {
      process.stderr.write(
        `daftari import: wrote .daftari ignore rules to ${resolvedVault}/.gitignore\n`,
      );
    }
  }

  if (externalGitDir !== undefined) {
    if (isApply) {
      const res = writeGitDirConfig(resolvedVault, externalGitDir);
      if (res === "written") {
        process.stderr.write(
          `daftari import: configured external git-dir (git_dir: ${externalGitDir}, auto_commit: true) in ${resolvedVault}/.daftari/config.yaml\n`,
        );
      }
    } else {
      process.stderr.write(
        "daftari import: --external-git-dir will be written to config on --apply (dry-run writes nothing)\n",
      );
    }
  }

  return runBackfill(["--vault", vault, ...passthrough], { obsidian: true });
}
