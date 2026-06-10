// Top-level entry for `daftari backfill` (§11.1) — git-driven frontmatter
// migration for adopting an existing wiki into Daftari.
//
// Two-step, plan/apply:
//   daftari backfill --plan [--scope <folder>]   derive + stage to a plan file
//   daftari backfill --apply --scope <folder>    write the plan under one folder
//
// --scope is REQUIRED on --apply so a whole-vault write can never happen by
// accident. The plan does not modify any markdown; the apply commits one folder
// at a time (per-folder human ratification).
//
// Exit codes:
//   0 — success
//   1 — usage error (bad flags, missing --scope on apply, no mode)
//   2 — runtime / config error

import { userInfo } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../utils/config.js";
import { type ApplyResult, applyPlan } from "./apply.js";
import { projectCoverage } from "./coverage.js";
import { slugify } from "./derive.js";
import { generatePlan, planPath, readPlan } from "./plan.js";
import type { BackfillSummary } from "./types.js";

const HELP = `daftari backfill — derive frontmatter for an existing wiki from git history.

Usage:
  daftari backfill --plan [--scope <folder>] [--vault <path>]
  daftari backfill --apply --scope <folder> [--yes] [--vault <path>]

Modes:
  --plan                 Walk the vault (or one folder), derive proposed
                         frontmatter, and write .daftari/backfill-plan.jsonl.
                         Modifies no markdown file. Idempotent — overwrites the
                         plan on each run.
  --apply                Write the plan's proposals for docs under --scope only,
                         then auto-commit them in one commit. --scope is
                         REQUIRED. Prompts for confirmation unless --yes.

Flags:
  --scope <folder>       First path component to act on (e.g. specs). Optional
                         on --plan (filters the walk), required on --apply.
  --vault <path>         Vault root (default: current directory).
  --agent <identity>     Acting identity for the apply COMMIT and provenance —
                         the migrator running the adoption (default:
                         human:<your-username>). Distinct from each doc's
                         'updated_by' FIELD, which is derived from the doc's git
                         author through backfill.identity_map (original
                         authorship, not the migrator).
  --yes                  Skip the apply confirmation prompt.
  --help, -h             Show this help.

The frontmatter 'updated_by' field records who originally authored a doc (its
git author, mapped via .daftari/config.yaml backfill.identity_map). The --agent
identity records who ran the migration — it authors the commit, not the field.
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

// Default acting identity: human:<os-username>, slugified. Falls back to
// human:cli when the username is unavailable.
function defaultAgent(): string {
  try {
    const name = userInfo().username;
    const slug = slugify(name);
    return `human:${slug || "cli"}`;
  } catch {
    return "human:cli";
  }
}

export function renderSummary(summary: BackfillSummary, planFile: string): string {
  const lines: string[] = [];
  lines.push(`Backfill plan written to ${planFile}`);
  lines.push("");
  lines.push(`  missing frontmatter:    ${summary.missing}`);
  lines.push(`  partial frontmatter:    ${summary.partial}`);
  lines.push(`  already conformant:     ${summary.conformant}`);
  if (summary.rootSkipped > 0) {
    lines.push(
      `  root-level (no folder): ${summary.rootSkipped} (skipped — backfill is per-folder)`,
    );
  }
  lines.push("");
  lines.push(
    `  ${summary.planned} doc(s) planned across ${Object.keys(summary.byScope).length} folder(s):`,
  );
  for (const scope of Object.keys(summary.byScope).sort()) {
    const cov = summary.coverage[scope];
    lines.push(
      cov
        ? `    ${scope}: ${cov.planned} planned · ${cov.willCatalog} will catalog · ` +
            `${cov.blockedByCollision} blocked by collisions · ${cov.blockedByOther} other`
        : `    ${scope}: ${summary.byScope[scope]}`,
    );
  }
  lines.push("");
  if (summary.collisions.length > 0) {
    lines.push("");
    lines.push(
      `  Field-name collisions (${summary.collisions.length}) — your value clashes with a built-in:`,
    );
    for (const c of summary.collisions) {
      lines.push(
        `    ${c.path} · ${c.field}: ${c.value}  (built-in ${c.field} ∈ {${c.expected.join(", ")}})`,
      );
    }
    lines.push("");
    lines.push("  Rename each colliding field (e.g. status → wiki_status) to keep your value;");
    lines.push(
      "  Daftari's built-in then applies on re-run. Colliding docs are skipped until renamed.",
    );
  }
  if (summary.planned > 0) {
    lines.push("Ratify a folder with:");
    for (const scope of Object.keys(summary.byScope).sort()) {
      lines.push(`  daftari backfill --apply --scope ${scope}`);
    }
    lines.push("");
    lines.push("The plan is transient — backfill never commits it (the apply commit is the");
    lines.push("audit trail). If this vault wasn't scaffolded by `daftari --init`, add");
    lines.push("`.daftari/backfill-plan.jsonl` to .gitignore so it can't be committed by hand.");
  } else {
    lines.push("Nothing to backfill.");
  }
  return `${lines.join("\n")}\n`;
}

// Throttled stderr progress for the plan walk: a heartbeat every 50 docs (and a
// final newline) when the vault is large enough to matter. Returns the
// onProgress callback, or undefined to stay silent on small vaults.
function planProgress(): (done: number, total: number) => void {
  let lastShown = 0;
  return (done, total) => {
    if (total < 50) return;
    if (done === total) {
      process.stderr.write(`\rbackfill: scanned ${total}/${total} docs\n`);
      return;
    }
    if (done - lastShown >= 50) {
      lastShown = done;
      process.stderr.write(`\rbackfill: scanned ${done}/${total} docs`);
    }
  };
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(prompt);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function renderApplyResult(r: ApplyResult): string {
  const cataloged = r.applied.length + r.unchanged.length;
  const total = cataloged + r.skipped.length;
  const out: string[] = [];
  out.push(`Backfill applied to '${r.scope}':`);
  out.push(
    `  cataloged ${cataloged} of ${total}${r.skipped.length > 0 ? ` · ${r.skipped.length} skipped` : ""}`,
  );
  out.push(`  written:   ${r.applied.length}`);
  out.push(`  unchanged: ${r.unchanged.length}`);
  if (r.skipped.length > 0) {
    out.push(`  skipped:   ${r.skipped.length}`);
    for (const s of r.skipped) out.push(`    ${s.path}: ${s.reason}`);
  }
  if (r.commit) out.push(`  commit:    ${r.commit}`);
  else if (r.applied.length === 0) out.push("  (no changes — already applied)");
  return `${out.join("\n")}\n`;
}

export async function runBackfill(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return argv.length === 0 ? 1 : 0;
  }

  const wantPlan = argv.includes("--plan");
  const wantApply = argv.includes("--apply");
  if (wantPlan === wantApply) {
    process.stderr.write("daftari backfill: pass exactly one of --plan or --apply\n");
    return 1;
  }

  const vaultRoot = resolve(readArg(argv, "--vault") ?? ".");
  const scope = readArg(argv, "--scope");
  const agent = readArg(argv, "--agent") ?? defaultAgent();

  // An explicitly-passed empty --scope ("" or `--scope=`) is a user error in
  // either mode — reject it at parse time rather than letting it slip through as
  // a no-match filter (plan) or fall to the required-scope check (apply). An
  // omitted --scope (undefined) stays valid: optional on plan, caught below on
  // apply.
  if (scope !== undefined && scope.length === 0) {
    process.stderr.write("daftari backfill: --scope cannot be empty\n");
    return 1;
  }

  const config = loadConfig(vaultRoot);
  if (!config.ok) {
    process.stderr.write(`daftari backfill: ${config.error.message}\n`);
    return 2;
  }
  const identityMap = config.value.backfillIdentityMap;

  if (wantPlan) {
    const result = await generatePlan(vaultRoot, {
      scope,
      identityMap,
      invoker: agent,
      onProgress: planProgress(),
    });
    if (!result.ok) {
      process.stderr.write(`daftari backfill: ${result.error.message}\n`);
      return 2;
    }
    process.stdout.write(renderSummary(result.value.summary, result.value.planPath));
    return 0;
  }

  // --apply
  if (scope === undefined || scope.length === 0) {
    process.stderr.write(
      "daftari backfill: --apply requires --scope <folder> (per-folder ratification; " +
        "whole-vault apply is intentionally not supported)\n",
    );
    return 1;
  }

  if (!argv.includes("--yes")) {
    // A non-interactive apply (piped stdin, CI) would block forever on the
    // prompt. Refuse with an actionable message instead of hanging.
    if (!process.stdin.isTTY) {
      process.stderr.write(
        "daftari backfill: --apply needs confirmation but stdin is not a TTY — " +
          "re-run with --yes to apply non-interactively\n",
      );
      return 1;
    }
    let coverageNote = "";
    const planForCoverage = await readPlan(planPath(vaultRoot));
    if (planForCoverage.ok) {
      const cov = projectCoverage(planForCoverage.value.filter((e) => e.scope === scope));
      coverageNote =
        ` — ${cov.willCatalog} of ${cov.planned} will catalog` +
        (cov.blockedByCollision > 0 ? `, ${cov.blockedByCollision} blocked by collisions` : "");
    }
    const proceed = await confirm(
      `Apply backfilled frontmatter to docs under '${scope}'${coverageNote} and commit as ${agent}? [y/N] `,
    );
    if (!proceed) {
      process.stderr.write("daftari backfill: aborted\n");
      return 0;
    }
  }

  const result = await applyPlan(vaultRoot, scope, agent);
  if (!result.ok) {
    process.stderr.write(`daftari backfill: ${result.error.message}\n`);
    return 2;
  }

  const r = result.value;

  // No applied, no unchanged, no skipped means the plan had no entry under this
  // scope — either a mistyped folder or a folder already fully backfilled (a
  // re-plan drops conformant docs). Either way nothing was written, so this is
  // an idempotent no-op: exit 0 (a CI loop re-applying every folder must not
  // fail here) with a message that names the likely typo case.
  if (r.applied.length === 0 && r.unchanged.length === 0 && r.skipped.length === 0) {
    process.stdout.write(
      `No planned docs under '${scope}' — nothing to apply ` +
        "(already backfilled, or check the folder name against the plan summary).\n",
    );
    return 0;
  }

  process.stdout.write(renderApplyResult(r));
  return 0;
}
