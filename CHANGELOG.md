# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.8.0] - 2026-05-20

### Changed

- **Content-addressed embedding cache** (#38, PR #39). Embeddings are no
  longer keyed by `(path, chunk_index)` — they now live in a separate
  `embeddings` table keyed by `(content_hash, model)`, where
  `content_hash` is the SHA-256 of the chunk's text. `chunks` rows carry
  a `content_hash` column and join to `embeddings` for the current model.
  A reindex now hashes every chunk, asks the cache which hashes already
  have a row, and only embeds the misses — so the cost of a reindex
  scales with the number of *changed chunks*, not the size of the vault.
  An edit to one paragraph re-embeds one chunk; a rename re-embeds zero;
  a paragraph moved verbatim to another file re-embeds zero. The
  composite primary key on `(content_hash, model)` is intentional: a
  future model migration can keep both the old and new model's
  embeddings present under the same hash. After writing chunks, the
  reindex runs an internal `vault_gc` step that drops embeddings rows
  whose `content_hash` is no longer referenced by any chunk, so the
  cache does not accumulate orphans. `index.db` rebuilds cleanly on the
  schema bump (the index is a derived cache); the first reindex after
  upgrade is a one-time full embed that populates the cache, and every
  reindex after that is incremental. This is PR 1 of the #38 unbundle;
  fs.watch reactive indexing, lazy model load, FTS5, sqlite-vec, and
  pluggable embedding backends are tracked as separate follow-ups.

## [1.7.1] - 2026-05-19

### Fixed

- **MCP server hang at startup** (#35, PR #36). The server no longer re-embeds
  the entire vault on every launch and no longer waits for indexing to finish
  before opening the stdio transport. Three compounding bugs are fixed:
  (1) `main()` always called `reindexVault` even when `.daftari/index.db`
  already reflected the files on disk — every restart re-embedded the whole
  vault (~25 minutes on a 3,500-file vault); now a path→mtime manifest is
  persisted in the SQLite meta table and compared on startup, so an
  unchanged vault skips the embedding pass entirely. (2) The
  `StdioServerTransport` opened only after indexing completed, so MCP
  clients could not answer `initialize` for the whole duration; the
  transport now opens first and indexing — when required — runs as a
  background task. (3) Progress was emitted only on TTY stderr, leaving
  every real (non-TTY) MCP client with zero output during a cold start;
  progress now streams on stderr in both TTY (\\r-updated) and pipe (full
  line every ~5%) modes. A new in-process `IndexState`
  (`ready`/`indexing`/`error` + progress) gates `vault_search`,
  `vault_search_related`, `vault_reindex`, `vault_write`, `vault_append`,
  `vault_promote`, and `vault_deprecate` while indexing — those tools
  return a progress-bearing busy error so clients can retry. Read tools
  (`vault_read`, `vault_index`, `vault_status`) are unaffected because
  they go to the filesystem, not the index. `--reindex` remains the one
  synchronous mode (rebuild, exit).

## [1.7.0] - 2026-05-19

### Added

- **Pre-write transform hooks** (#32). New `pre_write_transform` hook phase
  runs before `validateFrontmatter` and can derive or override frontmatter
  fields. Returns `Partial<Frontmatter>`. Refuses via throw. Existing
  `pre_write` validators continue to run unchanged after validation. Closes
  the gap where v1.6.0 hooks could observe and reject but could not derive
  built-in fields. Declared under `hooks.pre_write_transform` in
  `.daftari/config.yaml`; the runner merges each hook's patch Object.assign
  style — shallow, last-writer-wins. Phase order is rigid:
  `pre_write_transform` (declaration order), then `validateFrontmatter`, then
  `pre_write` (declaration order), regardless of config layout. Fires for
  `vault_write` and `vault_append`; `vault_promote` and `vault_deprecate`
  bypass it, matching the `pre_write` bypass.

### Changed

- The existing `pre_write` hook surface continues to half-mutate: a mutation
  to `rawFrontmatter` inside a `pre_write` hook propagates for extension
  fields but not for built-in fields. This behavior is preserved for
  backward compatibility but is now implementation detail — new mutations
  should use `pre_write_transform`.

## [1.6.0] - 2026-05-19

### Added

- **Pre-write validation hooks** (#29, PR #30). Vault owners can register ES
  module hooks in `.daftari/config.yaml` under `hooks.pre_write`. Each hook
  exports a default function `(frontmatter, context) => ValidationIssue[]` and
  runs before the write completes; any returned issue blocks the write,
  matching the existing built-in schema-validation contract. Hooks fire for
  `vault_write` (create + update) and `vault_append`; `vault_promote` and
  `vault_deprecate` intentionally bypass them — those are narrow,
  server-controlled metadata mutations, not user-authored content. Run-all
  ordering: every declared hook runs even if an earlier one returned issues,
  and the caller gets one consolidated issue list. Loud failure mode: a hook
  throw becomes a synthetic blocking issue tagged with the hook path; a
  non-array return or a malformed issue object is also a synthetic blocking
  issue. Hooks load via ESM dynamic import with vault-root-relative paths
  only — absolute paths and `..` escapes are rejected. Unrecognised keys
  under `hooks:` are loud config errors so future surfaces (`pre_read`,
  `post_write`) can't be silently shadowed by typos. Validate-only in v1;
  mutation is a deliberate follow-up. Trust model documented in the README:
  hooks run in-process with full host capability, so vault owner is
  responsible for the contents of `.daftari/hooks/`.

### Changed

- **Hook loader busts the ESM module cache on each call** so hot-edits to a
  hook file are picked up on the next write without a server restart. The
  loader appends a `?t=<mtimeMs>` suffix to the import URL; the suffix
  changes only when the file changes, so unchanged hooks still hit the
  cache.

## [1.5.1] - 2026-05-18

### Fixed

- **Reindex no longer exhausts memory on mid-sized vaults** (#25). `reindexVault`
  embedded every chunk across the whole vault in a single model call, which
  padded the batch to its longest sequence and allocated activation tensors
  proportional to the total chunk count — so peak memory scaled with vault
  size. Past ~200 documents the allocation exceeded RAM and the process
  stalled in a GC/swap death spiral with no output. Embedding now runs in
  fixed-size sub-batches, keeping peak memory flat regardless of vault size
  (a 600-chunk embed dropped from ~3.5 GB to ~325 MB peak RSS).
- **Reindex reports progress instead of running silent.** On an interactive
  terminal, `--reindex` now prints a single-line `embedding N/M chunks`
  counter, so a large-vault reindex can be distinguished from a hang.

## [1.5.0] - 2026-05-18

### Added

- **`auto_commit` opt-out for the write path** (#22). A vault can set
  `auto_commit: false` in `.daftari/config.yaml` to suppress the auto-commit
  step on `vault_write` / `vault_append` / `vault_promote` / `vault_deprecate`.
  The file is still written, indexed, and provenance-logged; only the git
  commit is skipped, so the caller owns staging and committing. This lets a
  vault nested inside a larger repo defer to that repo's branching and PR
  workflow. `WriteResult` now reports `committed` (boolean) and `commit` is
  `null` when no commit was made. Backward compatible — `auto_commit` defaults
  to `true`, the behavior shipped today.

### Fixed

- The scaffolded `.gitignore` now excludes `.daftari/curation-log.jsonl`. The
  provenance log was always documented as local, git-ignored audit state but
  was never actually listed in the ignore file. This matters most for
  `auto_commit: false` vaults nested in a larger repo, where the unignored log
  would otherwise churn the host repo's `git status` on every write.

## [1.4.0] - 2026-05-18

### Added

- **Config-driven schema extensions for domain-specific frontmatter** (#19).
  Vaults can declare typed extension fields in a `schema_extensions` block of
  `.daftari/config.yaml` — `string` (with an optional regex `pattern`), `date`,
  `number`, `boolean`, `array<string>`, and `enum`, each optionally `required`
  or carrying a `default`. Extensions participate in `vault_write` validation
  and serialize after the built-in fields in stable config declaration order.
  Malformed extension declarations fail config load loudly, matching the RBAC
  config contract. Backward compatible — vaults with no `schema_extensions`
  block behave exactly as before. See
  [docs/schema-extensions.md](docs/schema-extensions.md).

## [1.3.0] - 2026-05-18

### Added

- **Optimistic concurrency for the write path** — `vault_read` now returns a
  `version` token (the SHA-256 of the file as read), and the write tools
  (`vault_write`, `vault_append`, `vault_promote`, `vault_deprecate`) accept an
  optional `base_version`. When supplied, the server re-hashes the file inside
  the write lock and rejects the write with a `stale write:` error if it no
  longer matches — closing the stale-write gap the file lock could not catch.
  Rejected stale writes are recorded in the provenance log with a
  `rejected_stale` action. Omitting `base_version` preserves last-write-wins
  behavior, so the change is fully backward compatible. (#14)

## [1.2.0] - 2026-05-17

### Added

- **Structured epistemic-surface fields** — `questions_answered` and
  `questions_raised` are now optional frontmatter array fields, making the
  Questions Answered / Questions Raised convention tool-queryable. `vault_index`
  gains a `has_unanswered` filter and returns each document's questions;
  `vault_lint` gains a sixth check, `unansweredQuestions`, that flags a question
  raised in one document but answered in none. Additive and optional — vaults
  and callers without the fields are unaffected, and the `--init` scaffold now
  seeds the fields in its example documents. (#15)
- **`docs/worked-example.md`** — a three-write walkthrough showing compilation
  over retrieval: one document maturing from draft to canonical, contrasted
  with RAG. (#13)
- **`docs/curation-workflow.md`** — the reference curation loop: how an agent
  should act on `vault_lint` output instead of letting it accumulate. (#17)
- **README "Search internals" section** — documents the hybrid-search embedding
  model (`all-MiniLM-L6-v2`, 384-dim, run locally with no embedding API and no
  API key) and the BM25-only fallback. (#11)
- **README etymology line** — "Daftari" glossed from دفتر. (#12)

### Changed

- **Layer 3 reframed from "write arbitration" to "write safety"** — the README
  and architecture doc now describe what is shipped (single-writer-per-file
  safety) rather than implying multi-agent write coordination. Adds a "Known
  limitations" subsection and points at optimistic concurrency (#14) as the v2
  direction. (#16)

## [1.1.1] - 2026-05-17

### Fixed

- **CLI silently no-opped when invoked via a symlink** — `npx daftari`,
  `npm i -g daftari`, and any `node_modules/.bin/daftari` shim launch the CLI
  through a symlinked launcher. The entry-point guard compared `import.meta.url`
  against `process.argv[1]` without resolving symlinks, so the check never
  matched and the installed `daftari` command exited 0 having done nothing —
  the `npx daftari --init` Quickstart included. Both sides are now resolved
  with `realpathSync` before comparing.

## [1.1.0] - 2026-05-17

### Added

- **Inline decay surfacing** — `vault_read` and `vault_search` responses now
  carry a `decay` assessment, so an agent cannot silently trust knowledge that
  has decayed. A new `computeDecay` derives a per-document decay state —
  `deprecated`, `warn`, or `aging` — from frontmatter; a warning banner is
  rendered for `warn` and `deprecated` documents and withheld for healthy or
  merely `aging` ones (the scarcity rule). The banner is never written into a
  document's body. The search index gained `ttl_days`, `created`, and
  `superseded_by` columns, with schema versioning to rebuild on a schema change.

## [1.0.0] - 2026-05-17

First public release. Daftari is an MCP server that exposes a curated markdown
vault to AI agents, exposing 13 tools over stdio.

### Added

- **Read path** — `vault_read`, `vault_index`, and `vault_status` for reading
  documents, listing them by collection/status/domain/tags, and reporting vault
  health (file counts, invalid frontmatter, staleness distribution, unresolved
  tensions, recent writes).
- **Hybrid search** — `vault_search`, `vault_search_related`, and
  `vault_reindex`. BM25 lexical ranking fused with vector semantic similarity,
  with tunable weights and graceful fallback to lexical-only when embeddings are
  unavailable.
- **Write path** — `vault_write`, `vault_append`, `vault_promote`, and
  `vault_deprecate`. File-level write locks (SQLite-backed, 60-second TTL),
  every write auto-committed to git, and a provenance log of who wrote what.
- **Curation engine** — `vault_lint`, `vault_tension_log`, and
  `vault_provenance`. Advisory TTL-based staleness detection, contradiction
  (tension) logging, lint checks, and per-document write history. Reports
  problems; does not auto-fix.
- **Config-driven RBAC** — roles and per-collection read/write/promote
  permissions declared in `.daftari/config.yaml`; enforced across every tool.
  Unknown or absent roles fall back to a deny-all guest.
- **CLI** — `daftari --init` scaffolds a new vault (collections, RBAC config,
  example documents, git history, search index); `daftari --vault` serves it.
- 160 tests covering all 13 tools and their supporting modules.

[1.5.1]: https://github.com/mavaali/daftari/releases/tag/v1.5.1
[1.4.0]: https://github.com/mavaali/daftari/releases/tag/v1.4.0
[1.1.1]: https://github.com/mavaali/daftari/releases/tag/v1.1.1
[1.1.0]: https://github.com/mavaali/daftari/releases/tag/v1.1.0
[1.0.0]: https://github.com/mavaali/daftari/releases/tag/v1.0.0
