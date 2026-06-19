// src/import/index.ts
//
// `daftari import <type> <vault> [flags]` — adopt foreign content into a Daftari
// vault in place. v1 supports one type, "obsidian", which delegates to the
// backfill plan/apply flow with Obsidian-aware derivation enabled. The command
// mirrors backfill's two-step UX exactly (spec: 2026-06-19-obsidian-adoption).

import { resolve } from "node:path";
import { runBackfill } from "../backfill/index.js";
import { directoryExists } from "../storage/local.js";

const SUPPORTED = ["obsidian"] as const;

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
  for (const a of rest) {
    if (!tookVault && !a.startsWith("-")) {
      vault = a;
      tookVault = true;
      continue;
    }
    passthrough.push(a);
  }

  // Adoption front door: a typo'd vault should fail loudly, not silently no-op
  // the way backfill does on a missing path.
  if (!(await directoryExists(resolve(vault)))) {
    process.stderr.write(`daftari import: vault directory not found: ${vault}\n`);
    return 1;
  }

  return runBackfill(["--vault", vault, ...passthrough], { obsidian: true });
}
