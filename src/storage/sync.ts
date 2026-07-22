// The sync engine (#6, spec Decision 3): pushes the canonical local working
// copy — markdown tree, .git directory, and durable .daftari state — to a
// storage backend, and can restore a vault from that backing into an empty
// directory.
//
// Key namespace on the backend:
//   tree/<vault-relative-path>   file bytes
//   meta/manifest.json           what the backing currently holds
//
// The manifest (key → sha256) is the remote source of truth for diffing, so
// sync is stateless locally and incremental: only changed/new keys upload,
// removed keys delete. The manifest is written LAST — a crashed sync leaves
// it understating what was pushed, so the next run re-uploads at worst, never
// skips.
//
// What never syncs: the rebuildable SQLite databases (index.db, locks.db and
// their journals), the process lock, and transient per-cycle staging files.
// Durable-but-gitignored audit state (read-log, edges, provenance journals)
// DOES sync — unlike the index it cannot be rebuilt from the markdown.
//
// Concurrency note: sync reads the live tree without taking the process
// lock, so a write racing the walk can capture a torn snapshot (a ref
// updated mid-copy). That snapshot is repaired by the next run — acceptable
// for a backup channel, and the price of syncing while the server serves.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { StorageBackend } from "./backend.js";

export const MANIFEST_KEY = "meta/manifest.json";
const TREE_PREFIX = "tree/";
const CONCURRENCY = 8;

// Rebuildable or transient files that must never reach the backing. Everything
// else under the vault root — including .git and the durable .daftari
// journals — is part of the backup.
const SYNC_EXCLUDED = new Set([
  ".daftari/process.lock",
  ".daftari/index.db",
  ".daftari/index.db-journal",
  ".daftari/index.db-wal",
  ".daftari/index.db-shm",
  ".daftari/locks.db",
  ".daftari/locks.db-journal",
  ".daftari/locks.db-wal",
  ".daftari/locks.db-shm",
  ".daftari/backfill-plan.jsonl",
  ".daftari/wake-queue.jsonl",
  // Its own header calls it "ephemeral cross-session memory … rebuildable:
  // absent OR corrupt ⇒ the empty default" — same class as the wake queue.
  ".daftari/consolidate-state.json",
]);

function isExcluded(relPath: string): boolean {
  if (SYNC_EXCLUDED.has(relPath)) return true;
  // Git EXECUTES what these declare — filter/fsmonitor command lines in
  // config, hook scripts in hooks/ — and a `git clone` deliberately never
  // transmits them from a remote for exactly that reason. Carrying them
  // through the backing would turn backend write access into code execution
  // on the operator's next auto-commit, so they are excluded in BOTH
  // directions; the restore side re-enforces this against a poisoned
  // manifest. After a restore, remotes and local config are re-added by the
  // operator.
  if (relPath === ".git/config" || relPath.startsWith(".git/hooks/")) return true;
  // Defensive: a vault should never contain one, but never ship it if it does.
  return relPath.split("/").includes("node_modules");
}

export interface SyncManifest {
  version: 1;
  // vault-relative path → sha256 hex of the file bytes
  files: Record<string, string>;
}

export interface SyncSummary {
  uploaded: number;
  deleted: number;
  unchanged: number;
  skippedSymlinks: number;
  bytesUploaded: number;
}

interface LocalFile {
  relPath: string;
  absPath: string;
  hash: string;
  size: number;
}

// Recursive file walk with explicit per-directory readdir rather than
// readdir({recursive}) + Dirent.parentPath — parentPath only exists from
// Node 20.12, and engines declares >=20. Symlinks are reported, not
// followed.
export async function walkFiles(dir: string): Promise<{ files: string[]; symlinks: number }> {
  const files: string[] = [];
  let symlinks = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      symlinks++;
    } else if (entry.isDirectory()) {
      const sub = await walkFiles(abs);
      files.push(...sub.files);
      symlinks += sub.symlinks;
    } else if (entry.isFile()) {
      files.push(abs);
    }
  }
  return { files, symlinks };
}

// Streaming hash so the walk phase never buffers a whole file — .git is in
// scope now, and packfiles can dwarf the markdown they version.
function hashFile(abs: string): Promise<{ hash: string; size: number }> {
  return new Promise((resolveHash, rejectHash) => {
    const digest = createHash("sha256");
    let size = 0;
    const stream = createReadStream(abs);
    stream.on("data", (chunk) => {
      digest.update(chunk);
      size += chunk.length;
    });
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash({ hash: digest.digest("hex"), size }));
  });
}

// Walks the vault tree (dotfiles included — .git is the point), hashing every
// non-excluded regular file. Symlinks are skipped and counted: an object
// store has no symlink notion, and following one could escape the vault.
async function collectLocalState(
  vaultRoot: string,
): Promise<Result<{ files: LocalFile[]; skippedSymlinks: number }, Error>> {
  const root = resolve(vaultRoot);
  try {
    const walked = await walkFiles(root);
    const candidates = walked.files
      .map((abs) => ({ abs, rel: relative(root, abs).split(sep).join("/") }))
      .filter((c) => !isExcluded(c.rel));
    // Hash with the same bounded pool the upload phase uses — the walk now
    // covers .git, and serializing on disk I/O for packfiles wastes time.
    const files: LocalFile[] = new Array(candidates.length);
    const hashed = await runPool(
      candidates.map((c, i) => async (): Promise<Result<void, Error>> => {
        try {
          const { hash, size } = await hashFile(c.abs);
          files[i] = { relPath: c.rel, absPath: c.abs, hash, size };
          return ok(undefined);
        } catch (e) {
          return err(
            new Error(`cannot hash ${c.rel}: ${e instanceof Error ? e.message : String(e)}`),
          );
        }
      }),
    );
    if (!hashed.ok) return hashed;
    return ok({ files, skippedSymlinks: walked.symlinks });
  } catch (e) {
    return err(new Error(`cannot walk vault: ${e instanceof Error ? e.message : String(e)}`));
  }
}

async function readManifest(backend: StorageBackend): Promise<Result<SyncManifest, Error>> {
  const raw = await backend.get(MANIFEST_KEY);
  if (!raw.ok) return raw;
  if (raw.value === null) return ok({ version: 1, files: {} });
  try {
    const parsed = JSON.parse(raw.value.toString("utf-8")) as SyncManifest;
    if (parsed.version !== 1 || typeof parsed.files !== "object" || parsed.files === null) {
      return err(new Error(`backing manifest at ${MANIFEST_KEY} has an unknown shape`));
    }
    // Null prototype so a file literally named __proto__ (possible in a git
    // object dir? no — but in the tree, yes) round-trips as an own key.
    const files: Record<string, string> = Object.create(null);
    for (const [k, v] of Object.entries(parsed.files)) {
      if (typeof v === "string") files[k] = v;
    }
    return ok({ version: 1, files });
  } catch (e) {
    return err(
      new Error(
        `backing manifest is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}

// Runs `tasks` with a bounded worker pool, stopping at the first error.
async function runPool(
  tasks: (() => Promise<Result<void, Error>>)[],
): Promise<Result<void, Error>> {
  let index = 0;
  let failure: Error | null = null;
  async function worker(): Promise<void> {
    while (failure === null) {
      const i = index++;
      const task = tasks[i];
      if (!task) return;
      const res = await task();
      if (!res.ok && failure === null) failure = res.error;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));
  return failure ? err(failure) : ok(undefined);
}

export interface SyncOptions {
  dryRun?: boolean;
}

// Push the working copy to the backend. Incremental against the remote
// manifest; writes the updated manifest last.
export async function syncVault(
  vaultRoot: string,
  backend: StorageBackend,
  options: SyncOptions = {},
): Promise<Result<SyncSummary, Error>> {
  const local = await collectLocalState(vaultRoot);
  if (!local.ok) return local;
  const manifest = await readManifest(backend);
  if (!manifest.ok) return manifest;

  const remote = manifest.value.files;
  const localByPath = new Map(local.value.files.map((f) => [f.relPath, f]));

  const toUpload = local.value.files.filter((f) => remote[f.relPath] !== f.hash);
  const toDelete = Object.keys(remote).filter((relPath) => !localByPath.has(relPath));
  const unchanged = local.value.files.length - toUpload.length;

  const summary: SyncSummary = {
    uploaded: toUpload.length,
    deleted: toDelete.length,
    unchanged,
    skippedSymlinks: local.value.skippedSymlinks,
    bytesUploaded: toUpload.reduce((n, f) => n + f.size, 0),
  };
  if (options.dryRun) return ok(summary);

  const uploads = toUpload.map((f) => async (): Promise<Result<void, Error>> => {
    // Re-read at upload time: the hash was computed during the walk and the
    // manifest must describe the bytes actually pushed, so hash what we send.
    let bytes: Buffer;
    try {
      bytes = await readFile(f.absPath);
    } catch (e) {
      return err(
        new Error(`cannot read ${f.relPath}: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    f.hash = createHash("sha256").update(bytes).digest("hex");
    f.size = bytes.byteLength;
    return backend.put(TREE_PREFIX + f.relPath, bytes);
  });
  const uploaded = await runPool(uploads);
  if (!uploaded.ok) return uploaded;

  const deletes = toDelete.map((relPath) => () => backend.delete(TREE_PREFIX + relPath));
  const deleted = await runPool(deletes);
  if (!deleted.ok) return deleted;

  const nextManifest: SyncManifest = { version: 1, files: {} };
  const nextFiles: Record<string, string> = Object.create(null);
  for (const f of local.value.files) nextFiles[f.relPath] = f.hash;
  nextManifest.files = nextFiles;
  const wrote = await backend.put(
    MANIFEST_KEY,
    Buffer.from(JSON.stringify(nextManifest, null, 2), "utf-8"),
  );
  if (!wrote.ok) return wrote;

  return ok(summary);
}

export interface RestoreSummary {
  restored: number;
  bytes: number;
  // Manifest entries refused by the exclusion rules (git config/hooks, the
  // rebuildable databases) — nonzero only for a backing written by something
  // other than this sync engine, so surface it to the operator.
  skippedExcluded: number;
}

// Restore a vault from the backing into `vaultRoot`, which must be empty or
// absent — restore never merges into or overwrites live state. After a
// restore the caller reindexes (the index was deliberately never synced).
export async function restoreVault(
  vaultRoot: string,
  backend: StorageBackend,
): Promise<Result<RestoreSummary, Error>> {
  const root = resolve(vaultRoot);
  try {
    const existing = await readdir(root);
    if (existing.length > 0) {
      return err(new Error(`refusing to restore into non-empty directory: ${root}`));
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      return err(
        new Error(`cannot inspect ${root}: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  const manifest = await readManifest(backend);
  if (!manifest.ok) return manifest;
  // The manifest is data from the backing, not trusted input: re-apply the
  // exclusion rules here so a poisoned manifest cannot smuggle in what push
  // would never have uploaded (git config/hooks — code execution on the
  // next auto-commit).
  const allPaths = Object.keys(manifest.value.files);
  const paths = allPaths.filter((p) => !isExcluded(p));
  const skippedExcluded = allPaths.length - paths.length;
  if (allPaths.length === 0) {
    return err(new Error(`backing at ${backend.id} holds no manifest — nothing to restore`));
  }

  let bytesTotal = 0;
  const tasks = paths.map((relPath) => async (): Promise<Result<void, Error>> => {
    // Confine each manifest path to the restore root — the manifest is data
    // from the backing, not trusted input.
    const target = resolve(root, relPath);
    const rel = relative(root, target);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      return err(new Error(`manifest path escapes restore root: ${relPath}`));
    }
    const got = await backend.get(TREE_PREFIX + relPath);
    if (!got.ok) return got;
    if (got.value === null) {
      return err(new Error(`backing is missing ${TREE_PREFIX}${relPath} listed in its manifest`));
    }
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, got.value);
    } catch (e) {
      return err(
        new Error(`cannot write ${relPath}: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
    bytesTotal += got.value.byteLength;
    return ok(undefined);
  });
  const ran = await runPool(tasks);
  if (!ran.ok) return ran;

  return ok({ restored: paths.length, bytes: bytesTotal, skippedExcluded });
}
