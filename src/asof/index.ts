// Top-level entry for `daftari asof` — belief archaeology over the vault's
// git history. Strictly read-only: never checks anything out, never writes
// to the repo, needs no index and no API key.
//
// Exit codes (the audit convention):
//   0 — report produced
//   2 — config/usage error (bad ref or date, not a git repo, unknown doc)
//   3 — runtime error (IO failure writing the report)

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { listTensions } from "../curation/tension.js";
import { isGitRepo } from "../utils/git.js";
import { resolveAsofCommit } from "./git-read.js";
import { type AsofReport, renderJson, renderMarkdown } from "./report.js";
import { beliefSnapshot, counterfactualReplay, docTrajectory } from "./snapshot.js";

const HELP = `daftari asof — what did the vault believe at a past point?

Usage:
  daftari asof <ref-or-date> [--vault <path>] [options]
  daftari asof --help

<ref-or-date> is either a git ref (HEAD~5, a branch, a commit hash, a tag)
or a YYYY-MM-DD date, meaning the last commit on or before the end of that
day (committer clock).

The default report is a belief snapshot: the vault's document and tension
state at that point, plus the drift since — documents added/removed, status
and confidence transitions, and tensions opened or resolved.

Flags:
  --vault <path>         Vault root (default: current directory).
  --doc <relpath>        Add a single-document trajectory: its frontmatter
                         then vs now, and every commit touching it since.
  --blast <relpath>      Add a counterfactual replay: the blast radius of the
                         document computed over the tree AS OF the commit
                         (same source/link edge semantics as
                         vault_tension_blast), each downstream doc annotated
                         with its status today. "This fact turned out wrong —
                         who had inherited it, and where are they now?"
  --output <md>          Markdown report destination (default: stdout).
  --output-json <json>   JSON report destination (default: not written).

Read-only. Works on any daftari vault that uses git as its version layer.

Exit codes:
  0 — report produced
  2 — config/usage error (bad ref/date, not a git repo, unknown doc)
  3 — runtime error (IO failure)
`;

function readStringArg(argv: string[], flag: string): string | undefined {
  const raw = argv.find((a) => a === flag || a.startsWith(`${flag}=`));
  if (raw === undefined) return undefined;
  const idx = argv.indexOf(raw);
  return raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : argv[idx + 1];
}

export async function runAsof(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }

  const refOrDate = findPositional(argv);
  if (!refOrDate) {
    process.stderr.write("daftari asof: missing <ref-or-date>\n");
    return 2;
  }

  const vaultRoot = resolve(readStringArg(argv, "--vault") ?? ".");
  if (!(await isGitRepo(vaultRoot))) {
    process.stderr.write(`daftari asof: not a git repository: ${vaultRoot}\n`);
    return 2;
  }

  const commit = await resolveAsofCommit(vaultRoot, refOrDate);
  if (!commit.ok) {
    process.stderr.write(`daftari asof: ${commit.error.message}\n`);
    return 2;
  }

  const tensionsNow = await listTensions(vaultRoot);
  if (!tensionsNow.ok) {
    process.stderr.write(`daftari asof: ${tensionsNow.error.message}\n`);
    return 3;
  }

  const snapshot = await beliefSnapshot(vaultRoot, commit.value, tensionsNow.value);
  if (!snapshot.ok) {
    process.stderr.write(`daftari asof: ${snapshot.error.message}\n`);
    return 3;
  }

  const docPath = readStringArg(argv, "--doc");
  let trajectory = null;
  if (docPath) {
    const t = await docTrajectory(vaultRoot, commit.value, docPath);
    if (!t.ok) {
      process.stderr.write(`daftari asof: ${t.error.message}\n`);
      return 2;
    }
    trajectory = t.value;
  }

  const blastPath = readStringArg(argv, "--blast");
  let replay = null;
  if (blastPath) {
    const r = await counterfactualReplay(vaultRoot, commit.value, blastPath);
    if (!r.ok) {
      process.stderr.write(`daftari asof: ${r.error.message}\n`);
      return 2;
    }
    replay = r.value;
  }

  const report: AsofReport = {
    generatedAt: new Date().toISOString(),
    vault: vaultRoot,
    snapshot: snapshot.value,
    trajectory,
    replay,
  };

  const md = renderMarkdown(report);
  const outputMd = readStringArg(argv, "--output");
  const outputJson = readStringArg(argv, "--output-json");
  try {
    if (outputMd) {
      await writeFile(resolve(outputMd), md, "utf-8");
    } else {
      process.stdout.write(md);
    }
    if (outputJson) {
      await writeFile(resolve(outputJson), renderJson(report), "utf-8");
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`daftari asof: write failed: ${reason}\n`);
    return 3;
  }

  return 0;
}

// The positional <ref-or-date> is the first argv entry that is neither a
// --flag nor the value of a value-taking flag (the `--flag value` form; the
// `--flag=value` form never occupies its own entry).
const VALUE_FLAGS = ["--vault", "--doc", "--blast", "--output", "--output-json"];
function findPositional(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) continue;
    const prev = i > 0 ? argv[i - 1] : undefined;
    if (prev !== undefined && VALUE_FLAGS.includes(prev)) continue;
    return a;
  }
  return undefined;
}
