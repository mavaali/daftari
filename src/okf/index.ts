// src/okf/index.ts
//
// `daftari okf <export|import> ...` — bridge a Daftari vault and Google Cloud's
// Open Knowledge Format (OKF) bundle. Export renders the vault as a portable OKF
// bundle any OKF consumer can read; import adopts an OKF bundle into a vault.
// The command owns arg parsing, existence checks, and human output; the actual
// translation lives in export.ts / import.ts.

import { resolve } from "node:path";
import { directoryExists } from "../storage/local.js";
import { exportBundle } from "./export.js";
import { importBundle } from "./import.js";
import { OKF_VERSION } from "./types.js";

const SUBCOMMANDS = ["export", "import"] as const;

const HELP = `daftari okf — bridge a Daftari vault and the Open Knowledge Format (OKF v${OKF_VERSION}).

OKF is Google Cloud's vendor-neutral spec for the LLM-wiki pattern: a directory
of markdown files with YAML frontmatter that any producer can emit and any
consumer can read without translation. v0.2 adds opt-in trust signals —
provenance, verification, lifecycle, and freshness metadata.

Usage:
  daftari okf export <vault> --out <dir> [--collection <name>]
  daftari okf import <bundle> --into <vault> [--dry-run] [--agent <id>]

export — write the vault as an OKF bundle (never mutates the vault):
  --out <dir>          Output directory for the bundle (required).
  --collection <name>  Export only this collection (top-level folder).

  Each doc becomes an OKF concept doc (core fields + a verbatim 'daftari'
  sidecar for lossless round-trip) plus generated index.md and log.md.
  Trust signals derive from native metadata: updated/updated_by become
  'generated', status maps to draft/stable/deprecated, ttl_days becomes an
  absolute 'stale_after' date, and sources become structured entries.
  'verified' is never fabricated — Daftari records authorship, not
  independent confirmations, so exported docs read as unverified.

import — adopt an OKF bundle into a vault (auto-commits + reindexes):
  --into <vault>       Target Daftari vault (required).
  --dry-run            Report the plan; write, commit, and index nothing.
  --agent <id>         Acting identity for authorship + commit (default agent:okf-import).

  A bundle from 'daftari okf export' round-trips exactly; a foreign bundle is
  mapped conservatively (docs land as drafts in the accumulation domain).
  v0.2 trust signals inform the mapping: human-reviewed docs (a human:* entry
  in 'verified') import with confidence high, 'status: deprecated' stays
  deprecated, and 'stale_after' converts to ttl_days. An Attested Computation
  is flagged in a warning but NOT auto-write-protected — a bundle's
  self-declared type is not an authorization; review it and elevate with
  vault_set_tier. Unmapped OKF fields are preserved under okf_* keys.

  --help, -h           Show this help.
`;

function readStringArg(argv: string[], flag: string): string | undefined {
  const raw = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (raw === undefined) return undefined;
  const idx = argv.indexOf(raw);
  return raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : argv[idx + 1];
}

// First non-flag argument (the positional vault/bundle path), or a default.
function readPositional(argv: string[], fallback: string): string {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      // Skip the value of a value-taking flag so it is not mistaken for the
      // positional. --dry-run takes no value; everything else here does.
      if (!a.includes("=") && a !== "--dry-run") i++;
      continue;
    }
    return a;
  }
  return fallback;
}

async function runExport(argv: string[]): Promise<number> {
  const vault = readPositional(argv, ".");
  const out = readStringArg(argv, "--out");
  const collection = readStringArg(argv, "--collection");

  if (!out) {
    process.stderr.write("daftari okf export: --out <dir> is required\n");
    return 1;
  }

  const resolvedVault = resolve(vault);
  if (!(await directoryExists(resolvedVault))) {
    process.stderr.write(`daftari okf export: vault directory not found: ${vault}\n`);
    return 1;
  }

  const result = await exportBundle(resolvedVault, resolve(out), { collection });
  if (!result.ok) {
    process.stderr.write(`daftari okf export: ${result.error.message}\n`);
    return 1;
  }

  for (const w of result.value.warnings) {
    process.stderr.write(`daftari okf export: warning: ${w}\n`);
  }
  process.stdout.write(
    `Exported ${result.value.documentCount} document(s) as an OKF v${OKF_VERSION} bundle to ${result.value.outDir}\n` +
      (result.value.skipped > 0 ? `  skipped: ${result.value.skipped} unparseable file(s)\n` : ""),
  );
  return 0;
}

async function runImportCmd(argv: string[]): Promise<number> {
  const bundle = readPositional(argv, ".");
  const into = readStringArg(argv, "--into");
  const agent = readStringArg(argv, "--agent");
  const dryRun = argv.includes("--dry-run");

  if (!into) {
    process.stderr.write("daftari okf import: --into <vault> is required\n");
    return 1;
  }

  const resolvedBundle = resolve(bundle);
  if (!(await directoryExists(resolvedBundle))) {
    process.stderr.write(`daftari okf import: bundle directory not found: ${bundle}\n`);
    return 1;
  }
  const resolvedVault = resolve(into);
  if (!(await directoryExists(resolvedVault))) {
    process.stderr.write(`daftari okf import: target vault not found: ${into}\n`);
    return 1;
  }

  const result = await importBundle(resolvedBundle, resolvedVault, { agent, dryRun });
  if (!result.ok) {
    process.stderr.write(`daftari okf import: ${result.error.message}\n`);
    return 1;
  }

  for (const w of result.value.warnings) {
    process.stderr.write(`daftari okf import: warning: ${w}\n`);
  }

  const r = result.value;
  if (r.dryRun) {
    process.stdout.write(`Dry run — would import ${r.imported} document(s) into ${r.vaultRoot}:\n`);
    for (const item of r.plan) {
      const tag = item.roundTrip ? " (round-trip)" : "";
      process.stdout.write(`  ${item.relPath} → collection '${item.collection}'${tag}\n`);
    }
    return 0;
  }

  process.stdout.write(
    `Imported ${r.imported} document(s) into ${r.vaultRoot}` +
      (r.commit ? ` (commit ${r.commit})` : "") +
      (r.reindexed ? ", reindexed" : "") +
      "\n" +
      (r.skipped > 0 ? `  skipped: ${r.skipped} file(s)\n` : ""),
  );
  return 0;
}

export async function runOkf(argv: string[]): Promise<number> {
  if (argv.length === 0) {
    process.stderr.write(HELP);
    return 1;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const sub = argv[0];
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    process.stderr.write(
      `daftari okf: unknown subcommand '${sub}' — expected: ${SUBCOMMANDS.join(", ")}\n`,
    );
    return 1;
  }

  return sub === "export" ? runExport(argv.slice(1)) : runImportCmd(argv.slice(1));
}
