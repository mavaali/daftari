// .daftari/consolidate-state.json — the loop's ephemeral cross-session memory:
// the last consolidation commit (the event clock's baseline) and the
// birth-processed doc hashes (so an edited doc re-births, spec §4.0). Git-ignored
// and rebuildable: absent OR corrupt ⇒ the empty default, and the next session
// treats HEAD as its baseline (the nil path, §3.1/§7).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";

export interface ConsolidateState {
  lastConsolidationCommit: string | null;
  // canonical vault-relative doc path → content hash at last birth-processing.
  birthProcessed: Record<string, string>;
}

function emptyState(): ConsolidateState {
  return { lastConsolidationCommit: null, birthProcessed: {} };
}

export function consolidateStatePath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "consolidate-state.json");
}

export function docContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// Absent OR corrupt ⇒ the empty default. The state is ephemeral and rebuildable
// (an empty lastCommit just means the next session uses HEAD as its baseline).
export function readConsolidateState(vaultRoot: string): ConsolidateState {
  const p = consolidateStatePath(vaultRoot);
  if (!existsSync(p)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(p, "utf-8")) as Partial<ConsolidateState>;
    return {
      lastConsolidationCommit: raw.lastConsolidationCommit ?? null,
      birthProcessed: raw.birthProcessed ?? {},
    };
  } catch {
    return emptyState();
  }
}

// Returns a Result rather than throwing (CLAUDE.md house style): a full disk or
// a read-only .daftari is a recoverable degrade — the loop's state is ephemeral,
// so a failed write just means the next session re-baselines, not a crash.
export function writeConsolidateState(
  vaultRoot: string,
  state: ConsolidateState,
): Result<void, Error> {
  if (typeof vaultRoot !== "string" || vaultRoot.trim().length === 0) {
    return err(new Error("writeConsolidateState requires a non-empty vaultRoot"));
  }
  try {
    const p = consolidateStatePath(vaultRoot);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`);
    return ok(undefined);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot write consolidate state: ${reason}`));
  }
}
