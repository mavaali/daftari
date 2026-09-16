// The run ledger — a persisted, content-light history of what the vault
// metabolized. `daftari sleep` computes a rich cycle result every pass but
// kept none of it; the ledger records one summary record per run so a past
// pass can be inspected (`daftari runs`) and the loop's own liveness is
// legible over time.
//
// Storage mirrors the staged-actions convention: append-only jsonl under
// .daftari/runs.jsonl, one JSON record per line, self-pruning to a cap so it
// cannot grow without bound. Content-light by construction: counts only, never
// document bodies or paths — the wake queue already carries the full task list
// for tonight's agent; this is the metric trail, not a second copy of it.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SleepCycleResult } from "./cycle.js";

// One recorded run. `summary` is intentionally open (Record) so a future dream
// type (e.g. distill, once compile-on-ingest lands) can record its own shape
// without a schema change — the ledger is a metric trail, not a typed API.
export interface RunRecord {
  id: string; // sortable unique id — the run's ISO timestamp
  kind: string; // "circadian" | "tension-scan" | "distill" | ...
  ts: string; // ISO 8601 — when the run completed
  summary: Record<string, unknown>;
}

// Keep the newest N runs. A nightly pass over years is still a small file at
// this cap; older records fall off the front on write.
export const DEFAULT_RUN_LEDGER_CAP = 500;

export function runLedgerPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "runs.jsonl");
}

// Append one record, then prune the file to the newest `cap` lines. Synchronous
// (mirrors staged-actions): a sleep pass holds the vault lock, so there is no
// concurrent writer to race.
export function appendRun(
  vaultRoot: string,
  record: RunRecord,
  cap: number = DEFAULT_RUN_LEDGER_CAP,
): void {
  const path = runLedgerPath(vaultRoot);
  mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);

  // Prune: read back, and if over the cap rewrite with the newest `cap` lines.
  // Cheap at this file size and keeps the ledger bounded (R10). Single-writer
  // file (the pass holds the vault lock), so truncate-and-write is safe.
  const lines = readLines(path);
  if (lines.length > cap) {
    const kept = lines.slice(lines.length - cap);
    writeFileSync(path, `${kept.join("\n")}\n`);
  }
}

// Read raw non-empty lines; returns [] when the file is absent.
function readLines(path: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  return raw.split("\n").filter((l) => l.trim().length > 0);
}

// Parse a line to a RunRecord, or null if malformed / not a run record.
function parseRecord(line: string): RunRecord | null {
  try {
    const obj = JSON.parse(line) as unknown;
    if (
      obj &&
      typeof obj === "object" &&
      typeof (obj as RunRecord).id === "string" &&
      typeof (obj as RunRecord).kind === "string" &&
      typeof (obj as RunRecord).ts === "string"
    ) {
      const r = obj as RunRecord;
      return { id: r.id, kind: r.kind, ts: r.ts, summary: r.summary ?? {} };
    }
  } catch {
    // fall through
  }
  return null;
}

// All recorded runs, newest first. Malformed lines are skipped, never fatal.
export function listRuns(vaultRoot: string, limit?: number): RunRecord[] {
  const records: RunRecord[] = [];
  for (const line of readLines(runLedgerPath(vaultRoot))) {
    const r = parseRecord(line);
    if (r) records.push(r);
  }
  records.reverse(); // file is append-order (oldest first) → newest first
  return typeof limit === "number" ? records.slice(0, limit) : records;
}

// Find a run by exact id, else by id prefix (newest match wins).
export function readRun(vaultRoot: string, id: string): RunRecord | null {
  const runs = listRuns(vaultRoot);
  return runs.find((r) => r.id === id) ?? runs.find((r) => r.id.startsWith(id)) ?? null;
}

// Content-light summary of a circadian cycle: counts only, no document
// identities. This is what lands in the ledger record.
export function summarizeCircadian(cycle: SleepCycleResult): Record<string, unknown> {
  return {
    staleness: cycle.staleness,
    compiledEdgeCoverage: cycle.compiledEdgeCoverage,
    wake: cycle.wake.length,
    decayedQuiet: cycle.decayedQuiet.length,
    generativeStale: cycle.generativeStale,
    tensionsOpen: cycle.tensions.open,
    ratification: {
      pending: cycle.ratification.pending,
      ratified: cycle.ratification.history.ratified,
      rejected: cycle.ratification.history.rejected,
      expired: cycle.ratification.history.expired,
    },
    sweptExpired: cycle.sweptExpired.length,
  };
}

// Build a circadian run record stamped at `now`.
export function makeCircadianRecord(cycle: SleepCycleResult, now: Date = new Date()): RunRecord {
  const ts = now.toISOString();
  return { id: ts, kind: "circadian", ts, summary: summarizeCircadian(cycle) };
}

// --- rendering for the `daftari runs` CLI ------------------------------------

export function renderRunsList(records: RunRecord[]): string {
  if (records.length === 0) return "No runs recorded yet.\n";
  const lines = records.map((r) => {
    const s = r.summary as Record<string, unknown>;
    const wake = typeof s.wake === "number" ? s.wake : "-";
    const tensions = typeof s.tensionsOpen === "number" ? s.tensionsOpen : "-";
    return `${r.id}  ${r.kind.padEnd(13)}  wake=${wake}  tensions_open=${tensions}`;
  });
  return `${lines.join("\n")}\n`;
}

export function renderRunShow(record: RunRecord): string {
  return `Run ${record.id}\n  kind: ${record.kind}\n  at:   ${record.ts}\n\n${JSON.stringify(
    record.summary,
    null,
    2,
  )}\n`;
}
