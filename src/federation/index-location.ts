// Index-location redirection for federated mounts (#297, spec Decision 3).
//
// A referenced vault's derived index lives in the CANONICAL vault's
// `.daftari/federation/<alias>/` — never under the referenced root, whose
// `.daftari/` is another process's private state (and whose WAL sidecars a
// "read-only" open would create). This module is the single point that
// enforces the invariant: `indexDbPath` consults it, so every existing
// reindex/search/open call site works against a mount root unchanged while
// its SQLite file lands in the canonical tree by construction.
//
// Kept dependency-free (node:path only) so storage/index-db.ts can import it
// without a cycle.

import { resolve } from "node:path";

// Resolved vault root -> directory that holds its index.db. Registered by
// loadMounts for each available mount; empty for a process with no
// federation, where every index stays at `<root>/.daftari`.
const overrides = new Map<string, string>();

export function setIndexDirOverride(vaultRoot: string, indexDir: string): void {
  overrides.set(resolve(vaultRoot), resolve(indexDir));
}

// Test-only hook, cleared alongside the mount registry.
export function clearIndexDirOverrides(): void {
  overrides.clear();
}

// The directory holding `vaultRoot`'s index.db: the registered override for a
// mount root, or the vault's own `.daftari` for everything else.
export function indexDirFor(vaultRoot: string): string {
  return overrides.get(resolve(vaultRoot)) ?? resolve(vaultRoot, ".daftari");
}
