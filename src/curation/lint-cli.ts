// `daftari lint` — the CI gate for Tier 0 structural checks (#232 via #236
// QW1). Runs the same runLint engine vault_lint uses, operator-side (no
// access context), and computes an exit code from the Tier 0 counts only:
// referential integrity, lifecycle consistency, and schema conformance are
// CERTAIN defects, so they may gate a pipeline; the advisory checks (stale,
// orphans, drafts, ...) are reported but never affect the exit code. Same
// fail-on posture as `daftari audit` (src/audit/exit.ts): count >= threshold
// fails the run.
//
// Exit codes: 0 clean (or below thresholds), 1 gated, 2 usage/config error,
// 3 the vault could not be linted.

import { runLint, TIER0_CHECKS, type Tier0CheckName } from "./lint.js";

const HELP = `daftari lint — vault structural checks with a CI gate

Usage: daftari lint [--vault <path>] [--json] [--fail-on-<check> <n>]

Options:
  --vault <path>                        Vault root (default: .)
  --json                                Print the full lint report as JSON
  --fail-on-broken-source-refs <n>      Gate threshold (default 1)
  --fail-on-lifecycle-violations <n>    Gate threshold (default 1)
  --fail-on-invalid-frontmatter <n>     Gate threshold (default 1)

A threshold gates when the check's finding count is >= n. Set a threshold
high to effectively disable that gate. Advisory checks (stale files, orphans,
old drafts, ...) are reported but never affect the exit code.

Exit codes: 0 ok, 1 gated on a Tier 0 threshold, 2 usage error, 3 lint failed.
`;

const THRESHOLD_FLAGS: Record<string, Tier0CheckName> = {
  "--fail-on-broken-source-refs": "brokenSourceRefs",
  "--fail-on-lifecycle-violations": "lifecycleViolations",
  "--fail-on-invalid-frontmatter": "invalidFrontmatter",
};

export async function runLintCli(
  argv: string[],
  write: (s: string) => void = (s) => {
    process.stdout.write(s);
  },
  // Gate verdicts and errors go to stderr so `--json` stdout stays parseable.
  writeErr: (s: string) => void = (s) => {
    process.stderr.write(s);
  },
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    write(HELP);
    return 0;
  }

  let vaultRoot = ".";
  let json = false;
  const thresholds: Record<Tier0CheckName, number> = {
    brokenSourceRefs: 1,
    lifecycleViolations: 1,
    invalidFrontmatter: 1,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--vault") {
      const v = argv[++i];
      if (!v) {
        write("daftari lint: --vault needs a path\n");
        return 2;
      }
      vaultRoot = v;
    } else if (arg === "--json") {
      json = true;
    } else if (arg in THRESHOLD_FLAGS) {
      const raw = argv[++i];
      const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) {
        write(`daftari lint: ${arg} needs a non-negative integer, got '${raw}'\n`);
        return 2;
      }
      thresholds[THRESHOLD_FLAGS[arg] as Tier0CheckName] = n;
    } else {
      write(`daftari lint: unknown option '${arg}'\n${HELP}`);
      return 2;
    }
  }

  const report = await runLint(vaultRoot);
  if (!report.ok) {
    write(`daftari lint: ${report.error.message}\n`);
    return 3;
  }

  if (json) {
    write(`${JSON.stringify(report.value, null, 2)}\n`);
  } else {
    write(`daftari lint — ${report.value.totalFindings} finding(s)\n`);
    for (const [name, findings] of Object.entries(report.value.checks)) {
      if (findings.length === 0) continue;
      write(`  ${name}: ${findings.length}\n`);
      for (const f of findings) write(`    ${f.path} — ${f.detail}\n`);
    }
  }

  let gated = false;
  for (const check of TIER0_CHECKS) {
    const count = report.value.checks[check].length;
    if (count >= thresholds[check]) {
      writeErr(`FAIL ${check}: ${count} finding(s) >= threshold ${thresholds[check]}\n`);
      gated = true;
    }
  }
  return gated ? 1 : 0;
}
