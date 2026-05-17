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

## Labeling
- [DATA] for values read from files or the index
- [TRAINING] for knowledge from the model's training
- [HYPOTHESIS] for inferences. State the kill condition.

## Style
- No classes. Functions and types.
- Error handling: return Result<T, Error> patterns, do not throw from tool handlers.
- Tests mirror src/ structure. Every tool gets a test file.
