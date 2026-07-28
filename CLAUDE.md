# CLAUDE.md — Daftari

## What is this
Daftari is an MCP server that exposes a curated markdown vault to AI agents. TypeScript, Node.js.

## Code map
Concepts and layer boundaries: docs/architecture.md. Where things live:
- `src/tools/` — the vault_* MCP tool handlers
- `src/frontmatter/` — markdown + YAML frontmatter parsing and schema validation
- `src/storage/` — local file storage, the SQLite index, pluggable sync backends (#6)
- `src/search/` — hybrid search: FTS5 BM25 + sqlite-vec embeddings
- `src/curation/` — lint, decay, the edge graph, staleness, staged actions
- `src/access/` — RBAC and file-level write locks
- `src/lifecycle/` — the per-vault process lock
- `src/court/` — Tension Court docket (operator-only, no access context)
- `src/sleep/` — circadian maintenance cycle (`daftari sleep`)
- `src/consolidate/` — cortex consolidation loop (`daftari consolidate`)
- `src/witness/` — per-principal track records
- `src/asof/` — belief archaeology over git history (`daftari asof`)
- `src/audit/` — doc-to-code coherence audit (`daftari audit`)
- `src/anchors/` — citation-anchor pin grammar and the shared JIT classifier (used by vault_read, `daftari audit`, and vault_lint)
- `src/eval/` — vault quality eval: question generation + LLM judging (`daftari eval`)
- `src/interview/` — principal interview: question sheet from tensions/staleness/open questions, verbatim transcript (`daftari interview`)
- `src/backfill/`, `src/import/`, `src/okf/` — adoption paths: metadata backfill, foreign-vault import, OKF export/import
- `src/serve/` — server mode over Streamable HTTP (`daftari serve`); `src/sync/` — push/restore against storage backends
- `src/hooks/` — vault-supplied hook module loading
- `src/themes/` — clustering primitives for vault_themes
- `src/utils/` — config.yaml loading, git plumbing, paths, hashing

Entrypoints: `src/index.ts` (stdio MCP entry), `src/server.ts` (MCP server wiring), `src/cli.ts` (CLI).

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
- The staged-action queue's risk score is derived/ordinal, computed fresh on every `vault_lint` read, never stored as a `risk` field or column — the same posture `derives_from` strength takes. `vault_ratify`'s `ids` batch is an explicit, capped id list (`BATCH_RATIFY_MAX` = 20); the parameter shape has no threshold and no "all pending" sentinel, so auto-approval-by-score cannot be expressed. Proposal records carry the authenticated stager (`staged_by_principal`, from `access.user`) alongside the unauthenticated, caller-claimed `proposed_by` display string — the witness and the risk score's W term key on the former when present. Each decision record additionally carries a non-authoritative `risk_at_decision` snapshot (JSONL-only, never read for ordering) so the risk score's own predictive-power kill condition is evaluable later. See docs/superpowers/specs/2026-07-26-risk-triaged-ratification-design.md.
- Citation-anchor pins (`describes` entries suffixed `#L<start>-<end>@<sha>`) are advisory, annotate-only — a `moved`/`missing` pin never invalidates, demotes, or rewrites a doc, and an intact pin softens decay's banner copy but never extends the TTL clock. The read-path check is batched git plumbing only (one `hash-object` invocation per referenced repo per read, not per pin) and silent on failure (a classifier error drops that entry, never fails the read). Configuring `code_repos` makes blob-level facts about those repos (path existence, blob-match, relocated line numbers) visible to every reader whose role carries the `code_repo_visibility` grant (default off) — see docs/superpowers/specs/2026-07-26-citation-anchors-jit-verification-design.md.

## Labeling
- [DATA] for values read from files or the index
- [TRAINING] for knowledge from the model's training
- [HYPOTHESIS] for inferences. State the kill condition.

## Style
- No classes. Functions and types.
- Error handling: return Result<T, Error> patterns, do not throw from tool handlers.
- Tests mirror src/ structure. Every tool gets a test file.
