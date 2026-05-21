# Architecture

Daftari is a single MCP server process. It is started against one vault
directory, runs as one access identity for its lifetime, and serves 13 tools
over stdio. This document explains how a tool call travels through the system
and why the design is shaped the way it is.

## The layered model

```
                      ┌─────────────────────────────┐
   MCP client  ──────▶ │  MCP server (stdio, 13 tools)│
   (agent)             └──────────────┬──────────────┘
                                      │  every call
                       ┌──────────────▼──────────────┐
              Layer 2  │  ACL — config-driven RBAC    │  can this role read/
                       │  (.daftari/config.yaml)      │  write/promote here?
                       └──────────────┬──────────────┘
                                      │  permitted
                       ┌──────────────▼──────────────┐
              Layer 3  │  Write safety                │  file lock (60s TTL),
                       │  locks · git · provenance    │  auto-commit, log
                       └──────────────┬──────────────┘
                                      │  mutation applied
                       ┌──────────────▼──────────────┐
              Layer 4  │  Curation                    │  staleness · tensions
                       │  lint · tension · lifecycle  │  · lint · promote/dep.
                       └──────────────┬──────────────┘
                                      │
                       ┌──────────────▼──────────────┐
              Layer 1  │  Storage                     │  markdown + frontmatter
                       │  markdown · git · SQLite idx │  · git history · index
                       └─────────────────────────────┘
```

Read the layers as concerns, not as a strict call stack — a read touches only
layers 2 and 1; a write travels through 2, 3, 4, and 1. The numbering follows
the README's four-layer model.

### Layer 1 — Storage

The vault is a directory of markdown files, each with a YAML frontmatter block.
Frontmatter *is* the metadata layer; there is no separate metadata store.

Three things sit alongside the markdown:

- **Git.** The vault root is a git work tree. Every write auto-commits, so the
  files' git history *is* the document history. There is no second versioning
  system. A vault nested in a larger repo can set `auto_commit: false` in
  `.daftari/config.yaml` to opt out: writes still produce durable, indexed,
  provenance-logged files, but staging and committing are left to the caller.
- **SQLite index** (`.daftari/index.db`). Holds the BM25 term statistics and
  the vector embeddings that power hybrid search. It is **ephemeral** — it can
  be rebuilt from the markdown files at any time with `vault_reindex`, and it
  is git-ignored.

  The vector embeddings are produced **locally**. Each document body is split
  into ~800-character chunks; every chunk is embedded into a 384-dimension
  vector by the `all-MiniLM-L6-v2` sentence-transformer, run in-process via
  `@huggingface/transformers` (Transformers.js). No embedding API is called —
  the only network access is the one-time download of the model weights to the
  Hugging Face cache on first use. Embedding is best-effort: if the model
  cannot load, a reindex still builds the BM25 side and chunks land with no
  embedding row, so search degrades to lexical-only rather than failing. The
  model is pinned in code (`EMBEDDING_MODEL` in `src/search/vector.ts`); v1
  has no config-driven embedding-provider hook.

  Embeddings are stored in a separate, **content-addressed** `embeddings`
  table keyed by `(content_hash, model)`. A `chunks` row carries the
  `sha256` of its text and joins to the `embeddings` table for the current
  model — so an embedding is the property of a chunk's text, not of a file
  path or its mtime. A reindex hashes every chunk, asks the cache which
  hashes already have a row for the current model, and only embeds the
  misses. The cost of a reindex therefore scales with the number of *changed
  chunks*, not the size of the vault: an edit to one paragraph re-embeds one
  chunk, a rename re-embeds zero, a paragraph moved verbatim to another file
  re-embeds zero. On the first reindex after a schema bump the cache is
  empty, so a one-time full embed populates it; every subsequent reindex is
  incremental. After writing chunks, the reindex runs an internal `vault_gc`
  step that drops embeddings rows whose `content_hash` is no longer
  referenced by any chunk, so the cache does not accumulate orphans across
  edits. The composite primary key on `(content_hash, model)` is
  deliberate — a future model migration can keep both the old and new
  model's embeddings present under the same hash, so a roll-forward does
  not have to clear the cache first.
- **SQLite lock store** (`.daftari/locks.db`). Holds active write locks. Also
  ephemeral.

#### Reactive indexing

The index is kept in sync with the markdown files at write time, not just at
startup. The write-path tools (`vault_write`, `vault_append`,
`vault_promote`, `vault_deprecate`) call `indexDocument()` in-process after
each successful write, and a `chokidar` watcher runs over the vault root for
**out-of-band** edits — an editor save, a sync engine pull, a scripted
writer. The watcher is on by default; set `watch: false` in
`.daftari/config.yaml` to disable it for read-only or batch-script
environments.

Events are debounced per-path with a 500ms window: an editor's atomic-rename
save burst (write temp, rename onto target, delete temp) coalesces into a
single `indexDocument()` call for that file. `unlink` events re-stat the
path before deleting, so the phantom `unlink` + `add` pairs FSEvents
(macOS), iCloud, and Dropbox emit during atomic-rename saves are treated as
a change rather than a delete. On a confirmed delete the document and its
chunks are evicted from the index *and* the path is removed from the
freshness manifest — so the next startup's manifest-vs-disk check does not
see the missing entry as drift.

Daftari's own writes are suppressed from the watcher path: after a
write-path tool's in-process `indexDocument()` returns, the absolute path
is added to a short-lived "self-write" set, and the watcher silently drops
the chokidar event that follows. Without this the file would be indexed
twice.

The startup freshness check (#36 — manifest mtimes vs. disk) remains as
the reconciliation backstop: if the watcher drops events (chokidar /
FSEvents are not 100% reliable on large vaults), the next startup catches
the drift and triggers a full reindex.

The markdown files are the single source of truth. Delete every `.db` file and
the vault loses nothing — rebuild and continue.

### Layer 2 — ACL (multi-tenant access control)

RBAC is config-driven. `.daftari/config.yaml` declares named roles and their
per-collection `read` / `write` / `promote` permissions. The server is started
with `--user` and `--role`; that role governs every tool call for the life of
the process. There is no user-management system and no login — identity is an
operational decision made at startup.

A missing or unmatched role resolves to a deny-all **guest**. A malformed
config makes the server refuse to start: a permission layer that silently loads
a broken policy is worse than one that won't boot.

### Layer 3 — Write safety

The first half of the moat. Multiple agents may write to one vault; Layer 3
makes those writes *safe and attributable* — it does not orchestrate them.

- **File-level write locks**, SQLite-backed, with a 60-second TTL. A writer
  acquires the lock for one file; a competing writer fails cleanly with a
  "locked" error rather than corrupting the file. An expired lock is released
  automatically, so a crashed writer cannot wedge the vault. This is a safety
  mechanism — single-writer-per-file — not a coordination protocol.
- **Auto-commit.** Every successful write is committed to git, authored by the
  acting identity. The history is complete and attributable without anyone
  having to remember to commit. Vaults that set `auto_commit: false` skip this
  step — the write is still durable and provenance-logged, but the caller owns
  git (useful when the vault is a subdirectory of a larger repo with its own
  branching and PR workflow).
- **Provenance log.** Beyond git, each mutation is appended to a structured
  provenance log: which tool, which agent, which file, what changed in the
  frontmatter. `vault_provenance` reads it back.

The locks are table stakes — single-writer safety is the floor, not the moat.
What is genuinely differentiated here is **auto-commit + provenance**: a
complete, attributable history of who changed what, produced without anyone
having to remember to record it.

#### Known limitations

The locking is deliberately minimal, and it is worth being precise about what
it does *not* do:

- **No queuing.** Two agents targeting the same file inside the 60-second lock
  window do not take turns. The first acquires the lock; the second fails
  immediately with a "locked" error. There is no wait-and-retry.
- **No merge.** Concurrent edits to one document are never reconciled. The
  losing writer must re-read the (now-changed) file and decide what to do —
  Daftari does not merge their changes.
- **Per-file granularity.** The lock protects one file. A write that logically
  spans several documents is not atomic across them.

This is sufficient for the common case — agents usually write to different
documents — and it guarantees no write ever corrupts a file. But the lock
alone does not catch a **stale write**: an agent that reads a document, then
writes it after another agent changed it in between, never held the lock at
the same time as that other agent.

**Optimistic concurrency** closes that gap. `vault_read` returns a `version`
token — the SHA-256 of the file as read, frontmatter included. Every write
tool (`vault_write`, `vault_append`, `vault_promote`, `vault_deprecate`)
accepts an optional `base_version`. When supplied, the server re-hashes the
file *inside the write lock* and, if the hash no longer matches, rejects the
write with a `stale write:` error — nothing is written, committed, or
indexed, and a `rejected_stale` entry is appended to the provenance log.
Omitting `base_version` preserves last-write-wins behavior, so the check is
fully backward compatible.

One caveat: the in-lock hash only synchronizes Daftari writers. A non-Daftari
process editing the file directly can still race the check between the hash
and the write — acceptable, because the lock only ever coordinated Daftari
writers in the first place.

### Layer 4 — Curation

The second half of the moat. Storing knowledge is easy; keeping a growing vault
*coherent* is the real problem. The curation engine is deliberately
**advisory** — it surfaces problems and never auto-fixes:

- **Staleness.** Each document has a `ttl_days`. Past it, the document is
  flagged stale with a decay score. Stale does not mean deleted — it means "a
  human or agent should re-verify this."
- **Tensions.** When two documents contradict each other, `vault_tension_log`
  records the contradiction — both sources, both claims — with status
  `unresolved`. It records; it does not resolve.
- **Lint.** `vault_lint` runs six cross-vault checks (stale files, orphans,
  old drafts, stagnant low-confidence files, deprecated-but-still-linked, and
  questions raised but unanswered anywhere in the vault) and produces a report.
- **Lifecycle.** The `draft → canonical → deprecated / superseded` status
  progression. `vault_promote` and `vault_deprecate` move documents along it;
  promotion is gated on complete frontmatter and the `promote` permission.

Advisory-by-design is the point: an agent maintains the vault, but no automated
process silently rewrites or deletes knowledge. Every change is a deliberate,
attributable act.

## The request path

A **read** (`vault_read`, `vault_index`, `vault_status`, `vault_search`):

1. The server receives the tool call.
2. **Layer 2** checks the role's `read` permission for the target collection.
   Denied collections are filtered out of results entirely.
3. **Layer 1** reads the markdown (or queries the index) and returns it, with
   an advisory frontmatter validation report attached.

A **write** (`vault_write`, `vault_append`, `vault_promote`, `vault_deprecate`):

1. The server receives the tool call.
2. **Layer 2** checks the role's `write` permission (and `promote` for
   promotions).
3. **Layer 3** acquires the file's write lock. If another holder owns it, the
   call fails cleanly here.
4. The frontmatter is validated; an invalid write is rejected before anything
   touches disk.
5. **Layer 1** writes the markdown file.
6. **Layer 3** auto-commits to git and appends a provenance entry.
7. The search index is refreshed for the changed file.
8. The lock is released.

Every tool handler returns a `Result<T, Error>` — it never throws. A failure at
any step is a value the server turns into an MCP error response; the stdio
connection is never taken down by a bug in one tool.

## Accumulation vs. generative domains

Every document declares a `domain`, and the distinction is load-bearing.

**Accumulation domain.** Knowledge that *compounds*. A competitive-intelligence
note, a pricing breakdown, a researched comparison. Each write builds on the
last; the document is meant to become more complete and more trustworthy over
time. Accumulation documents are *compiled*: the agent does the synthesis once
and writes the durable result. They are the documents that earn canonical
status, accrue inbound links, and are cross-referenced.

**Generative domain.** Knowledge that is *speculative or single-shot*. A
moonshot sketch, a brainstorm, a "what if" note. These are summaries, not
compiled canon. They are expected to be provisional — the agent flags tensions
in them but does not invest in cross-referencing or hardening them.

Why the schema distinction matters: the two domains have different curation
economics. An accumulation document that goes stale is a *problem* — it was
supposed to stay true. A generative document that goes stale is *expected* —
that is what speculation does. Tooling that treated both the same would either
nag about every brainstorm or quietly trust every stale fact. The `domain`
field lets the curation layer apply the right standard to each: hold
accumulation knowledge to a high bar, and let generative knowledge be
provisional without penalty.

That split — compile what compounds, summarize what speculates — is the same
idea as "compilation over retrieval", applied one level down: not just *whether*
to compile, but *which knowledge is even worth compiling*.
