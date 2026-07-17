// Read log (#233) — the input half of the consumes-graph producer.
//
// When a read tool is called WITH a `run_id`, the read is recorded here so
// that a later write by the same run can mint compiled `consumes` edges:
// whatever the run read before writing artifact X is X's input set
// (reads(run_id) × writes(run_id) — see the 2026-07-17 through-line spec).
//
// Deliberately run_id-gated: a read without a run id is not recorded at all.
// This is provenance instrumentation for runs that opt in, not ambient read
// surveillance — volume stays bounded by instrumented traffic, and
// uninstrumented callers pay zero I/O.
//
// Same posture as the curation log (provenance.ts): append-only JSONL under
// .daftari/, git-ignored, best-effort, corrupt lines skipped on read. Local
// audit state, not vault content.

import { mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";

export interface ReadLogEntry {
  timestamp: string; // ISO 8601
  tool: string; // the read tool that ran, e.g. "vault_read"
  file: string; // vault-relative path that was read
  run_id: string; // the correlating run — always present (gate condition)
  // The authenticated identity the server runs as, when present (§11.6).
  principal?: string;
}

export function readLogPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "read-log.jsonl");
}

// Appends one read record. Timestamp is stamped here so callers cannot forget
// it. Best-effort like the curation log — the caller decides whether a
// failure matters (the read tools treat it as advisory).
export async function recordRead(
  vaultRoot: string,
  entry: Omit<ReadLogEntry, "timestamp"> & { timestamp?: string },
): Promise<Result<ReadLogEntry, Error>> {
  const full: ReadLogEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    tool: entry.tool,
    file: entry.file,
    run_id: entry.run_id,
    ...(entry.principal ? { principal: entry.principal } : {}),
  };
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    await appendFile(readLogPath(vaultRoot), `${JSON.stringify(full)}\n`);
    return ok(full);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot append to read log: ${reason}`));
  }
}

// Reads the log back, oldest first. A missing log is not an error; malformed
// lines are skipped.
export async function readReadLog(vaultRoot: string): Promise<Result<ReadLogEntry[], Error>> {
  let raw: string;
  try {
    raw = await readFile(readLogPath(vaultRoot), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read read log: ${reason}`));
  }
  const entries: ReadLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ReadLogEntry;
      if (typeof parsed.file === "string" && typeof parsed.run_id === "string") {
        entries.push(parsed);
      }
    } catch {
      // Skip a corrupt line; the log is append-only and best-effort.
    }
  }
  return ok(entries);
}

// The unique paths a run read, in first-read order.
export function readsForRun(entries: ReadLogEntry[], runId: string): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const e of entries) {
    if (e.run_id !== runId || seen.has(e.file)) continue;
    seen.add(e.file);
    paths.push(e.file);
  }
  return paths;
}
