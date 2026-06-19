// Shared .gitignore scaffolding for Daftari vaults.
//
// Both `daftari --init` (scaffolding a fresh vault) and `daftari import`
// (adopting a foreign vault in place) need the same set of ignore rules so the
// ephemeral .daftari/ index/lock/log files never leak into the user's repo. The
// constant and the idempotent ensure-helper live here so the two entry points
// stay DRY.

import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const VAULT_GITIGNORE = `# Daftari rebuilds these from the markdown files — never commit them.
.daftari/index.db
.daftari/index.db-journal
.daftari/index.db-wal
.daftari/index.db-shm
.daftari/locks.db
.daftari/locks.db-journal
.daftari/locks.db-wal
.daftari/locks.db-shm
# Local audit state — advisory, not vault content. Matters most when a vault
# runs with auto_commit: false inside a larger repo: keeps the host repo's
# git status clean of Daftari's per-write log churn.
.daftari/curation-log.jsonl
.daftari/staged-actions.jsonl
.daftari/edges.jsonl
.daftari/shadow-actions.jsonl
.daftari/consolidate-state.json
# Transient backfill staging surface (daftari backfill --plan). The apply
# commit is the durable audit trail — the plan itself is never committed.
.daftari/backfill-plan.jsonl
`;

// A stable line guaranteed to appear in VAULT_GITIGNORE; used as the marker to
// detect whether an existing .gitignore already carries the Daftari block.
const MARKER = ".daftari/index.db";

// Ensures the vault's .gitignore carries the Daftari ignore block. Idempotent:
//   "created"  — no .gitignore existed; wrote VAULT_GITIGNORE.
//   "appended" — a .gitignore existed without the block; appended it.
//   "present"  — the block was already there; left the file untouched.
export async function ensureVaultGitignore(
  vaultRoot: string,
): Promise<"created" | "appended" | "present"> {
  const path = join(vaultRoot, ".gitignore");

  let existing: string | null = null;
  try {
    existing = await readFile(path, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      await writeFile(path, VAULT_GITIGNORE);
      return "created";
    }
    throw e;
  }

  if (existing.includes(MARKER)) return "present";

  // Separate the user's content from our block so it doesn't glue onto their
  // last line. A leading "\n" guarantees a clean break whether or not the file
  // ends in a newline.
  await appendFile(path, "\n" + VAULT_GITIGNORE);
  return "appended";
}
