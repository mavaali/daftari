import { resolve } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { SchemaExtension } from "../utils/config.js";
import { loadConfig } from "../utils/config.js";
import { diffSchema } from "./diff.js";
import { inferSchema } from "./infer.js";
import { renderInferredSchema, renderSchemaDiff } from "./render.js";
import { normalizeSchemaScope, scanVaultFrontmatter } from "./scan.js";

const HELP = `daftari schema — infer the vault's de facto frontmatter schema and compare it with declarations.

Usage:
  daftari schema infer [--vault <path>] [--scope <folder>] [--json]
  daftari schema diff [--vault <path>] [--scope <folder>] [--min-occurrences <n>] [--json]

Commands:
  infer   Report each observed frontmatter key, occurrence count, type(s),
          bounded examples, and enum-likeness.
  diff    Compare observations with built-ins + schema_extensions. Report
          widely used undeclared fields, unused extensions, invalid observed
          values, and near-miss field names.

Options:
  --vault <path>          Vault root (default: current directory).
  --scope <folder>        Restrict analysis to a vault-relative folder.
  --min-occurrences <n>   Minimum use count for undeclared candidates (default: 2).
  --json                  Emit deterministic JSON instead of Markdown.
  --help, -h              Show this help.

Read-only and advisory. No markdown, index, or config state is written.

Exit codes:
  0 — report produced
  2 — usage or config error
  3 — vault read/runtime error
`;

interface SchemaCliOptions {
  mode: "infer" | "diff";
  vault: string;
  scope?: string;
  json: boolean;
  minOccurrences: number;
}

function parseOptions(argv: string[]): Result<SchemaCliOptions, Error> {
  const mode = argv[0];
  if (mode !== "infer" && mode !== "diff") {
    return err(new Error(`unknown command ${JSON.stringify(mode)} (expected infer or diff)`));
  }
  let vault = ".";
  let scope: string | undefined;
  let json = false;
  let rawMinimum: string | undefined;
  const seen = new Set<string>();

  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index] ?? "";
    if (argument === "--json") {
      if (seen.has("--json")) return err(new Error("--json may be passed only once"));
      seen.add("--json");
      json = true;
      continue;
    }
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    if (!["--vault", "--scope", "--min-occurrences"].includes(flag)) {
      return err(new Error(`unknown argument: ${argument}`));
    }
    if (seen.has(flag)) return err(new Error(`${flag} may be passed only once`));
    seen.add(flag);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);
    const value = inline ?? argv[index + 1];
    if (value === undefined || (inline === undefined && value.startsWith("--"))) {
      return err(new Error(`${flag} requires a value`));
    }
    if (value.length === 0) {
      return err(
        new Error(flag === "--scope" ? "--scope cannot be empty" : `${flag} requires a value`),
      );
    }
    if (inline === undefined) index += 1;
    if (flag === "--vault") vault = value;
    if (flag === "--scope") scope = value;
    if (flag === "--min-occurrences") rawMinimum = value;
  }

  if (mode === "infer" && rawMinimum !== undefined) {
    return err(new Error("--min-occurrences is only valid with schema diff"));
  }
  if (rawMinimum !== undefined && !/^[1-9]\d*$/.test(rawMinimum)) {
    return err(new Error("--min-occurrences must be a positive integer"));
  }
  const minOccurrences = Number(rawMinimum ?? "2");
  if (!Number.isSafeInteger(minOccurrences)) {
    return err(new Error("--min-occurrences must be a positive integer"));
  }
  const normalizedScope = normalizeSchemaScope(scope);
  if (!normalizedScope.ok) return normalizedScope;
  return ok({ mode, vault: resolve(vault), scope: normalizedScope.value, json, minOccurrences });
}

export async function runSchema(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv.length === 0) {
    process.stderr.write(HELP);
    return 2;
  }
  const parsed = parseOptions(argv);
  if (!parsed.ok) {
    process.stderr.write(`daftari schema: ${parsed.error.message}\n`);
    return 2;
  }
  const options = parsed.value;

  let extensions: SchemaExtension[] = [];
  if (options.mode === "diff") {
    const config = loadConfig(options.vault);
    if (!config.ok) {
      process.stderr.write(`daftari schema: ${config.error.message}\n`);
      return 2;
    }
    extensions = config.value.schemaExtensions;
  }

  const scanned = await scanVaultFrontmatter(options.vault, options.scope);
  if (!scanned.ok) {
    process.stderr.write(`daftari schema: ${scanned.error.message}\n`);
    return 3;
  }

  if (options.mode === "infer") {
    const inferred = inferSchema(scanned.value.documents);
    if (options.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            mode: "infer",
            vault: options.vault,
            scope: options.scope ?? null,
            filesScanned: scanned.value.filesScanned,
            documentsAnalyzed: inferred.documentCount,
            scanIssues: scanned.value.issues,
            fields: inferred.fields,
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(
        renderInferredSchema(options.vault, options.scope, scanned.value, inferred),
      );
    }
    return 0;
  }

  const diff = diffSchema(scanned.value.documents, extensions, {
    minOccurrences: options.minOccurrences,
  });
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: "diff",
          vault: options.vault,
          scope: options.scope ?? null,
          filesScanned: scanned.value.filesScanned,
          documentsAnalyzed: diff.documentCount,
          scanIssues: scanned.value.issues,
          minOccurrences: diff.minOccurrences,
          undeclared: diff.undeclared,
          unusedExtensions: diff.unusedExtensions,
          valueDrift: diff.valueDrift,
          nearMisses: diff.nearMisses,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(renderSchemaDiff(options.vault, options.scope, scanned.value, diff));
  }
  return 0;
}
