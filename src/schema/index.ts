// Top-level entry for `daftari schema` (#299) — read-only frontmatter schema
// inference and drift diff. Pure advisory curation, like vault_lint: reports,
// fixes nothing.
//
//   daftari schema infer [--scope <folder>]   the vault's de facto schema
//   daftari schema diff [--scope <folder>]    infer vs. declared, drift report
//
// Exit codes:
//   0 — success (findings, if any, are printed — this is a report, not a gate)
//   1 — usage error (missing/unknown subcommand)
//   2 — config error
//   3 — runtime error (IO failure during the vault walk)

import { resolve } from "node:path";
import { loadConfig } from "../utils/config.js";
import { diffFromDocs } from "./diff.js";
import { inferFromDocs } from "./infer.js";
import { renderDiff, renderInfer } from "./render.js";
import { scanVault } from "./scan.js";

const HELP = `daftari schema — de facto frontmatter schema inference and drift diff.

Usage:
  daftari schema infer [--vault <path>] [--scope <folder>] [--json]
  daftari schema diff [--vault <path>] [--scope <folder>] [--json] [--min-occurrences <n>]
  daftari schema --help

Subcommands:
  infer   Walk the vault (or one folder) and report every frontmatter key:
          occurrence count, inferred type(s), example values, and whether it
          looks enum-like (a small, repeated value set).
  diff    Compare the inferred schema against declared built-ins + config
          schema_extensions: undeclared keys in wide use, declared-but-unused
          extensions, keys whose values drift from their declared type/enum,
          and near-miss field names (e.g. 'state' vs 'status').

Flags:
  --vault <path>          Vault root (default: current directory).
  --scope <folder>        Restrict the walk to one folder (first path
                           component). Default: whole vault.
  --json                  Emit the report as JSON instead of text.
  --min-occurrences <n>   diff only: minimum occurrence count for an
                           undeclared key to be reported (default: 2) — a
                           single stray field on one doc is noise, not a
                           candidate for declaration.
  --help, -h               Show this help.

Read-only and advisory: neither subcommand modifies a markdown file or
.daftari/config.yaml. Run 'schema infer' before 'daftari backfill' to see
what a foreign wiki actually contains.
`;

function readArg(argv: string[], flag: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === flag) return argv[i + 1];
    const prefix = `${flag}=`;
    const a = argv[i];
    if (a?.startsWith(prefix)) return a.slice(prefix.length);
  }
  return undefined;
}

export async function runSchema(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return argv.length === 0 ? 1 : 0;
  }

  const sub = argv[0];
  if (sub !== "infer" && sub !== "diff") {
    process.stderr.write(`daftari schema: unknown subcommand '${sub}' (expected infer or diff)\n`);
    return 1;
  }
  const rest = argv.slice(1);

  const vaultRoot = resolve(readArg(rest, "--vault") ?? ".");
  const scope = readArg(rest, "--scope");
  if (scope !== undefined && scope.length === 0) {
    process.stderr.write("daftari schema: --scope cannot be empty\n");
    return 1;
  }
  const asJson = rest.includes("--json");

  const scanned = await scanVault(vaultRoot, { scope });
  if (!scanned.ok) {
    process.stderr.write(`daftari schema: ${scanned.error.message}\n`);
    return 3;
  }

  if (sub === "infer") {
    const report = inferFromDocs(scanned.value.docs, scope ?? null, scanned.value.skipped);
    process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderInfer(report));
    return 0;
  }

  // diff
  const config = loadConfig(vaultRoot);
  if (!config.ok) {
    process.stderr.write(`daftari schema: ${config.error.message}\n`);
    return 2;
  }
  const minOccurrencesRaw = readArg(rest, "--min-occurrences");
  let minOccurrences: number | undefined;
  if (minOccurrencesRaw !== undefined) {
    const n = Number(minOccurrencesRaw);
    if (!Number.isFinite(n) || n < 0) {
      process.stderr.write(
        `daftari schema: --min-occurrences must be a non-negative number, got '${minOccurrencesRaw}'\n`,
      );
      return 1;
    }
    minOccurrences = n;
  }

  const report = diffFromDocs(scanned.value.docs, config.value.schemaExtensions, scope ?? null, {
    minOccurrences,
  });
  process.stdout.write(asJson ? `${JSON.stringify(report, null, 2)}\n` : renderDiff(report));
  return 0;
}
