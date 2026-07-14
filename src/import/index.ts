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

const SUPPORTED = ["obsidian", "langgraph-store"] as const;

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

const HELP = `daftari import — adopt foreign content into a Daftari vault.

Usage:
  daftari import obsidian <vault> --plan [--scope <folder>]
  daftari import obsidian <vault> --apply --scope <folder> [--yes]
  daftari import langgraph-store <vault> --dsn <postgres-url> --plan [--namespace <prefix>]
  daftari import langgraph-store <vault> --dsn <postgres-url> --apply --yes [--namespace <prefix>]

obsidian: adopts an Obsidian vault *in place* — Daftari indexes and curates the
same files Obsidian authors. Mirrors 'daftari backfill' (two-step plan/apply,
per-folder ratification), harvests inline #tags, and maps a Web Clipper
'source' into Daftari 'sources'. Wikilinks are left untouched.

langgraph-store: reads a LangGraph BaseStore (Postgres 'store' table, e.g.
LangMem memories) READ-ONLY and derives one claim note per semantic memory,
with full store provenance in frontmatter. Semantic memories become claims;
episodic/procedural are counted and skipped in v1.

Flags (obsidian — passed through to backfill):
  --scope <folder>   Folder to act on. Optional on --plan, required on --apply.
  --apply / --plan   Apply a ratified folder, or stage a dry-run plan.
  --yes              Skip the apply confirmation prompt.
  --agent <id>       Acting identity for the apply commit (default human:<user>).

Flags (langgraph-store):
  --dsn <url>        Postgres DSN. Use a read-only role; the session is forced
                     read-only either way.
  --namespace <ns>   Dot-joined namespace prefix filter (e.g. 'v1' or 'v1.ops').
  --collection <c>   Target vault collection/folder (default: langgraph).
  --apply / --plan   Write notes + one commit, or preview counts.
  --yes              Required with --apply.
  --agent <id>       Acting identity for the apply commit.
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

  // langgraph-store has its own flag surface and derivation path (content
  // lives in Postgres, not files); it shares the adoption plumbing above
  // (vault check, gitignore scaffolding, git announcements) with obsidian.
  let code: number;
  if (type === "langgraph-store") {
    const { runLanggraphImport } = await import("./langgraph-store.js");
    code = await runLanggraphImport(resolvedVault, passthrough);
  } else {
    code = await runBackfill(["--vault", vault, ...passthrough], { obsidian: true });
  }

  // Day-0 gap: a freshly imported foreign corpus has never been scanned for
  // contradictions — the langgraph-store demo measured 9-10 real tensions
  // hiding in a 49-note import. Hint only, never auto-run: the scan calls an
  // LLM, and daftari's posture is explicit opt-in for anything that spends
  // (the same reasoning as consolidate's shadow_mode gate).
  if (code === 0 && isApply) {
    process.stderr.write(
      `daftari import: the imported corpus is unscanned for contradictions — ` +
        `run: daftari sleep --dream tension-scan --vault ${resolvedVault} (calls an LLM; opt-in)\n`,
    );
  }
  return code;
}
