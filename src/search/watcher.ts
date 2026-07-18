// fs.watch reactive indexing.
//
// Daftari's startup freshness check (search/reindex.ts isIndexFresh) keeps
// the index honest across *restarts*: a manifest of path→mtime is compared
// to disk and a full reindex runs when anything has drifted. But while the
// server is up, an editor save, a sync engine pull, or a scripted writer
// will rewrite a vault file *out of band* — Daftari's write-path tools are
// not the only writer. Without a watcher the index drifts until the next
// startup. The watcher closes that gap: chokidar listens on the vault root,
// and `add` / `change` events trigger an indexDocument() pass for that one
// file; `unlink` events evict the doc from the index after a re-stat
// confirms the file really is gone (FSEvents on macOS, iCloud, and Dropbox
// emit phantom unlink+add pairs during atomic-rename saves).
//
// Per-path debounce: editors save in bursts (atomic rename: write tmp,
// rename, delete tmp), so a single user save can produce 3-5 chokidar
// events for the same path inside a few ms. We collect events into a Map
// keyed by relative path; each touch resets a 500ms timer; when the timer
// fires we run the indexer once. Different paths debounce independently.
//
// Self-write suppression: when the write-path tools (vault_write etc.)
// finish, they note the absolute path in search/self-write.ts. The watcher
// consults that set when its debounce fires and silently drops the event if
// the path is registered, so the in-process indexDocument() the writer
// already ran is not duplicated.
//
// Errors from chokidar are logged to stderr but never crash the server.
// stderr is used throughout so the MCP stdio JSON-RPC stream on stdout
// stays clean.

import type { Stats } from "node:fs";
import { stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { default as chokidar, type FSWatcher } from "chokidar";
import { ok, type Result } from "../frontmatter/types.js";
import { deleteDocument, openIndexDb } from "../storage/index-db.js";
import { resolveVaultPath } from "../storage/local.js";
import { getIndexStatus, markPathIndexing, markPathReady, onceIndexReady } from "./index-state.js";
import { indexDocument } from "./reindex.js";
import { consumeSelfWrite } from "./self-write.js";
import { getProvider } from "./vector.js";

// 500ms is the floor the design locks in: short enough for the index to feel
// live to a human typing in their editor, long enough to coalesce an
// atomic-rename burst (write tmp, rename onto target, delete tmp) into a
// single indexer call.
export const WATCH_DEBOUNCE_MS = 500;

export interface VaultWatcher {
  // Closes the underlying chokidar watcher and clears any pending debounce
  // timers. Idempotent — calling close() on an already-closed watcher is a
  // no-op. Returns when chokidar has fully released its handles.
  close: () => Promise<void>;
}

export interface WatcherOptions {
  // Logger sink for diagnostics. Defaults to process.stderr.write so
  // operator output matches the rest of the server. Tests pass a buffer.
  log?: (msg: string) => void;
  // Override the debounce window. Tests use a smaller value so the suite
  // doesn't sleep for full seconds; production should leave the default.
  debounceMs?: number;
  // Injected indexer / deleter / re-stat hooks. Tests use these to spy on
  // calls without spinning up the real embedding model. Default to the
  // production implementations.
  indexFn?: (vaultRoot: string, relPath: string) => Promise<Result<unknown, Error>>;
  deleteFn?: (vaultRoot: string, relPath: string) => Promise<Result<unknown, Error>>;
  statFn?: (absPath: string) => Promise<{ exists: boolean }>;
  // Test seam: lets tests inject a fake watcher so they can drive `add` /
  // `change` / `unlink` events synchronously. Default uses chokidar.
  watcherFactory?: (vaultRoot: string) => FSWatcher;
}

// Defaults so production callers only need to pass vaultRoot. Pulled out so
// the option-resolution at the top of startWatcher reads as one block.
function resolveOptions(opts: WatcherOptions): Required<Omit<WatcherOptions, "watcherFactory">> & {
  watcherFactory?: (vaultRoot: string) => FSWatcher;
} {
  return {
    log: opts.log ?? ((msg) => process.stderr.write(msg)),
    debounceMs: opts.debounceMs ?? WATCH_DEBOUNCE_MS,
    indexFn: opts.indexFn ?? indexDocument,
    deleteFn: opts.deleteFn ?? defaultDeleteFn,
    statFn: opts.statFn ?? defaultStatFn,
    watcherFactory: opts.watcherFactory,
  };
}

// Default unlink handler: open the index db, drop the document and its
// chunks, and patch the manifest so the next startup freshness check does
// not see a missing-on-disk entry as drift. The embeddings cache is left
// alone (content-addressed; reaped by the next full reindex's gc pass).
async function defaultDeleteFn(
  vaultRoot: string,
  relPath: string,
): Promise<Result<unknown, Error>> {
  const dbResult = openIndexDb(vaultRoot, getProvider().dim);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;
  try {
    deleteDocument(db, relPath);
    // Patch the manifest in place. Reusing reindex.ts internals would
    // require an export churn for one use; the meta row is a JSON blob
    // and a short read-modify-write under WAL is safe here.
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get("vault_manifest") as
      | { value: string }
      | undefined;
    if (row) {
      try {
        const manifest = JSON.parse(row.value) as Record<string, number>;
        if (relPath in manifest) {
          delete manifest[relPath];
          db.prepare(
            "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          ).run("vault_manifest", JSON.stringify(manifest));
        }
      } catch {
        // A malformed manifest is non-fatal here — the next full reindex
        // rewrites it from scratch.
      }
    }
    return ok(undefined);
  } finally {
    db.close();
  }
}

async function defaultStatFn(absPath: string): Promise<{ exists: boolean }> {
  try {
    await stat(absPath);
    return { exists: true };
  } catch {
    return { exists: false };
  }
}

// Extracts an `invalidFrontmatter` reason string from an indexer result, if
// present. The injected `indexFn` is typed against `unknown`, so we narrow
// defensively: a test fake returning `ok(undefined)` yields null (no warning),
// while the real indexDocument returns an IndexDocumentResult carrying the
// reason an out-of-band write was coerced.
function indexedInvalidReason(value: unknown): string | null {
  if (value && typeof value === "object" && "invalidFrontmatter" in value) {
    const reason = (value as { invalidFrontmatter: unknown }).invalidFrontmatter;
    return typeof reason === "string" ? reason : null;
  }
  return null;
}

// Maps a chokidar-emitted absolute path back to the vault-relative POSIX
// path indexDocument / deleteDocument expect. Returns null when the path is
// outside the vault, which can happen with symlinks chokidar followed.
function toVaultRelative(vaultRoot: string, absPath: string): string | null {
  const root = resolve(vaultRoot);
  const abs = resolve(absPath);
  const rel = relative(root, abs);
  if (rel.length === 0) return null;
  if (rel.startsWith("..")) return null;
  // chokidar emits OS-native separators; index storage uses POSIX. Normalise.
  return sep === "/" ? rel : rel.split(sep).join("/");
}

// Returns true when chokidar's path points inside a directory we want to
// ignore (the .daftari control dir, .git, any other hidden top-level path).
// chokidar's `ignored` option already excludes these at watch time, but we
// double-check at dispatch time because chokidar sometimes ignores its own
// `ignored` pattern for `unlinkDir` events on macOS.
function isIgnoredPath(relPath: string): boolean {
  // Anything inside .daftari/ is the index itself or a lock file. Watching
  // it would feed our own writes back as events.
  if (relPath.startsWith(".daftari/") || relPath === ".daftari") return true;
  // .git/ — same problem, plus we don't index git internals.
  if (relPath.startsWith(".git/") || relPath === ".git") return true;
  // Other hidden top-level paths (editor swap files, etc).
  const first = relPath.split("/")[0] ?? "";
  if (first.startsWith(".") && first !== ".") return true;
  return false;
}

// Markdown-only: chokidar watches every file under the root, but only .md
// files are indexed. Skipping non-markdown here keeps random sibling files
// (LICENSE, CHANGELOG.md aside — .md, that counts — images, .DS_Store) from
// firing redundant debounces and indexer calls.
function isMarkdown(relPath: string): boolean {
  return relPath.toLowerCase().endsWith(".md");
}

// The chokidar `ignored` predicate (#107): control dirs are always skipped,
// and non-markdown FILES are skipped at WATCH time so colocated assets
// (images, PDFs, data files) never consume inotify/FSEvents handles. Only a
// path chokidar has STATTED as a file is extension-checked — a directory
// must stay watchable for nested .md discovery, and any extension heuristic
// misreads a dotted directory like `my.notes`. A stats-less call therefore
// falls through to watching; the dispatch-time isMarkdown check still
// discards those events. Exported for tests — the predicate only runs
// inside a real chokidar instance otherwise.
export function watchIgnored(root: string, p: string, stats?: Stats): boolean {
  // The root itself must NOT be ignored.
  if (p === root) return false;
  const rel = toVaultRelative(root, p);
  if (rel === null) return false;
  if (isIgnoredPath(rel)) return true;
  return stats?.isFile() === true && !isMarkdown(rel);
}

// Starts watching `vaultRoot`. Returns a handle whose close() shuts the
// watcher down. The caller is responsible for honouring the `watch` config
// flag — startWatcher itself does not consult config, so tests can drive it
// without a config file.
export function startWatcher(vaultRoot: string, opts: WatcherOptions = {}): VaultWatcher {
  const resolved = resolveOptions(opts);
  const root = resolve(vaultRoot);

  // Per-path debounce timers. The map key is the vault-relative path; the
  // value is { timer, lastEvent }. lastEvent is the most recent chokidar
  // event for the path, used when the timer fires to decide between an
  // index call (add/change) and an unlink dispatch.
  type PendingEvent = "add" | "change" | "unlink";
  interface Pending {
    timer: ReturnType<typeof setTimeout>;
    lastEvent: PendingEvent;
  }
  const pending = new Map<string, Pending>();

  // Events that arrived while a full reindex was running and could not be
  // dispatched immediately (dispatch would race the bulk clearIndex write).
  // Drained as a single batch when markIndexReady/markIndexError fires.
  // Unlike the old busy-poll approach (re-schedule a debounceMs timer until
  // reindex finishes), this accumulates at most one entry per path and fires
  // zero timers per event during a long reindex.
  const deferred = new Map<string, PendingEvent>();
  let drainScheduled = false;

  // Spawn chokidar (or the injected fake). The ignored pattern mirrors
  // listFiles in storage/local.ts so the watcher and listing agree on
  // "what's vault content".
  let watcher: FSWatcher;
  if (resolved.watcherFactory) {
    watcher = resolved.watcherFactory(root);
  } else {
    watcher = chokidar.watch(root, {
      ignored: (p: string, stats?: Stats) => watchIgnored(root, p, stats),
      ignoreInitial: true, // startup freshness check already covers the initial state
      persistent: true,
      followSymlinks: false,
      awaitWriteFinish: false, // we run our own debounce
    });
  }

  let closed = false;

  // Single dispatcher for "the debounce window for `relPath` elapsed — do
  // the work". Pulls the lastEvent so a unlink-then-add inside the window
  // is treated as a change (FSEvents atomic-save quirk).
  async function dispatch(relPath: string, lastEvent: PendingEvent): Promise<void> {
    if (closed) return;

    // Self-write suppression. The write-path tools register the absolute
    // path after their in-process indexDocument() returns; if it's there,
    // the event was Daftari's own write and the index is already current.
    const resolvedAbs = resolveVaultPath(root, relPath);
    if (resolvedAbs.ok && consumeSelfWrite(resolvedAbs.value.absPath)) {
      return;
    }

    // While a full reindex is running, the indexer is rebuilding from
    // scratch — a per-file index call would race the bulk write and may
    // be wiped by clearIndex(). Park the event in `deferred` (no timer) and
    // register a one-shot drain that fires when the reindex settles. At most
    // one timer fires per event per path (when the debounce window elapses),
    // versus the old busy-poll that re-scheduled a new debounceMs timer on
    // every dispatch call until the reindex finished.
    const status = getIndexStatus();
    if (status.status === "indexing") {
      // Cancel any active debounce timer for this path — the deferred map
      // entry will hold the event until drain.
      const existing = pending.get(relPath);
      if (existing) {
        clearTimeout(existing.timer);
        pending.delete(relPath);
      }
      deferred.set(relPath, lastEvent);
      if (!drainScheduled) {
        drainScheduled = true;
        onceIndexReady(() => {
          drainScheduled = false;
          if (closed) {
            deferred.clear();
            return;
          }
          for (const [p, e] of deferred) {
            deferred.delete(p);
            void dispatch(p, e);
          }
        });
      }
      return;
    }

    markPathIndexing(relPath);
    try {
      if (lastEvent === "unlink") {
        // FSEvents (macOS), iCloud, and Dropbox emit phantom unlink+add
        // pairs during atomic-rename saves. Re-stat before deleting: if
        // the file is back, treat the event as a change instead.
        const absResolved = resolveVaultPath(root, relPath);
        if (absResolved.ok) {
          const present = await resolved.statFn(absResolved.value.absPath);
          if (present.exists) {
            const r = await resolved.indexFn(root, relPath);
            if (!r.ok) {
              resolved.log(
                `daftari: watcher: index update failed for ${relPath}: ${r.error.message}\n`,
              );
            } else {
              const reason = indexedInvalidReason(r.value);
              if (reason)
                resolved.log(
                  `daftari: watcher: warning: ${relPath} indexed with ${reason} ` +
                    `(file is the source of truth — run vault_lint to repair)\n`,
                );
            }
            return;
          }
        }
        const d = await resolved.deleteFn(root, relPath);
        if (!d.ok) {
          resolved.log(`daftari: watcher: delete failed for ${relPath}: ${d.error.message}\n`);
        }
        return;
      }

      // add / change — both route to indexDocument.
      const r = await resolved.indexFn(root, relPath);
      if (!r.ok) {
        resolved.log(`daftari: watcher: index update failed for ${relPath}: ${r.error.message}\n`);
      } else {
        const reason = indexedInvalidReason(r.value);
        if (reason)
          resolved.log(
            `daftari: watcher: warning: ${relPath} indexed with ${reason} ` +
              `(file is the source of truth — run vault_lint to repair)\n`,
          );
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      resolved.log(`daftari: watcher: dispatch crashed for ${relPath}: ${reason}\n`);
    } finally {
      markPathReady(relPath);
    }
  }

  // Schedule (or reschedule) the debounce timer for one path. Called for
  // every chokidar event. The most recent event "wins" — an unlink
  // followed by an add inside the window arrives at dispatch() as an add.
  function schedule(relPath: string, event: PendingEvent): void {
    if (closed) return;
    if (isIgnoredPath(relPath)) return;
    if (!isMarkdown(relPath)) return;

    const existing = pending.get(relPath);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      const p = pending.get(relPath);
      if (!p) return;
      pending.delete(relPath);
      void dispatch(relPath, p.lastEvent);
    }, resolved.debounceMs);

    pending.set(relPath, { timer, lastEvent: event });
  }

  // Chokidar's per-event handlers. Each maps a chokidar event to our
  // schedule() call. The `addDir` / `unlinkDir` events are intentionally
  // ignored — per-file events cover everything we care about and a
  // directory delete fires unlink for each contained file anyway.
  watcher.on("add", (p: string) => {
    const rel = toVaultRelative(root, p);
    if (rel) schedule(rel, "add");
  });
  watcher.on("change", (p: string) => {
    const rel = toVaultRelative(root, p);
    if (rel) schedule(rel, "change");
  });
  watcher.on("unlink", (p: string) => {
    const rel = toVaultRelative(root, p);
    if (rel) schedule(rel, "unlink");
  });
  watcher.on("error", (e: unknown) => {
    const reason = e instanceof Error ? e.message : String(e);
    resolved.log(`daftari: watcher error: ${reason}\n`);
  });

  return {
    close: async () => {
      if (closed) return;
      closed = true;
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
      deferred.clear();
      await watcher.close();
    },
  };
}
