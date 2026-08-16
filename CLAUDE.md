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
- `src/fence/` — read-path fence: nonce-delimited framing for ingested material, plus the instruction-shaped-text detector (no call sites yet)
- `src/canary/` — three-arm falsification harness for the fence (`daftari canary`)
- `src/court/` — Tension Court docket (operator-only, no access context)
- `src/sleep/` — circadian maintenance cycle (`daftari sleep`)
- `src/consolidate/` — cortex consolidation loop (`daftari consolidate`)
- `src/witness/` — per-principal track records
- `src/asof/` — belief archaeology over git history (`daftari asof`)
- `src/audit/` — doc-to-code coherence audit (`daftari audit`)
- `src/eval/` — vault quality eval: question generation + LLM judging (`daftari eval`)
- `src/interview/` — principal interview: question sheet from tensions/staleness/open questions, verbatim transcript (`daftari interview`)
- `src/backfill/`, `src/import/`, `src/okf/` — adoption paths: metadata backfill, foreign-vault import, OKF export/import
- `src/serve/` — server mode over Streamable HTTP (`daftari serve`); `src/sync/` — push/restore against storage backends
- `src/attest/` — signed attestation bundles (`daftari attest`): operator-key Ed25519 over a manifest derived from markdown + git; operator-only, never MCP-exposed (#298)
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
- MCP: the server speaks the 2026-07-28 stateless revision (v2 SDK, `@modelcontextprotocol/server`). `daftari serve` resolves identity per request from the bearer — no sessions — and refuses 2025-era traffic by default; stdio serves both eras, so lagging clients use stdio, or `daftari serve --legacy-http` (#366, temporary opt-in with a removal criterion) answers them via the SDK's stateless legacy fallback. `vault_ratify` without a decision elicits an approve/reject form (reject preselected) with HMAC-signed opaque state. The maintenance passes stay CLI-only until the Tasks extension has a TS SDK runtime. See docs/superpowers/specs/2026-07-26-mcp-2026-07-28-readiness-design.md.
- Only one daftari process may hold a vault at a time. `.daftari/process.lock` is the per-vault process lock, and it records the holder's mode (stdio or serve). Live-holder precedence favors the durable tenant (2026-07-20 spec, Decision 4): stdio finding a live stdio holder SIGTERMs it and waits up to 3 seconds before taking over (the original single-user convenience — the only implicit live takeover); stdio finding a live `daftari serve` REFUSES to start; a new serve refuses against ANY live holder unless started with `--takeover`. Stale locks (dead PID, or PID recycled) are overwritten silently in every mode. The lockfile is ephemeral — never check it in.
- `.daftari/process.lock` (single-process admission control) and `.daftari/locks.db` (per-mutation file lease, `src/access/locks.ts`) are deliberately separate mechanisms that coexist rather than one replacing the other; multi-user writing happens through one `daftari serve` process with per-request identity, and writing to one vault from multiple concurrent *processes* stays out of scope. See docs/superpowers/plans/2026-08-08-multiuser-contested-beliefs-slice3-design.md.
- Federation (#297, `src/federation/`): a mount exposes documents, not vault state — tensions, edges, provenance, positions, lint, and themes never cross the boundary. Nothing is ever written (or WAL-opened) under a referenced root; a mount takes no process lock. Referenced-vault grants live in the *referenced* vault's config (`federation.principals`), keyed by authenticated principal, deny-all-guest default. `alias:path` dispatch matches declared aliases only; collision safety is enforced (mount-time scan + write-tool refusal), never assumed from filename rules. stdio-only in v1 — `daftari serve` refuses a mounts block. See docs/superpowers/specs/2026-08-15-cross-vault-federation-design.md.

## Model defaults
- The session model defaults to Sonnet (`.claude/settings.json`), with Opus as the automatic fallback on overload/unavailability. This applies uniformly — Claude Code has no plan-mode-specific model override other than the built-in `opusplan` alias (Opus-to-plan Sonnet-to-execute), and no automatic downgrade-on-quota-exhaustion mechanism; a model unavailable mid-session must be switched by hand with `/model`.
- For architecture and design work — anything crossing a module boundary, touching ACL/visibility semantics, or introducing a new concept — delegate to the `strategist` subagent (`.claude/agents/strategist.md`), which runs on Fable. It is read-only; it returns a recommendation, the calling session writes the code.
- If Fable capacity/credits are exhausted, edit `strategist.md`'s `model:` field to `opus` until they reset. There's no built-in fallback for this — it's a manual switch.

## Labeling
- [DATA] for values read from files or the index
- [TRAINING] for knowledge from the model's training
- [HYPOTHESIS] for inferences. State the kill condition.

## Style
- No classes. Functions and types.
- Error handling: return Result<T, Error> patterns, do not throw from tool handlers.
- Tests mirror src/ structure. Every tool gets a test file.
