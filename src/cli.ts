#!/usr/bin/env node
// Daftari CLI.
//
//   daftari --init [path]            scaffold a new vault
//   daftari --vault <path> ...       start the MCP server against a vault
//
// Server flags (--vault, --user, --role, --reindex) are parsed by main() in
// index.ts; this entry point only adds the --init scaffolding command and a
// usage screen. Diagnostics go to stderr so stdout stays a clean JSON-RPC
// stream when the server runs.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseFlag } from "./index.js";
import { reindexVault, reindexWarnings } from "./search/reindex.js";
import { commit } from "./utils/git.js";
import { VAULT_GITIGNORE } from "./utils/vault-gitignore.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `daftari — an MCP server that exposes a curated markdown vault to AI agents.

Usage:
  daftari --init [path]               Scaffold a new vault (default: ./daftari-vault)
  daftari --vault <path> [options]    Start the MCP server (stdio) against a vault
  daftari asof <ref-or-date>          Belief archaeology — the vault at a past commit (see: daftari asof --help)
  daftari audit [options]             Run a cross-repo coherence audit (see: daftari audit --help)
  daftari eval [options]              Cortex quality metric (see: daftari eval --help)
  daftari lint [options]              Vault structural checks + Tier 0 CI gate (see: daftari lint --help)
  daftari backfill [options]          Derive frontmatter for an existing wiki (see: daftari backfill --help)
  daftari consolidate [options]       Cortex loop scheduler — emit due/birth queues (see: daftari consolidate --help)
  daftari court [rule <id>] [options] Tension Court — docket, briefs, rulings (see: daftari court --help)
  daftari import obsidian <v>        Adopt an Obsidian vault in place (see: daftari import --help)
  daftari okf <export|import> ...     Bridge a vault and the Open Knowledge Format (see: daftari okf --help)
  daftari sleep [options]             Nightly metabolic pass — wake list + Morning Report (see: daftari sleep --help)

Server options:
  --user <username>    Identity the server runs as (default: guest)
  --role <rolename>    RBAC role from .daftari/config.yaml (default: deny-all guest)
  --reindex            Rebuild the SQLite index from scratch, then exit

Examples:
  npx daftari --init ./my-vault
  npx daftari --vault ./my-vault --user me --role admin
  npx daftari --vault ./my-vault --reindex
`;

const COLLECTIONS = ["competitive-intel", "pricing", "moonshot", "_drafts"];

// Example documents written by --init. Content is fictional: "Aurora" and
// "Helios" are made-up products, not real companies.
function exampleDocs(today: string): { path: string; body: string }[] {
  return [
    {
      path: "competitive-intel/aurora-pipelines-overview.md",
      body: `---
title: "Aurora Pipelines — Positioning Overview"
domain: accumulation
collection: competitive-intel
status: canonical
confidence: medium
created: ${today}
updated: ${today}
updated_by: agent:daftari-init
provenance: direct
sources:
  - aurora-product-page
superseded_by: null
ttl_days: 120
tags: [aurora, ingestion, competitive]
questions_answered:
  - "How does Aurora frame the ingestion-vs-transformation boundary?"
questions_raised:
  - "Does an authored-pipeline model slow teams down at small scale?"
---

# Aurora Pipelines — Positioning Overview

Aurora Pipelines is a fictional data-movement product used here as an example.
Its pitch: ingestion is an authored artifact you version and review, not a
managed black box.

## Questions Answered
- How does Aurora frame the ingestion-vs-transformation boundary?

## Questions Raised
- Does an authored-pipeline model slow teams down at small scale?
`,
    },
    {
      path: "pricing/helios-consumption-pricing.md",
      body: `---
title: "Helios Consumption Pricing (Compute Credit Model)"
domain: accumulation
collection: pricing
status: canonical
confidence: high
created: ${today}
updated: ${today}
updated_by: agent:daftari-init
provenance: direct
sources:
  - helios-pricing-page
superseded_by: null
ttl_days: 45
tags: [helios, pricing, consumption]
questions_answered:
  - "What is the unit of consumption billing?"
questions_raised:
  - "How predictable is monthly spend for spiky, agent-driven workloads?"
---

# Helios Consumption Pricing (Compute Credit Model)

Helios is a fictional platform used here as an example. It bills in compute
credits — a normalized compute-hour unit whose rate varies by workload tier.

## Questions Answered
- What is the unit of consumption billing?

## Questions Raised
- How predictable is monthly spend for spiky, agent-driven workloads?
`,
    },
    {
      path: "moonshot/zero-config-ingestion.md",
      body: `---
title: "Moonshot: Zero-Config Ingestion"
domain: generative
collection: moonshot
status: draft
confidence: low
created: ${today}
updated: ${today}
updated_by: agent:daftari-init
provenance: inferred
sources: []
superseded_by: null
ttl_days: 30
tags: [moonshot, ingestion, speculative]
questions_answered: []
questions_raised:
  - "What would ingestion look like with no authored schema at all?"
---

# Moonshot: Zero-Config Ingestion

A speculative sketch. Generative-domain notes are summaries, not compiled
canon — the agent flags tensions here but does not resolve them.

## Questions Answered
- (none yet — this is a draft)

## Questions Raised
- What would ingestion look like with no authored schema at all?
`,
    },
  ];
}

export async function initVault(targetPath: string): Promise<number> {
  const vaultRoot = resolve(targetPath);

  if (existsSync(vaultRoot) && readdirSync(vaultRoot).length > 0) {
    process.stderr.write(`daftari: refusing to scaffold — ${vaultRoot} exists and is not empty\n`);
    return 1;
  }

  // Directory structure: the vault root holds .daftari/ alongside one
  // directory per collection.
  mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
  for (const c of COLLECTIONS) {
    mkdirSync(join(vaultRoot, c), { recursive: true });
  }

  // RBAC config: copied from the package's bundled template.
  const template = readFileSync(resolve(HERE, "..", "templates", "config.yaml"), "utf-8");
  writeFileSync(join(vaultRoot, ".daftari", "config.yaml"), template);

  writeFileSync(join(vaultRoot, ".gitignore"), VAULT_GITIGNORE);

  const today = new Date().toISOString().slice(0, 10);
  for (const doc of exampleDocs(today)) {
    writeFileSync(join(vaultRoot, doc.path), doc.body);
  }

  // Git is the version layer — commit the scaffold so the vault has history
  // from its first moment.
  const committed = await commit(
    vaultRoot,
    ["."],
    "Initialize Daftari vault",
    "agent:daftari-init",
  );
  if (!committed.ok) {
    process.stderr.write(
      `daftari: warning: could not commit the scaffold: ${committed.error.message}\n`,
    );
  }

  // Initial index build so search works on first server start.
  const indexed = await reindexVault(vaultRoot);
  if (indexed.ok) {
    process.stderr.write(
      `daftari: indexed ${indexed.value.documentCount} docs ` +
        `(vectors ${indexed.value.vectorEnabled ? "on" : "off"})\n`,
    );
    for (const line of reindexWarnings(indexed.value))
      process.stderr.write(`daftari: warning: ${line}\n`);
  } else {
    process.stderr.write(
      `daftari: warning: initial index build failed: ${indexed.error.message}\n`,
    );
  }

  process.stdout.write(
    `Scaffolded a new Daftari vault at ${vaultRoot}\n\n` +
      `  collections: ${COLLECTIONS.join(", ")}\n` +
      `  config:      .daftari/config.yaml\n` +
      `  examples:    3 markdown documents\n\n` +
      `Next:\n` +
      `  npx daftari --vault ${targetPath} --user me --role admin\n`,
  );
  return 0;
}

export async function run(argv: string[]): Promise<void> {
  if (argv[0] === "asof") {
    const { runAsof } = await import("./asof/index.js");
    process.exitCode = await runAsof(argv.slice(1));
    return;
  }

  if (argv[0] === "audit") {
    const { runAudit } = await import("./audit/index.js");
    process.exitCode = await runAudit(argv.slice(1));
    return;
  }

  if (argv[0] === "eval") {
    const { runEval } = await import("./eval/index.js");
    process.exitCode = await runEval(argv.slice(1));
    return;
  }

  if (argv[0] === "lint") {
    const { runLintCli } = await import("./curation/lint-cli.js");
    process.exitCode = await runLintCli(argv.slice(1));
    return;
  }

  if (argv[0] === "backfill") {
    const { runBackfill } = await import("./backfill/index.js");
    process.exitCode = await runBackfill(argv.slice(1));
    return;
  }

  if (argv[0] === "consolidate") {
    const { runConsolidate } = await import("./consolidate/index.js");
    process.exitCode = await runConsolidate(argv.slice(1));
    return;
  }

  if (argv[0] === "sleep") {
    const { runSleep } = await import("./sleep/index.js");
    process.exitCode = await runSleep(argv.slice(1));
    return;
  }

  if (argv[0] === "court") {
    const { runCourt } = await import("./court/index.js");
    process.exitCode = await runCourt(argv.slice(1));
    return;
  }

  if (argv[0] === "import") {
    const { runImport } = await import("./import/index.js");
    process.exitCode = await runImport(argv.slice(1));
    return;
  }

  if (argv[0] === "okf") {
    const { runOkf } = await import("./okf/index.js");
    process.exitCode = await runOkf(argv.slice(1));
    return;
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(USAGE);
    return;
  }

  const wantsInit = argv.includes("--init") || argv.some((a) => a.startsWith("--init="));
  if (wantsInit) {
    const target = parseFlag(argv, "init") ?? "./daftari-vault";
    process.exitCode = await initVault(target);
    return;
  }

  if (parseFlag(argv, "vault")) {
    await main(argv);
    return;
  }

  process.stderr.write("daftari: nothing to do — pass --init or --vault\n\n");
  process.stderr.write(USAGE);
  process.exitCode = 1;
}

// Auto-run only when this module is the process entry point. When imported
// (by tests) it stays inert so initVault / run can be exercised directly.
//
// process.argv[1] may be a symlink: npm/npx bin shims and `npm i -g` all invoke
// the CLI through a symlinked `daftari` launcher, so the launch path differs
// from this module's real path. Both sides are resolved with realpathSync
// before comparing — without this the installed `daftari` command silently
// no-ops, since the entry-point check never matches.
function isProcessEntryPoint(): boolean {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isProcessEntryPoint()) {
  run(process.argv.slice(2)).catch((e) => {
    const reason = e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write(`daftari: fatal: ${reason}\n`);
    process.exitCode = 1;
  });
}
