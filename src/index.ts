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
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { GUEST_ROLE, resolveAccess } from "./access/rbac.js";
import { materializeEdges } from "./curation/edges.js";
import { materializeStagedActions } from "./curation/staged-actions.js";
import { buildMountIndexes } from "./federation/mount-index.js";
import { getMountRegistry, loadMounts, setMountRegistry } from "./federation/mounts.js";
import { acquireLock, releaseLock } from "./lifecycle/lock.js";
import { setCoverageEnabled } from "./search/coverage.js";
import { setVecKnnK } from "./search/hybrid.js";
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
import { setSuppressSuperseded } from "./search/suppression.js";
import { setProvider, warmModel } from "./search/vector.js";
import { startWatcher, type VaultWatcher } from "./search/watcher.js";
import { createServer, resolveToolExposure, SERVER_VERSION } from "./server.js";
import { directoryExists } from "./storage/local.js";
import { loadConfig, TOOL_TIERS, type ToolTier } from "./utils/config.js";

// Read from package.json (via server.ts) so it can never drift from the
// published version. Surfaced in the process lockfile for operator
// diagnostics.
const DAFTARI_VERSION = SERVER_VERSION;

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
  // stdio daftari is holding this vault, SIGTERM it and wait briefly for it
  // to exit; a live `daftari serve` holder REFUSES the takeover (#5 spec
  // Decision 4). See docs/superpowers/plans/2026-05-20-process-lockfile.md.
  const lockResult = await acquireLock(vaultRoot, DAFTARI_VERSION, { mode: "stdio" });
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
  // Retrieval tuning (`search` block): validated by loadConfig, applied once
  // per process, same lifecycle as the provider above.
  setCoverageEnabled(config.value.search.coverage);
  setVecKnnK(config.value.search.vecKnnK);
  setSuppressSuperseded(config.value.search.suppressSuperseded);

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

  // Cross-vault federation (#297): load the declared mounts before the
  // transport opens. Fail-loud — a mount that cannot be validated (missing
  // required path, not a vault, nesting, duplicate, alias-prefix collision)
  // refuses startup, the malformed-RBAC posture. Deny-all-guest resolutions
  // are operator stderr notices, never tool output.
  const federation = config.value.federation;
  if (federation && federation.mounts.length > 0) {
    const registry = await loadMounts(vaultRoot, federation, access.user, (line) =>
      process.stderr.write(`daftari: ${line}\n`),
    );
    if (!registry.ok) {
      process.stderr.write(`daftari: ${registry.error.message}\n`);
      process.exitCode = 1;
      return;
    }
    setMountRegistry(registry.value);
    const ok = [...registry.value.mounts.values()].filter((m) => m.state === "ok").length;
    process.stderr.write(
      `daftari: federation: ${ok}/${registry.value.mounts.size} mounts available ` +
        `(${[...registry.value.mounts.keys()].join(", ")})\n`,
    );
  }

  // Tool exposure (#103/#104): config `tools` block, with --tools overriding
  // the TIER for this invocation only (include/exclude still apply). An
  // unknown --tools value fails loud like any malformed config; unknown tool
  // NAMES in include/exclude only warn — they may name a future tool.
  const tierFlag = parseFlag(argv, "tools");
  let toolsConfig = config.value.tools;
  if (tierFlag !== null) {
    if (!(TOOL_TIERS as readonly string[]).includes(tierFlag)) {
      process.stderr.write(
        `daftari: invalid --tools value '${tierFlag}' (expected one of ${TOOL_TIERS.join(", ")})\n`,
      );
      process.exitCode = 1;
      return;
    }
    toolsConfig = { ...toolsConfig, tier: tierFlag as ToolTier };
  }
  for (const name of resolveToolExposure(toolsConfig).unknown) {
    process.stderr.write(
      `daftari: warning: tools.include/exclude names unknown tool '${name}' — ignored\n`,
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

  // Open MCP transport first so the client can open the connection and
  // list tools immediately. Indexing — if needed — runs as a background
  // task; tools that depend on the index will respond "still indexing" until
  // it completes.
  //
  // serveStdio owns the era decision per connection: a 2026-07-28 client is
  // served the modern envelope; a 2025-era `initialize` pins a legacy-era
  // instance from the same factory (the default `legacy: 'serve'`). Lagging
  // clients use stdio — that promise (spec 2026-07-26, Decision 1) is kept
  // HERE, which is why serve can refuse them.
  serveStdio(() => createServer(vaultRoot, access, toolsConfig));
  process.stderr.write(
    `daftari: serving vault at ${vaultRoot} (stdio) — ` +
      `user=${access.user} role=${access.roleName}\n`,
  );

  await startVaultServices(vaultRoot, {
    warmEmbeddings: config.value.warmEmbeddings,
    watch: config.value.watch,
  });

  // Per-mount index builds run in the background after the canonical vault's
  // services are up (#297, Decision 6): startup-only freshness, no watchers,
  // failures degrade that mount's search rather than the server.
  const mountRegistry = getMountRegistry();
  if (mountRegistry) {
    void buildMountIndexes(mountRegistry.mounts.values(), (line) =>
      process.stderr.write(`daftari: ${line}\n`),
    );
  }
}

// The index/watcher bootstrap shared by stdio main() and `daftari serve`
// (#5): freshness check, cheap jsonl re-materialization on the fresh path,
// background reindex otherwise, watcher start either way. Returns once the
// FOREGROUND work is done — the reindex itself runs on unawaited in the
// background, alongside the live transport.
export async function startVaultServices(
  vaultRoot: string,
  opts: { warmEmbeddings: boolean; watch: boolean },
): Promise<void> {
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
    if (opts.warmEmbeddings) {
      void runBackgroundWarm();
    }
    maybeStartWatcher(vaultRoot, opts.watch);
    return;
  }

  // Background reindex. The promise is intentionally not awaited — the
  // caller returns once the transport is up, and the indexing pass runs to
  // completion alongside the live server.
  markIndexing();
  process.stderr.write(`daftari: starting background reindex…\n`);
  void runBackgroundReindex(vaultRoot, opts.warmEmbeddings, () => {
    maybeStartWatcher(vaultRoot, opts.watch);
  });
}

// Reference held so a SIGTERM / SIGINT can close the watcher cleanly. One
// per process — the server runs against one vault for its lifetime.
let activeWatcher: VaultWatcher | null = null;

// Set once a signal-driven shutdown begins. Two jobs: (1) stop a watcher from
// starting after shutdown has run — the background reindex's onDone fires the
// watcher start AFTER the transport is up, so a SIGTERM that lands mid-reindex
// would otherwise spawn a fresh watcher post-shutdown and pin the event loop
// open forever; (2) make the intent explicit that we are tearing down. See
// the SIGTERM-during-reindex hang (takeover left two writers on one vault).
let shuttingDown = false;

// Install once, regardless of whether the watcher starts. The lock release
// must run for all exit paths:
//   - SIGTERM / SIGINT (parent MCP client closing the pipe, or another
//     daftari instance taking over): onShutdown explicitly releases.
//   - Normal completion of --reindex mode: main() returns, the event loop
//     drains, Node emits 'exit', the registered listener releases.
// The 'exit' listener is sync-only (Node guarantees the loop is closed by
// then), which is why releaseLock is sync.
//
// `extra` (#5): serve registers its own teardown (close the HTTP listener
// and every live session) to run before the lock releases.
export function installShutdownHandlers(vaultRoot: string, extra?: () => void): void {
  const onShutdown = () => {
    shuttingDown = true;
    if (activeWatcher) {
      const w = activeWatcher;
      activeWatcher = null;
      void w.close();
    }
    extra?.();
    releaseLock(vaultRoot);
    // Terminate deterministically. Relying on the event loop to drain does not
    // work when a SIGTERM lands mid-reindex: the unawaited background reindex
    // keeps running and open handles (and the post-reindex watcher) pin the
    // loop, so the process hangs past the takeover's SIGTERM grace, leaving two
    // instances writing one vault's index.db. Exiting is safe here because the
    // index is SQLite/WAL with per-batch-committed, resumable reindex writes: a
    // kill mid-reindex cannot corrupt index.db (uncommitted work rolls back;
    // the next startup resumes from the committed batches).
    process.exit(0);
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
  // A signal-driven shutdown may have already run (e.g. SIGTERM during the
  // background reindex, whose onDone calls this). Never start a watcher after
  // that — it would re-pin the event loop the shutdown is trying to release.
  if (shuttingDown) return;
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
      // extra warm is necessary in that path. embeddedCount is the COMMITTED
      // count (#54), so 0 alone no longer proves the model was never invoked:
      // a first-batch embed failure also banks nothing. That failure path
      // drops vectorEnabled, so gate on it — warming a provider that just
      // failed would fail the same way.
      if (warmEmbeddings && r.vectorEnabled && r.embeddedCount === 0) {
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
