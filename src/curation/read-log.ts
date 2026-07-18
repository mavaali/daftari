// Read log — one append-only record per served read, with two consumers:
//
// 1. #233, the input half of the consumes-graph producer: a read carrying a
//    `run_id` joins the run's input set, so a later write by the same run
//    can mint compiled `consumes` edges (reads(run_id) × writes(run_id) —
//    see the 2026-07-17 through-line spec).
// 2. #234, broken-read telemetry: every served read records how many of the
//    document's compiled upstream edges were pending-broken AT SERVE TIME
//    (`broken_upstream`). The broken-read rate — what fraction of reads
//    served known-outdated context — is one scan over this log, which is
//    exactly the acceptance query of #234.
//
// The #233-era run_id GATE is therefore gone: serves are logged whether or
// not the caller passed a run_id (a rate needs its denominator). What
// remains bounded: only SERVED content is logged — a denied or failed read
// never appends — and the counted state is operator telemetry in a local,
// git-ignored file, the same posture as the curation log. `broken_upstream`
// records the TRUE count, unfiltered by the caller's role: the log is not a
// caller-facing surface, and the vault-global aggregate built on it stays
// exact by the same rule that keeps lint aggregates unfiltered.
//
// Same mechanics as the curation log (provenance.ts): append-only JSONL
// under .daftari/, git-ignored, best-effort, corrupt lines skipped on read.

import { mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";

export interface ReadLogEntry {
  timestamp: string; // ISO 8601
  tool: string; // the serving tool, e.g. "vault_read" or "vault_search"
  file: string; // vault-relative path that was served
  // The correlating run, when the caller passed one (#233). Entries without
  // it still count as serves; they just never mint consumes edges.
  run_id?: string;
  // The authenticated identity the server runs as, when present (§11.6).
  principal?: string;
  // #234: compiled upstream edges of this document that were pending-broken
  // when the read was served. Absent on entries that predate the telemetry
  // (or when the classification errored) — consumers must treat absent as
  // uninstrumented, not as zero.
  broken_upstream?: number;
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
    ...(entry.run_id ? { run_id: entry.run_id } : {}),
    ...(entry.principal ? { principal: entry.principal } : {}),
    ...(entry.broken_upstream !== undefined ? { broken_upstream: entry.broken_upstream } : {}),
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
      if (typeof parsed.file === "string" && typeof parsed.timestamp === "string") {
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
