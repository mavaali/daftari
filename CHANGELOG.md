# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[1.1.1]: https://github.com/mavaali/daftari/releases/tag/v1.1.1
[1.1.0]: https://github.com/mavaali/daftari/releases/tag/v1.1.0
[1.0.0]: https://github.com/mavaali/daftari/releases/tag/v1.0.0
