// Provenance log — an append-only audit trail of every write to the vault.
//
// Each write tool appends one JSON line to .daftari/curation-log.jsonl. The
// log is advisory: it records what happened, who did it, and how the
// frontmatter changed, but it never blocks or alters a write. It is local
// audit state, not vault content — it is git-ignored, not committed.

import { mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Frontmatter } from "../frontmatter/types.js";
import { err, ok, type Result } from "../frontmatter/types.js";

// Per-field before/after, for any frontmatter field that changed in a write.
export type FrontmatterDiff = Record<string, { before: unknown; after: unknown }>;

export interface ProvenanceEntry {
  timestamp: string; // ISO 8601
  tool: string; // the write tool that ran, e.g. "vault_write"
  file: string; // vault-relative path
  agent: string; // acting identity, e.g. "agent:claude-code"
  // "create" | "update" | "append" | "promote" | "deprecate" for a write that
  // landed; "rejected_stale" for a write refused by the base_version check.
  action: string;
  frontmatter_diff?: FrontmatterDiff;
  // Free-text explanation, set on rejected writes (e.g. the stale-version
  // mismatch). Absent on writes that landed.
  reason?: string;
}

export function curationLogPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "curation-log.jsonl");
}

// Diffs two frontmatter blocks, returning only the fields that changed. A
// `before` of null means the document is newly created — every field counts
// as a change from `undefined`.
export function frontmatterDiff(before: Frontmatter | null, after: Frontmatter): FrontmatterDiff {
  const diff: FrontmatterDiff = {};
  const keys = new Set<string>([...(before ? Object.keys(before) : []), ...Object.keys(after)]);
  for (const key of keys) {
    const b = before ? (before as unknown as Record<string, unknown>)[key] : undefined;
    const a = (after as unknown as Record<string, unknown>)[key];
    if (JSON.stringify(b) !== JSON.stringify(a)) {
      diff[key] = { before: b, after: a };
    }
  }
  return diff;
}

// Appends one entry to the curation log. The timestamp is stamped here so
// callers cannot forget it. Creating the .daftari directory is idempotent.
export async function recordProvenance(
  vaultRoot: string,
  entry: Omit<ProvenanceEntry, "timestamp"> & { timestamp?: string },
): Promise<Result<ProvenanceEntry, Error>> {
  const full: ProvenanceEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    tool: entry.tool,
    file: entry.file,
    agent: entry.agent,
    action: entry.action,
    ...(entry.frontmatter_diff && Object.keys(entry.frontmatter_diff).length > 0
      ? { frontmatter_diff: entry.frontmatter_diff }
      : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
  };
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    await appendFile(curationLogPath(vaultRoot), `${JSON.stringify(full)}\n`);
    return ok(full);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot append to curation log: ${reason}`));
  }
}

// Reads the curation log back, oldest entry first. A missing log is not an
// error — it just means nothing has been written yet. Malformed lines are
// skipped rather than aborting the read.
export async function readProvenanceLog(
  vaultRoot: string,
): Promise<Result<ProvenanceEntry[], Error>> {
  let raw: string;
  try {
    raw = await readFile(curationLogPath(vaultRoot), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read curation log: ${reason}`));
  }
  const entries: ProvenanceEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as ProvenanceEntry);
    } catch {
      // skip a corrupt line; the log is append-only and best-effort.
    }
  }
  return ok(entries);
}
