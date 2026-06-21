// Daftari MCP server entry point.
//
// Parses `--vault <path>`, verifies the vault directory exists, loads the RBAC
// config, opens the MCP stdio transport, then — if the index isn't already
// current — runs a reindex in the background. Diagnostics go to stderr so they
// never corrupt the stdio JSON-RPC stream on stdout.
//
// The transport opens before indexing on purpose: a cold reindex on a large
// vault is minutes long, and a client must be able to answer `initialize` and
// list tools immediately. Tools that depend on the index consult
// `getIndexStatus()` and reply "still indexing — N/M chunks" until the
// background pass finishes.
//
// `--reindex` is the one synchronous mode: rebuild the index, exit, do not
// start the server.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GUEST_ROLE, resolveAccess } from "./access/rbac.js";
import { materializeEdges } from "./curation/edges.js";
import { materializeStagedActions } from "./curation/staged-actions.js";
import { acquireLock, releaseLock } from "./lifecycle/lock.js";
import {
  markIndexError,
  markIndexing,
  markIndexReady,
  setIndexProgress,
} from "./search/index-state.js";
import {
  isIndexFresh,
  type ReindexOptions,
  reindexVault,
  reindexWarnings,
} from "./search/reindex.js";
import { setProvider, warmModel } from "./search/vector.js";
import { startWatcher, type VaultWatcher } from "./search/watcher.js";
import { createServer } from "./server.js";
import { directoryExists } from "./storage/local.js";
import { loadConfig } from "./utils/config.js";

// Kept in sync with package.json. Surfaced in the process lockfile for
// operator diagnostics. Bump both together on a release.
const DAFTARI_VERSION = "1.26.0";

// Reads `--name value` or `--name=value` from argv; null if absent.
export function parseFlag(argv: string[], name: string): string | null {
  const flag = `--${name}`;
  const flagIndex = argv.indexOf(flag);
  if (flagIndex !== -1 && flagIndex + 1 < argv.length) {
    return argv[flagIndex + 1] ?? null;
  }
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  if (inline) return inline.slice(`${flag}=`.length);
  return null;
}

export function parseVaultArg(argv: string[]): string | null {
  return parseFlag(argv, "vault");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const vaultArg = parseVaultArg(argv);
  if (!vaultArg) {
    process.stderr.write("daftari: missing required --vault <path> argument\n");
    process.exitCode = 1;
    return;
  }

  const vaultRoot = resolve(vaultArg);
  if (!(await directoryExists(vaultRoot))) {
    process.stderr.write(`daftari: vault directory not found: ${vaultRoot}\n`);
    process.exitCode = 1;
    return;
  }

  // Acquire the per-vault process lock BEFORE any heavy work. If another
  // daftari is holding this vault, SIGTERM it and wait briefly for it to
  // exit. See docs/superpowers/plans/2026-05-20-process-lockfile.md (#52).
  const lockResult = await acquireLock(vaultRoot, DAFTARI_VERSION);
  if (!lockResult.ok) {
    process.stderr.write(`daftari: failed to acquire vault lock: ${lockResult.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  // Install shutdown handlers immediately so the lock is released even if
  // startup fails between here and the transport opening.
  installShutdownHandlers(vaultRoot);

  // Load the RBAC config. A malformed config fails loud: the server must not
  // start serving content under a policy it could not parse.
  const config = loadConfig(vaultRoot);
  if (!config.ok) {
    process.stderr.write(`daftari: ${config.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  // Install the configured embedding provider. loadConfig has already
  // validated the id and (for openai-3-small) the OPENAI_API_KEY env var,
  // so setProvider should never throw here — but if it does (race-y env
  // var stripping by a wrapper, say), fail loud rather than serving with
  // a broken provider.
  try {
    setProvider(config.value.embeddingProvider);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`daftari: ${reason}\n`);
    process.exitCode = 1;
    return;
  }

  // Resolve the access identity. With no --role the server runs as the
  // deny-all guest; an unknown role name resolves the same way.
  const user = parseFlag(argv, "user") ?? "guest";
  const roleName = parseFlag(argv, "role") ?? GUEST_ROLE;
  const access = resolveAccess(config.value, user, roleName);
  if (access.role === null && roleName !== GUEST_ROLE) {
    process.stderr.write(
      `daftari: warning: role '${roleName}' not found in config — running as deny-all guest\n`,
    );
  }

  // The persisted index is a derived cache: if every file on disk matches the
  // manifest written by the last reindex, the on-disk index already reflects
  // the vault and we can skip the embedding pass entirely (~25 min on a
  // multi-thousand-file vault). --reindex forces a rebuild even when fresh.
  const forceReindex = argv.includes("--reindex");

  // --reindex is the one synchronous mode: rebuild and exit. No transport,
  // no background work. The IndexState is updated for completeness but no
  // tool runs against it in this mode.
  if (forceReindex) {
    markIndexing();
    const reindexed = await reindexVault(vaultRoot, makeProgressReporter());
    if (reindexed.ok) {
      const r = reindexed.value;
      markIndexReady();
      process.stderr.write(
        `daftari: indexed ${r.documentCount} docs, ${r.chunkCount} chunks ` +
          `(vectors ${r.vectorEnabled ? "on" : "off"})\n`,
      );
      for (const line of reindexWarnings(r)) process.stderr.write(`daftari: warning: ${line}\n`);
    } else {
      markIndexError(reindexed.error.message);
      process.stderr.write(`daftari: warning: index build failed: ${reindexed.error.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // Open MCP transport first so the client can answer `initialize` and
  // `tools/list` immediately. Indexing — if needed — runs as a background
  // task; tools that depend on the index will respond "still indexing" until
  // it completes.
  const server = createServer(vaultRoot, access);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `daftari: serving vault at ${vaultRoot} (stdio) — ` +
      `user=${access.user} role=${access.roleName}\n`,
  );

  const fresh = await isIndexFresh(vaultRoot);
  if (fresh) {
    process.stderr.write(`daftari: index is up to date — skipping reindex\n`);
    markIndexReady();
    // A fresh index skips the reindex that would otherwise rebuild the
    // staged-actions table from its jsonl, so do that one cheap step here:
    // the queue may have grown since the last reindex without any file
    // changing. Best-effort — the jsonl is the source of truth, and v1 read
    // paths use it directly — so a failure is logged, not fatal.
    const materialized = materializeStagedActions(vaultRoot);
    if (!materialized.ok) {
      process.stderr.write(
        `daftari: warning: could not rebuild staged-actions index: ${materialized.error.message}\n`,
      );
    }
    // Same for the derives_from edge store (spec §11.3): edges may have been
    // observed since the last reindex without any file changing.
    const edgesMaterialized = materializeEdges(vaultRoot);
    if (!edgesMaterialized.ok) {
      process.stderr.write(
        `daftari: warning: could not rebuild derives_from index: ${edgesMaterialized.error.message}\n`,
      );
    }
    // Fresh index means a fully-cached state: no embedding work was done, so
    // the model is still cold. Warm it in the background (if config allows)
    // so the first user search does not pay the ~500ms cold start. Then
    // start the watcher to catch out-of-band edits going forward.
    if (config.value.warmEmbeddings) {
      void runBackgroundWarm();
    }
    maybeStartWatcher(vaultRoot, config.value.watch);
    return;
  }

  // Background reindex. The promise is intentionally not awaited — main()
  // returns once the transport is up, and the indexing pass runs to
  // completion alongside the live server.
  markIndexing();
  process.stderr.write(`daftari: starting background reindex…\n`);
  void runBackgroundReindex(vaultRoot, config.value.warmEmbeddings, () => {
    maybeStartWatcher(vaultRoot, config.value.watch);
  });
}

// Reference held so a SIGTERM / SIGINT can close the watcher cleanly. One
// per process — the server runs against one vault for its lifetime.
let activeWatcher: VaultWatcher | null = null;

// Install once, regardless of whether the watcher starts. The lock release
// must run for all exit paths:
//   - SIGTERM / SIGINT (parent MCP client closing the pipe, or another
//     daftari instance taking over): onShutdown explicitly releases.
//   - Normal completion of --reindex mode: main() returns, the event loop
//     drains, Node emits 'exit', the registered listener releases.
// The 'exit' listener is sync-only (Node guarantees the loop is closed by
// then), which is why releaseLock is sync.
function installShutdownHandlers(vaultRoot: string): void {
  const onShutdown = () => {
    if (activeWatcher) {
      const w = activeWatcher;
      activeWatcher = null;
      void w.close();
    }
    releaseLock(vaultRoot);
  };
  process.once("SIGTERM", onShutdown);
  process.once("SIGINT", onShutdown);
  process.once("exit", () => releaseLock(vaultRoot));
}

// Spawns the chokidar watcher when config.watch !== false. Wired here, not
// at module load, so the test entry points (which import main) can run with
// a config that disables it. Idempotent: a second call is a no-op while the
// first watcher is still alive.
function maybeStartWatcher(vaultRoot: string, watchEnabled: boolean): void {
  if (!watchEnabled) {
    process.stderr.write(`daftari: vault watcher disabled (watch: false in config)\n`);
    return;
  }
  if (activeWatcher) return;
  activeWatcher = startWatcher(vaultRoot);
  process.stderr.write(`daftari: watching vault for out-of-band edits\n`);
}

// Loads the embedding model in the background so the first user search does
// not pay the cold-start latency. Failures (no network on first run, model
// download blocked) are logged but never crash the server — the next embed()
// call will retry. Intended to be invoked as a `void` from main().
async function runBackgroundWarm(): Promise<void> {
  const result = await warmModel();
  if (result.ok) {
    process.stderr.write(`daftari: embedding model warm — ready for search\n`);
  } else {
    process.stderr.write(`daftari: warning: embedding warm-up failed: ${result.error.message}\n`);
  }
}

async function runBackgroundReindex(
  vaultRoot: string,
  warmEmbeddings: boolean,
  onDone?: () => void,
): Promise<void> {
  try {
    const reindexed = await reindexVault(vaultRoot, makeProgressReporter());
    if (reindexed.ok) {
      const r = reindexed.value;
      markIndexReady();
      process.stderr.write(
        `daftari: indexed ${r.documentCount} docs, ${r.chunkCount} chunks ` +
          `(vectors ${r.vectorEnabled ? "on" : "off"})\n`,
      );
      for (const line of reindexWarnings(r)) process.stderr.write(`daftari: warning: ${line}\n`);
      // If the reindex was fully cache-hit (no chunks needed embedding) the
      // model was never loaded — warm it now so the first user search isn't
      // a cold start. A reindex that did embed already loaded the model; no
      // extra warm is necessary in that path.
      if (warmEmbeddings && r.embeddedCount === 0) {
        void runBackgroundWarm();
      }
    } else {
      markIndexError(reindexed.error.message);
      process.stderr.write(
        `daftari: warning: background index build failed: ${reindexed.error.message}\n`,
      );
    }
  } catch (e) {
    const reason = e instanceof Error ? (e.stack ?? e.message) : String(e);
    markIndexError(reason);
    process.stderr.write(`daftari: warning: background indexer crashed: ${reason}\n`);
  } finally {
    // Start the watcher only after the full reindex pass finishes — the
    // dispatch() guard inside watcher.ts would queue events while the
    // global status is "indexing", but starting after avoids the
    // bookkeeping and keeps the startup ordering obvious: transport,
    // freshness/reindex, watcher.
    onDone?.();
  }
}

// Builds a ReindexOptions whose onProgress streams to both stderr (for
// operator visibility) and the in-process IndexState (so tools can return
// progress to MCP clients). TTY stderr gets a \r-updated single line; piped
// stderr gets a full line every ~5% so MCP-client logs stay readable instead
// of going silent for tens of minutes.
function makeProgressReporter(): ReindexOptions {
  const PIPE_STEP = 0.05;
  let nextPipeMark = 0;
  return {
    onProgress: (done, total) => {
      setIndexProgress(done, total);
      if (total === 0) return;
      if (process.stderr.isTTY) {
        process.stderr.write(`\rdaftari: embedding ${done}/${total} chunks`);
        if (done === total) process.stderr.write("\n");
        return;
      }
      const ratio = done / total;
      if (ratio >= nextPipeMark || done === total) {
        process.stderr.write(`daftari: embedding ${done}/${total} chunks\n`);
        nextPipeMark = Math.floor(ratio / PIPE_STEP + 1) * PIPE_STEP;
      }
    },
  };
}

// Auto-run only when this module is the process entry point (e.g. `tsx
// src/index.ts`). When imported (by cli.ts or tests) it stays inert.
const entryUrl = pathToFileURL(process.argv[1] ?? "").href;
if (import.meta.url === entryUrl) {
  main().catch((e) => {
    const reason = e instanceof Error ? (e.stack ?? e.message) : String(e);
    process.stderr.write(`daftari: fatal: ${reason}\n`);
    process.exitCode = 1;
  });
}
