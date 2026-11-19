// Governance-journal presence check (ozor). "Git carries your knowledge; a
// Daftari backup carries your governance": the .daftari/ journals are
// gitignored and travel only through `daftari sync`. A `git clone` therefore
// arrives with documents and history but no tensions, proposals, edges or
// provenance — and the ID allocators (nextStagedId, nextTensionId) restart at
// 001, minting IDs that already name different things in the history.
//
// Reserving IDs from history instead was rejected: stage and tension IDs are
// not systematically recorded in commits (an approved stage commits as the
// dispatched tool's message, a tension never commits), so a history scan
// could not be complete. A loud warning on the recovery path is honest.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { lastDaftariWriteCommit } from "../utils/git.js";

// Any one present means the vault carries its governance state. The
// provenance log is written by every write tool, so a vault with Daftari
// write history and none of these has lost them.
const GOVERNANCE_JOURNALS = [
  ".daftari/curation-log.jsonl",
  ".daftari/staged-actions.jsonl",
  ".daftari/tensions.md",
  ".daftari/edges.jsonl",
] as const;

export async function missingGovernanceJournalsWarning(vaultRoot: string): Promise<string | null> {
  if (GOVERNANCE_JOURNALS.some((p) => existsSync(join(vaultRoot, p)))) return null;
  const hash = await lastDaftariWriteCommit(vaultRoot);
  if (hash === null) return null;
  return (
    `governance journals are absent (${GOVERNANCE_JOURNALS.join(", ")}) but git history has ` +
    `Daftari writes (latest ${hash}) — this looks like a git clone. Git carries knowledge, not ` +
    "governance: tensions, pending and rejected proposals, edges and provenance were not carried, " +
    "and new stage-/tension- IDs restart at 001, reusing IDs already named in the history. " +
    "To keep governance state, restore from a Daftari backup (daftari sync --restore)."
  );
}
