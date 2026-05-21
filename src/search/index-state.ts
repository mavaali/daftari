// Process-wide indexing state.
//
// The MCP server opens the stdio transport before running a cold-start reindex
// so `initialize` / `tools/list` answer immediately. While that background pass
// runs the server is alive but search and write tools cannot trust the index;
// they consult this module to decide whether to serve or to reply "still
// indexing — N/M chunks". A single in-process snapshot is enough because the
// server is one Node process per vault.
//
// Embedding model load is tracked separately from indexing because the two
// are orthogonal: a fully-cached reindex (every chunk hash already has an
// embedding row) never loads the model at all, while a search may need to
// load the model even when the index is "ready". The `modelStatus` lets a
// tool report "embeddings warming" instead of misleading a client with a
// generic indexing message when the slow operation is actually the model
// load.

export type IndexStatus = "ready" | "indexing" | "error";

// Model lifecycle separate from index lifecycle:
//   "cold"    — model has not been touched this process. embed() will load.
//   "warming" — load is in flight (background warm-up or first embed()).
//   "ready"   — load resolved; subsequent embed() calls are hot-path only.
//   "error"   — last load attempt failed; next embed() may retry.
export type ModelStatus = "cold" | "warming" | "ready" | "error";

export interface IndexSnapshot {
  status: IndexStatus;
  done: number;
  total: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  modelStatus: ModelStatus;
  modelError: string | null;
}

function freshState(): IndexSnapshot {
  return {
    status: "ready",
    done: 0,
    total: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
    modelStatus: "cold",
    modelError: null,
  };
}

let state: IndexSnapshot = freshState();

export function getIndexStatus(): IndexSnapshot {
  return { ...state };
}

export function markIndexing(): void {
  state = {
    ...state,
    status: "indexing",
    done: 0,
    total: 0,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

export function setIndexProgress(done: number, total: number): void {
  if (state.status !== "indexing") return;
  state = { ...state, done, total };
}

export function markIndexReady(): void {
  state = {
    ...state,
    status: "ready",
    error: null,
    finishedAt: new Date().toISOString(),
  };
}

export function markIndexError(message: string): void {
  state = {
    ...state,
    status: "error",
    error: message,
    finishedAt: new Date().toISOString(),
  };
}

// Model lifecycle transitions. Called by vector.ts as the memoised
// extractor promise progresses; the warm-up entry point and the lazy
// first-embed path both flow through the same getExtractor() so callers
// here do not need to special-case the trigger.
export function markModelWarming(): void {
  state = { ...state, modelStatus: "warming", modelError: null };
}

export function markModelReady(): void {
  state = { ...state, modelStatus: "ready", modelError: null };
}

export function markModelError(message: string): void {
  state = { ...state, modelStatus: "error", modelError: message };
}

// Tests load tools without running main(); resetting the singleton between
// suites keeps cross-test pollution out of the state machine.
export function resetIndexState(): void {
  state = freshState();
  inflightPaths.clear();
}

// Per-path "currently indexing this one file" tracker. The global `status`
// above describes whole-vault reindex passes (startup / vault_reindex). The
// fs.watch path drives many concurrent per-file re-indexes that must not
// block unrelated writes or searches; their in-flight membership lives here.
// Membership is advisory: searches that read a slightly-stale row for a few
// hundred ms while a per-file index is mid-write is acceptable. The
// per-path *serialisation* between an external edit and a Daftari write is
// the file-level write lock in src/access/locks.ts.
const inflightPaths = new Set<string>();

export function markPathIndexing(relPath: string): void {
  inflightPaths.add(relPath);
}

export function markPathReady(relPath: string): void {
  inflightPaths.delete(relPath);
}

export function isPathIndexing(relPath: string): boolean {
  return inflightPaths.has(relPath);
}

export function getInflightPaths(): string[] {
  return [...inflightPaths];
}

// Formatted message tools return to clients while indexing is in progress.
// One place so the phrasing is consistent across vault_search, vault_write,
// vault_reindex, etc. When the model is warming and the index is otherwise
// ready, the message says so explicitly — the slow operation is the model
// load, not an indexing pass, and a client that retries blindly against an
// "indexing" message is missing useful context.
export function indexingBusyMessage(snapshot: IndexSnapshot): string {
  if (snapshot.status === "indexing") {
    if (snapshot.total > 0) {
      return `vault is still indexing (${snapshot.done}/${snapshot.total} chunks) — try again shortly`;
    }
    return `vault is still indexing — try again shortly`;
  }
  if (snapshot.modelStatus === "warming") {
    return `embedding model is warming — try again shortly`;
  }
  return `vault is still indexing — try again shortly`;
}
