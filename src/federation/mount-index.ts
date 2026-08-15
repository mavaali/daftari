// Per-mount index lifecycle (#297, spec Decisions 3 and 6).
//
// Each available mount gets its own derived index — built from the mount's
// markdown with the canonical process's OWN embedding provider, stored under
// the canonical `.daftari/federation/<alias>/` via the index-location
// redirect. Freshness is startup-only: the manifest-vs-disk check runs once
// per mount at boot (and lazily before a first federated search), and after
// that the index refreshes only through an explicit vault_reindex — no
// watchers on mounts.

import { err, ok, type Result } from "../frontmatter/types.js";
import type { ReindexOptions, ReindexResult } from "../search/reindex.js";
import { isIndexFresh, reindexVault } from "../search/reindex.js";
import type { LoadedMount } from "./mounts.js";

// The reindex posture every mount build shares: never ingest the referenced
// vault's `.daftari` state, and skip embeddings for `index: lexical` mounts.
export function mountReindexOptions(mount: LoadedMount): ReindexOptions {
  return {
    skipVaultState: true,
    ...(mount.indexMode === "lexical" ? { lexicalOnly: true } : {}),
  };
}

// Rebuilds one mount's index unconditionally (the vault_reindex {vault} path).
export async function reindexMount(mount: LoadedMount): Promise<Result<ReindexResult, Error>> {
  if (mount.root === null) {
    return err(new Error(`mount "${mount.alias}" is unavailable — its path was not found`));
  }
  return reindexVault(mount.root, mountReindexOptions(mount));
}

// Brings one mount's index up to date if the manifest-vs-disk check says it
// drifted; a fresh index is a no-op. Used at startup and as the lazy gate
// before a federated search touches the mount.
export async function ensureMountIndexFresh(
  mount: LoadedMount,
): Promise<Result<ReindexResult | null, Error>> {
  if (mount.root === null) {
    return err(new Error(`mount "${mount.alias}" is unavailable — its path was not found`));
  }
  if (await isIndexFresh(mount.root)) return ok(null);
  const rebuilt = await reindexVault(mount.root, mountReindexOptions(mount));
  if (!rebuilt.ok) return rebuilt;
  return ok(rebuilt.value);
}

// Startup pass over every available mount, sequential by design: mounts share
// the process's embedding provider, and interleaving two cold embed passes
// buys nothing. Failures are reported per mount and never fail the pass —
// a mount whose index cannot build degrades that mount's search, not the
// server (the search path retries via ensureMountIndexFresh).
export async function buildMountIndexes(
  mounts: Iterable<LoadedMount>,
  notice: (line: string) => void,
): Promise<void> {
  for (const mount of mounts) {
    if (mount.root === null) continue;
    const result = await ensureMountIndexFresh(mount);
    if (!result.ok) {
      notice(`mount "${mount.alias}": index build failed: ${result.error.message}`);
    } else if (result.value !== null) {
      notice(
        `mount "${mount.alias}": indexed ${result.value.documentCount} docs, ` +
          `${result.value.chunkCount} chunks (vectors ${result.value.vectorEnabled ? "on" : "off"})`,
      );
    } else {
      notice(`mount "${mount.alias}": index is up to date`);
    }
  }
}
