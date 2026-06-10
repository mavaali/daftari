// src/audit/index.ts
// Top-level entry for `daftari audit`. Loads config, runs the pipeline,
// emits reports, and translates AuditError.kind to exit codes:
//   0 — clean run within thresholds
//   1 — clean run, thresholds exceeded
//   2 — config error
//   3 — runtime error

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { checkBrokenRefs } from "./checks/broken_refs.js";
import { checkStaleness } from "./checks/staleness.js";
import { collectRepos } from "./collect.js";
import { parseAuditConfig } from "./config.js";
import { computeExitCode } from "./exit.js";
import { classifyEdges } from "./links.js";
import { renderJson, renderMarkdown } from "./report.js";
import type { AuditReport } from "./types.js";

const HELP = `daftari audit — coherence checks across markdown repos.

Usage:
  daftari audit --repo <path> [--repo <path> ...] [--output <md>]
  daftari audit --config audit.yaml [--repo <path> ...]
  daftari audit --help

Flags:
  --repo <path>          Add a docs repo to the audit. May be repeated.
                         Anonymous CLI repos get no URL patterns — URL-based
                         cross-repo references to them will not be detected.
                         Use --config to declare urls explicitly.
  --code-repo <path>     Add a code repo: a raw reference target indexed by
                         path only (no frontmatter parsing). May be repeated.
                         Doc-to-code \`describes\` bindings resolve against it.
  --config <path>        Load an audit.yaml. CLI flags override its values for
                         output paths (a warning is printed to stderr).
  --output <md>          Markdown report destination (default: stdout).
  --output-json <json>   JSON report destination (default: not written).

Exit codes:
  0  — run succeeded, all findings under configured thresholds
  1  — run succeeded but a fail_on threshold was exceeded
  2  — config error (missing fields, bad paths, malformed YAML)
  3  — runtime error (IO failure during collection)
`;

export async function runAudit(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const parsed = parseAuditConfig(argv);
  if (!parsed.ok) {
    process.stderr.write(`daftari audit: ${parsed.error.message}\n`);
    return parsed.error.kind === "config" ? 2 : 3;
  }
  const config = parsed.value;

  const collected = await collectRepos(config);
  if (!collected.ok) {
    process.stderr.write(`daftari audit: ${collected.error.message}\n`);
    return collected.error.kind === "config" ? 2 : 3;
  }
  const snapshots = collected.value;

  const edges = classifyEdges(snapshots);
  const brokenRefs = checkBrokenRefs(snapshots, edges);
  const staleness = checkStaleness(snapshots, edges, config.staleness.thresholdDays, new Date());

  const totals = {
    reposScanned: snapshots.length,
    docsScanned: snapshots.reduce((n, s) => n + s.docs.size, 0),
    brokenRefs: brokenRefs.length,
    directlyStale: staleness.filter((f) => f.kind === "direct").length,
    transitivelyStale: staleness.filter((f) => f.kind === "transitive").length,
  };

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    config,
    totals,
    brokenRefs,
    staleness,
  };

  const md = renderMarkdown(report);
  try {
    if (config.output.markdown) {
      await writeFile(resolve(config.output.markdown), md, "utf-8");
    } else {
      process.stdout.write(md);
    }
    if (config.output.json) {
      await writeFile(resolve(config.output.json), renderJson(report), "utf-8");
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`daftari audit: write failed: ${reason}\n`);
    return 3;
  }

  return computeExitCode(report, config.failOn);
}
