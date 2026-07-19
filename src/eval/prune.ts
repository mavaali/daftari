// `daftari eval prune` (#100) — explicit, user-invoked housekeeping for the
// two unbounded artifact directories, .daftari/eval/results/ and scores/.
// history.json (self-rotating) and questions/ (cheap, referenced by results)
// are never touched. Selection is by file mtime: this is disk housekeeping,
// so the filesystem's own clock is the honest ordering — it never depends on
// parsing artifact contents that may be truncated or malformed.

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { resultsDir, scoresDir } from "./storage.js";

export interface PruneRules {
  // Retain the N most-recent files. undefined = no count-based retention.
  keep?: number;
  // Retain files younger than this many milliseconds. undefined = no
  // age-based retention.
  maxAgeMs?: number;
}

export interface PruneCandidate {
  name: string;
  mtimeMs: number;
  size: number;
}

export interface PrunePlan {
  kept: PruneCandidate[];
  deleted: PruneCandidate[];
}

// Splits candidates into kept/deleted under the LEAST-DESTRUCTION reading of
// combined rules: a file SURVIVES if any given rule retains it — within the
// keep-N most recent, OR younger than the age cutoff. Only files failing
// every supplied rule are deleted. Pure; ordering ties break by name so the
// plan is deterministic for identical mtimes.
export function planPrune(
  candidates: PruneCandidate[],
  rules: PruneRules,
  nowMs: number,
): PrunePlan {
  const sorted = [...candidates].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name),
  );
  const kept: PruneCandidate[] = [];
  const deleted: PruneCandidate[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i] as PruneCandidate;
    const keptByCount = rules.keep !== undefined && i < rules.keep;
    const keptByAge = rules.maxAgeMs !== undefined && nowMs - c.mtimeMs < rules.maxAgeMs;
    if (keptByCount || keptByAge) kept.push(c);
    else deleted.push(c);
  }
  return { kept, deleted };
}

// Parses the --older-than value: <N>d (days) or <N>h (hours). Throws on any
// other shape — the CLI boundary maps the throw to the config exit code.
export function parseOlderThan(value: string): number {
  const m = /^(\d+)([dh])$/.exec(value.trim());
  if (!m) {
    throw new Error(`--older-than must look like 30d or 12h (got '${value}')`);
  }
  const n = parseInt(m[1] as string, 10);
  const unitMs = m[2] === "d" ? 86_400_000 : 3_600_000;
  return n * unitMs;
}

export interface DirPruneResult {
  dir: string;
  plan: PrunePlan;
}

// Lists the .json artifacts of one directory as prune candidates. A missing
// directory is an empty candidate set — nothing to prune is not an error.
function listCandidates(dir: string): PruneCandidate[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: PruneCandidate[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name, mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      // Raced deletion; skip.
    }
  }
  return out;
}

// Plans (and unless dryRun, performs) the prune over results/ and scores/.
// Deletion failures throw — the CLI boundary maps them to the runtime exit
// code, consistent with every other artifact-IO failure in the eval CLI.
export function prune(
  vault: string,
  rules: PruneRules,
  opts: { dryRun: boolean; nowMs: number },
): DirPruneResult[] {
  const results: DirPruneResult[] = [];
  for (const dir of [resultsDir(vault), scoresDir(vault)]) {
    const plan = planPrune(listCandidates(dir), rules, opts.nowMs);
    if (!opts.dryRun) {
      for (const c of plan.deleted) {
        rmSync(join(dir, c.name));
      }
    }
    results.push({ dir, plan });
  }
  return results;
}
