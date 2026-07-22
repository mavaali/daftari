# CLAUDE.md — Daftari

## What is this
Daftari is an MCP server that exposes a curated markdown vault to AI agents. TypeScript, Node.js.

## Build and test
- `npm run build` — compile TypeScript
- `npm test` — run tests with vitest
- `npm run dev` — run server in watch mode against test/fixtures/sample-vault

## Key decisions
- All files are markdown with YAML frontmatter. Frontmatter is the metadata layer. Do not introduce a separate metadata format.
- SQLite (better-sqlite3) for the index/search/ACL store. Not a separate database server. The .daftari/index.db file is ephemeral — it can be rebuilt from the markdown files at any time.
- Git is the version control layer. Every write operation auto-commits. Do not build a separate versioning system.
- Write locks are file-level, SQLite-backed, with a 60-second TTL. If a lock expires, it's released automatically.
- The curation engine is advisory. vault_lint reports problems. It does not auto-fix. vault_tension_log records tensions. It does not resolve them.
- RBAC is config-driven (.daftari/config.yaml). Do not build a user management system. Users/roles are declared in config.
- Tension/edge visibility: omission over redaction, no existence leak. Doc lists never name docs in unreadable collections; hidden-blast remainders are reported coarsened (none/some/many), never as exact counts — small cells disclose linked existence. Vault-global lint aggregates stay unfiltered by design. See docs/superpowers/specs/2026-07-14-edge-graph-existence-disclosure-design.md.
- The Tension Court is an operator-only surface. Court/docket code never takes an access context. Exposing any court surface via MCP requires revisiting the 2026-07-14 edge-graph spec first.
- Storage backends (#6) are dumb sync targets — `get/put/list/delete` over opaque keys. The local git working copy is canonical; backends never understand markdown, git, or locks; index/locks stay local and never sync. See spec 2026-07-20 Decision 3.
- Only one daftari process may hold a vault at a time. `.daftari/process.lock` is the per-vault process lock, and it records the holder's mode (stdio or serve). Live-holder precedence favors the durable tenant (2026-07-20 spec, Decision 4): stdio finding a live stdio holder SIGTERMs it and waits up to 3 seconds before taking over (the original single-user convenience — the only implicit live takeover); stdio finding a live `daftari serve` REFUSES to start; a new serve refuses against ANY live holder unless started with `--takeover`. Stale locks (dead PID, or PID recycled) are overwritten silently in every mode. The lockfile is ephemeral — never check it in.

## Labeling
- [DATA] for values read from files or the index
- [TRAINING] for knowledge from the model's training
- [HYPOTHESIS] for inferences. State the kill condition.

## Style
- No classes. Functions and types.
- Error handling: return Result<T, Error> patterns, do not throw from tool handlers.
- Tests mirror src/ structure. Every tool gets a test file.
