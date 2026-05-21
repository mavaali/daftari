// Process-wide indexing state.
//
// The MCP server opens the stdio transport before running a cold-start reindex
// so `initialize` / `tools/list` answer immediately. While that background pass
// runs the server is alive but search and write tools cannot trust the index;
// they consult this module to decide whether to serve or to reply "still
// indexing — N/M chunks". A single in-process snapshot is enough because the
// server is one Node process per vault.

export type IndexStatus = "ready" | "indexing" | "error";

export interface IndexSnapshot {
  status: IndexStatus;
  done: number;
  total: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

function freshState(): IndexSnapshot {
  return {
    status: "ready",
    done: 0,
    total: 0,
    error: null,
    startedAt: null,
    finishedAt: null,
  };
}

let state: IndexSnapshot = freshState();

export function getIndexStatus(): IndexSnapshot {
  return { ...state };
}

export function markIndexing(): void {
  state = {
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
// vault_reindex, etc.
export function indexingBusyMessage(snapshot: IndexSnapshot): string {
  if (snapshot.total > 0) {
    return `vault is still indexing (${snapshot.done}/${snapshot.total} chunks) — try again shortly`;
  }
  return `vault is still indexing — try again shortly`;
}
