# daftari-router

Multi-vault MCP router — fan out across N Daftari vaults from one MCP connection.

## Quick start

```bash
npm i -g daftari daftari-router
daftari-router --config vaults.yaml
```

The router speaks MCP over stdio. Point any MCP client (Claude Code, Claude Desktop, custom LangGraph agent) at the `daftari-router` binary instead of `daftari`, and it transparently spans multiple vaults.

## Example vaults.yaml

```yaml
router:
  transport: stdio

vaults:
  devops:
    path: ~/vaults/devops
    user: agent
    role: admin
    description: "Runbooks, incident playbooks, infra architecture"
  product:
    path: ~/vaults/product
    user: agent
    role: writer
    description: "Product specs, roadmap decisions, customer research"
  intel:
    path: ~/vaults/intel
    user: agent
    role: reader
    description: "Competitive analysis, market positioning, pricing"

defaults:
  search_limit: 10
```

## Tool semantics

| Tool | No `vault` arg | With `vault` arg |
|---|---|---|
| `vault_read` | error: requires vault | reads from named vault |
| `vault_index` | aggregates all vaults | filters to that vault |
| `vault_status` | aggregate health + per-vault breakdown | health of that vault |
| `vault_search` | fan out + merge by score | search only that vault |
| `vault_search_related` | error: path is vault-specific | finds related docs in that vault |
| `vault_reindex` | reindexes all | reindexes that vault |
| `vault_write` / `vault_append` / `vault_promote` / `vault_deprecate` | error: requires vault | writes to that vault |
| `vault_tension_log` | error: requires vault | logs in that vault |
| `vault_lint` | lints all + per-vault breakdown | lints that vault |
| `vault_provenance` | error: path is vault-specific | provenance in that vault |
| `vault_themes` | merges themes from all vaults | themes from that vault |

For paths, you can use either explicit `vault: "name"` arg or vault-prefixed paths like `devops:runbooks/k8s.md` — the router strips the prefix before forwarding to the child.

## Architecture

```
                   ┌──────────────────┐
                   │   MCP Client     │
                   │ (Claude, agent)  │
                   └────────┬─────────┘
                            │ stdio JSON-RPC
                            ▼
                   ┌──────────────────┐
                   │ daftari-router   │
                   │  ─ catalog       │
                   │  ─ dispatch      │
                   │  ─ fan-out merge │
                   └──┬───────┬───────┘
                      │       │      stdio JSON-RPC
            ┌─────────┘       └──────────┐
            ▼                              ▼
     ┌─────────────┐                ┌─────────────┐
     │  daftari    │                │  daftari    │
     │  (devops)   │       ...      │  (intel)    │
     └─────────────┘                └─────────────┘
```

## Requirements

- Node.js >= 20
- `daftari` >= 1.10.0 installed and on `PATH` (or pass `--daftari-bin <path>`)
- Each vault directory initialized with `daftari --init`

## Caveats

- **Tool catalog is seeded from the first child's `tools/list`.** If vaults run different daftari versions exposing different tools, the router only exposes the first vault's surface. Mismatches are logged to stderr at startup. Run matched versions across vaults.
- **Vault names cannot contain `:`** — reserved as the path-prefix separator (e.g., `devops:runbooks/k8s.md`).
- **Document paths starting with `vault-name:`** collide with the prefix parser. Avoid colons in the first path segment.
- **v1 search merge assumes homogeneous embedding models** across vaults. Mixing models produces an incoherent ranking. A future Phase 2 normalization pass will fix this.
- **Write tools never fan out.** You must specify which vault to write to, either via `vault: "name"` arg or a vault-prefixed path. Ambiguous writes are silently rejected as a safety measure.
- **No auth layer** — the router inherits each child vault's RBAC. Run on trusted infrastructure.

## Running the integration tests

The integration test boots real `daftari` subprocesses against fixture vaults at `test/fixtures/vault-{a,b}`. By default it spawns the daftari CLI at `<repo-root>/dist/cli.js`. Override with the `DAFTARI_BIN` env var to test against an installed version:

```bash
DAFTARI_BIN=/usr/local/bin/daftari npm test
```

## What's in Phase 1

- Spawn N children, fan-out search, per-vault dispatch
- 14-tool surface (read/search/write/curation/themes)
- Vault-prefixed path convention
- Graceful shutdown on SIGINT/SIGTERM
- Per-child handshake timeout

## What's NOT in Phase 1

- Cross-vault lint (`crossVaultTension`, `crossVaultBrokenRef`, `crossVaultStaleChain`)
- `vault_discover` tool for write-target suggestion
- HTTP/SSE transport
- Auth (API key, OAuth)
- Score normalization across heterogeneous embedding models
- Child crash auto-restart

See `docs/superpowers/plans/2026-05-29-multivault-router-phase1.md` (in the repo root) for the implementation plan.
