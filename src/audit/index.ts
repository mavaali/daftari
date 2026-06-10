// src/audit/index.ts
// Top-level entry for `daftari audit`. Loads config, runs the pipeline,
// emits reports, and translates AuditError.kind to exit codes:
//   0 — clean run within thresholds
//   1 — clean run, thresholds exceeded
//   2 — config error
//   3 — runtime error

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAnthropicClient, type LlmClient } from "../eval/llm.js";
import { checkBrokenRefs } from "./checks/broken_refs.js";
import { checkDescribesRefs } from "./checks/describes_refs.js";
import { checkStaleness } from "./checks/staleness.js";
import { collectRepos } from "./collect.js";
import { parseAuditConfig } from "./config.js";
import { classifyDescribesEdges } from "./describes.js";
import { computeExitCode } from "./exit.js";
import { classifyEdges } from "./links.js";
import { renderJson, renderMarkdown } from "./report.js";
import { logSemanticTensions, runSemanticCheck, type SemanticFinding } from "./semantic.js";
import type { AuditConfig, AuditReport } from "./types.js";

// Latest Sonnet — capable for doc/code comparison, cheaper than Opus for a
// per-binding classification. Override with --semantic-model.
const DEFAULT_SEMANTIC_MODEL = "claude-sonnet-4-6";

// Dependencies that production wires to real implementations but tests inject.
// The Anthropic client (and the ANTHROPIC_API_KEY requirement) is only
// constructed when --semantic runs without an injected client, so the default
// audit needs no key, makes no network calls, and reads no LLM config.
export interface AuditOverrides {
  llm?: LlmClient;
}

function readNumberArg(argv: string[], flag: string): number | undefined {
  const raw = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (raw === undefined) return undefined;
  const idx = argv.indexOf(raw);
  const value = raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : argv[idx + 1];
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function readStringArg(argv: string[], flag: string): string | undefined {
  const raw = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (raw === undefined) return undefined;
  const idx = argv.indexOf(raw);
  return raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : argv[idx + 1];
}

// The single docs repo that --auto-tension logs into. Tension entries live in a
// vault's .daftari/tensions.md, so the target vault must be unambiguous.
function resolveTensionVault(config: AuditConfig): string | { error: string } {
  const docsRepos = config.repos.filter((r) => r.type !== "code");
  if (docsRepos.length !== 1) {
    return {
      error:
        "--auto-tension requires exactly one docs repo to log tensions into; " +
        `found ${docsRepos.length}`,
    };
  }
  return (docsRepos[0] as { path: string }).path;
}

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
  --semantic             Opt-in LLM check: for each doc-to-code binding whose
                         target exists, ask whether the doc still accurately
                         describes the code. Slow and token-costly; off by
                         default. Requires ANTHROPIC_API_KEY.
  --semantic-model <id>  Model for --semantic (default: ${DEFAULT_SEMANTIC_MODEL}).
  --max-semantic <n>     Cap on semantic LLM calls (default: 200). Excess
                         bindings are skipped with a logged count.
  --auto-tension         With --semantic: log drifted/contradicted bindings as
                         tensions in the docs vault. Requires exactly one docs
                         repo. Never edits a doc.

Exit codes:
  0  — run succeeded, all findings under configured thresholds
  1  — run succeeded but a fail_on threshold was exceeded
  2  — config error (missing fields, bad paths, malformed YAML)
  3  — runtime error (IO failure during collection)
`;

export async function runAudit(argv: string[], overrides: AuditOverrides = {}): Promise<number> {
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

  const semantic = argv.includes("--semantic");
  const autoTension = argv.includes("--auto-tension");

  // --auto-tension only acts on semantic findings; without --semantic there are
  // none, so it would be a silent no-op. Warn rather than do nothing quietly.
  if (autoTension && !semantic) {
    process.stderr.write(
      "daftari audit: --auto-tension has no effect without --semantic (no findings to log)\n",
    );
  }

  // Fail fast on semantic preconditions, before any collection work.
  let tensionVault: string | null = null;
  if (autoTension) {
    const resolved = resolveTensionVault(config);
    if (typeof resolved !== "string") {
      process.stderr.write(`daftari audit: ${resolved.error}\n`);
      return 2;
    }
    tensionVault = resolved;
  }
  let llm: LlmClient | null = null;
  if (semantic) {
    if (overrides.llm) {
      llm = overrides.llm;
    } else {
      try {
        llm = createAnthropicClient();
      } catch (e) {
        process.stderr.write(`daftari audit: ${e instanceof Error ? e.message : String(e)}\n`);
        return 2;
      }
    }
  }

  const collected = await collectRepos(config);
  if (!collected.ok) {
    process.stderr.write(`daftari audit: ${collected.error.message}\n`);
    return collected.error.kind === "config" ? 2 : 3;
  }
  const snapshots = collected.value;

  const edges = classifyEdges(snapshots);
  const brokenRefs = checkBrokenRefs(snapshots, edges);
  const staleness = checkStaleness(snapshots, edges, config.staleness.thresholdDays, new Date());
  const describesEdges = classifyDescribesEdges(snapshots);
  const describesRefs = checkDescribesRefs(snapshots, describesEdges);

  let semanticFindings: SemanticFinding[] = [];
  if (semantic && llm) {
    semanticFindings = await runSemanticCheck(describesEdges, snapshots, {
      llm,
      model: readStringArg(argv, "--semantic-model") ?? DEFAULT_SEMANTIC_MODEL,
      maxSemantic: readNumberArg(argv, "--max-semantic"),
      onCap: (dropped) =>
        process.stderr.write(
          `daftari audit: --semantic capped; ${dropped} binding(s) not checked ` +
            `(raise --max-semantic to include them)\n`,
        ),
    });
    if (autoTension && tensionVault) {
      const { logged, errors } = await logSemanticTensions(
        semanticFindings,
        tensionVault,
        "agent:daftari-audit",
      );
      if (logged > 0) process.stderr.write(`daftari audit: logged ${logged} tension(s)\n`);
      for (const err of errors) process.stderr.write(`daftari audit: tension log: ${err}\n`);
    }
  }

  const totals = {
    reposScanned: snapshots.length,
    // Only docs repos hold managed documents; code repos are reference targets.
    docsScanned: snapshots
      .filter((s) => s.config.type !== "code")
      .reduce((n, s) => n + s.docs.size, 0),
    brokenRefs: brokenRefs.length,
    directlyStale: staleness.filter((f) => f.kind === "direct").length,
    transitivelyStale: staleness.filter((f) => f.kind === "transitive").length,
    brokenDescribes: describesRefs.length,
    semanticDrifted: semanticFindings.filter(
      (f) => f.verdict === "drifted" || f.verdict === "contradicted",
    ).length,
  };

  const report: AuditReport = {
    generatedAt: new Date().toISOString(),
    config,
    totals,
    brokenRefs,
    staleness,
    describesRefs,
    semantic: semanticFindings,
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
