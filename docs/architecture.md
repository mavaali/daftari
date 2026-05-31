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
- **SQLite index** (`.daftari/index.db`). Holds the lexical (FTS5) and
  vector (sqlite-vec) indexes that power hybrid search. It is **ephemeral**
  — it can be rebuilt from the markdown files at any time with
  `vault_reindex`, and it is git-ignored.

  Lexical ranking lives in an FTS5 virtual table (`documents_fts`) over
  title, tags, and body. SQLite's built-in BM25 ranks results and AFTER
  INSERT / UPDATE / DELETE triggers on the regular `documents` table keep
  the FTS index in sync without any extra write path. Vector ranking
  lives in a sqlite-vec `embeddings_vec` virtual table that mirrors the
  durable `embeddings` cache and exposes KNN queries via `MATCH ... AND
  k = ?` with cosine distance. Both indexes are SQL-native — search is
  one prepared statement per ranker, not a JavaScript scan.

  **Prerequisite.** sqlite-vec ships a loadable extension (`vec0.dylib`
  / `.so` / `.dll`) and Daftari loads it at index-db open time via
  `better-sqlite3`'s `db.loadExtension()`. The `sqlite-vec` npm package
  contains pre-built binaries for darwin/linux/windows on x64 and arm64,
  and the `better-sqlite3` npm prebuilt enables extension loading by
  default — so for the common case `npm install` is the only step
  needed. If a custom `better-sqlite3` build with extension loading
  disabled is installed, `openIndexDb` returns a Result.err with
  actionable text: `npm rebuild better-sqlite3 --build-from-source`.
  The server refuses to start on this failure rather than silently
  falling back to JavaScript cosine.

  The vector embeddings are produced by a configurable
  **`EmbeddingProvider`** (see `src/search/embedding-provider.ts`). Each
  document body is split into ~800-character chunks; every chunk is embedded
  into a fixed-dimension vector by the active provider. Two providers ship
  with v1.9:

  - **`local-minilm`** (default) — runs `all-MiniLM-L6-v2` in-process via
    `@huggingface/transformers` (Transformers.js). 384-dimension vectors,
    fully local, no embedding API call. The only network access is the
    one-time download of the model weights to the Hugging Face cache on
    first use. Slow on cold-start (multi-minute on large vaults) but free.

  - **`openai-3-small`** — calls OpenAI's `text-embedding-3-small`
    (1536-dim) over HTTPS. Fast (~2 min for a 44k-chunk vault vs ~25 min
    locally) but paid. Requires `OPENAI_API_KEY` in the server's
    environment; the key is never read from config files. Batched at 96
    inputs per request, with exponential backoff on 429 / 5xx (up to 3
    retries).

  The active provider is set in `.daftari/config.yaml`:

  ```yaml
  embeddings:
    provider: local-minilm   # or: openai-3-small
  ```

  An unknown provider id, or `openai-3-small` with no `OPENAI_API_KEY`
  in env, is a hard config error — the server refuses to start. Embedding
  is best-effort at runtime: if the model cannot load (local) or the API
  is unreachable (paid), a reindex still builds the FTS5 lexical index and chunks
  land with no embedding row, so search degrades to lexical-only rather
  than failing.

  Switching providers between server runs is safe: the `embeddings` table
  is keyed by `(content_hash, model)`, so the new provider populates a
  fresh row set on first reindex while the previous provider's rows stay
  in the cache as cheap insurance for switching back.

  The model loads **lazily**: `getExtractor()` is invoked only when
  `embed()` actually has texts to embed, not at startup. With the
  content-addressed cache above, a startup that finds every chunk hash
  already in the cache (the common case — nothing in the vault changed
  since the last run) never loads the model at all. After the transport
  is open and the freshness check has finished, the server kicks off a
  background `warmModel()` so the first user search does not pay the
  ~500ms cold start. The warm-up is gated by the optional
  `warm_embeddings` flag in `.daftari/config.yaml` (default `true`); set
  it to `false` for read-only roles that never embed or for low-memory
  deployments where the ~100MB model footprint is unwelcome. A warm-up
  failure (no network on first run, model download blocked) is logged
  but never crashes the server — the next `embed()` call retries.

  Embeddings are stored in a separate, **content-addressed** `embeddings`
  table keyed by `(content_hash, model)`, with a `dim` column recording
  the vector dimension as defense-in-depth against a corrupt or cross-
  provider mix. A `chunks` row carries the `sha256` of its text and joins
  to the `embeddings` table for the current model — so an embedding is
  the property of a chunk's text, not of a file path or its mtime. A reindex hashes every chunk, asks the cache which
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

#### Thematic clustering (`vault_themes`)

`vault_themes` reads the existing `chunks` / `embeddings` tables — no new
storage, no schema change. The unit of clustering is the **document**, not
the chunk: for each document in scope the tool gathers its chunk
embeddings (the same `chunks → embeddings` join the search path uses),
**mean-pools** them into one 384-dimension vector, and L2-normalises so
the result lives on the unit sphere (cosine distance reduces to Euclidean
distance there). A document with no embedded chunks is excluded and
counted in `skippedDocuments`. Pooling collapses ~44K chunk vectors to
~3.5K document vectors, which makes every downstream algorithm — including
the O(n²) silhouette — tractable on the full set with no sampling.

Clustering is hand-rolled **k-means** (k-means++ initialisation, Lloyd's
iterations) driven by a fixed-seed mulberry32 RNG so the same vault
produces the same themes across runs. By default the tool sweeps k ∈ {10,
15, 20, 25} and picks the k with the best mean silhouette; passing an
explicit `k` skips the sweep. Candidate k values are clamped to the
clusterable document count, so a tiny vault degrades gracefully rather
than crashing.

Each theme reports a heuristic **label** derived from TF-IDF over the
cluster's document titles and tags — no LLM call — with a fallback to the
most common tags. The per-theme **`coherence`** value is the mean pairwise
cosine similarity inside the cluster (distinct from the silhouette score
used to pick k). **`representativeDocs`** are the documents nearest the
cluster centroid; **`relatedTags`** are the most frequent tags. Themes are
sorted by `documentCount` desc.

v1's partition is one-doc-one-theme: each document's `documentCount`
contribution lives in exactly one cluster (its pooled centroid). To
surface the cross-cutting documents the partition hides, each theme
also reports **`secondaryDocs`** — documents whose primary cluster is
elsewhere but whose pooled vector is close enough to this theme's
centroid (within a similarity delta of the primary alignment, above an
absolute floor, capped per doc) that the doc plausibly belongs here
too. This is soft reporting on top of a hard partition; it does not
change `documentCount`. Density-aware HDBSCAN, true multi-theme
membership (where a doc's chunks live in genuinely different topic
regions), a seeded-search / coverage mode, and LLM-generated labels are
deferred.

`coherence` is `null` for singleton clusters — a one-doc cluster has no
pairs to average, and reporting 1.0 would falsely imply tightness. For
multi-doc clusters it is the mean pairwise cosine similarity inside the
cluster, distinct from the silhouette score used to pick k.

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
  `unresolved`. It records; it does not resolve. Each entry carries a `kind`
  (`temporal` | `factual` | `interpretive` | `unspecified` for legacy
  entries), and closure is a deliberate act via `vault_tension_resolve` with
  a `resolution` block of its own kind (`superseded` | `corrected` |
  `accepted` | `invalid`). `accepted` resolutions mark a deliberately
  persistent disagreement — the tension stays in the log as a stable
  acknowledged feature of the vault rather than a defect. `vault_lint`
  reports the distribution by kind, by resolution kind, and the stable
  acknowledged count. Unresolved tensions also carry an **aging tier**
  derived from their logged date (Fresh ≤30d, Aging 31–90d, Stale >90d).
  Stale tensions get kind-specific lint copy — the temporal smell is
  "deprecate the older doc"; the factual smell is "investigate"; the
  interpretive smell is "decide explicitly" (`accepted` vs `invalid`).
  `unspecified` legacy entries and `accepted` resolutions are excluded
  from aging by design. `vault_tension_clusters` computes connected
  components over the live tension graph (unresolved, non-accepted edges
  only). Cluster IDs are content-addressed — the first 8 hex chars of
  `sha256(canonical-sorted member paths)` — so identical membership
  always renders the identical id across runs, and any membership change
  produces a fresh id by construction. `vault_lint` reports the cluster
  count, the max cluster size, and flags clusters that are large (>5
  docs, a composability smell) or aged (oldest tension >90 days, tech
  debt). `vault_tension_blast` computes the **blast radius** of a
  contested doc or cluster — the transitive closure of downstream docs
  that cite or link a contested node. Two confidence channels:
  `primary_blast` counts docs reached via the frontmatter `sources` edge
  (authoritative provenance); `advisory_blast` counts docs reached only
  via in-vault markdown links (suggestive). `superseded_by` is not a
  blast edge — the doc that supersedes a contested doc is the
  replacement, not an inheritor.
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
