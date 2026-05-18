# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
