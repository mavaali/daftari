# Multi-Vault How-To

How to run one agent across several Daftari vaults using `daftari-router`.

> **Status:** The router ships in `packages/router/`. Phase 1 covers fan-out
> read/search, per-vault dispatch for writes, and a 14-tool surface. See
> [packages/router/README.md](../packages/router/README.md) for the full
> reference; this guide is the task-oriented walkthrough.

---

## When to use the router

Use it when you have **more than one vault** and want a **single MCP
connection** that spans them — e.g. a `devops` vault for runbooks, a `product`
vault for specs, an `intel` vault for competitive notes. The router boots one
`daftari` child per vault and routes each tool call to the right one (or fans
out and merges).

If you only have one vault, you don't need the router — point your MCP client
at `daftari` directly.

---

## Quick start (3 steps)

```bash
# 1. Initialize each vault (skip any that already exist)
npx daftari --init ~/vaults/devops
npx daftari --init ~/vaults/product
npx daftari --init ~/vaults/intel

# 2. Write vaults.yaml
cat > ~/vaults.yaml <<'EOF'
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
EOF

# 3. Start the router
cd path/to/daftari/packages/router
npm install && npm run build
node dist/cli.js --config ~/vaults.yaml
```

The router now speaks MCP over stdio. Point any MCP client at this command
instead of `daftari` and the client sees a single vault surface that secretly
spans three.

---

## Mental model

```
                MCP client (Claude / agent)
                            │
                            ▼
                    daftari-router        ← one process, one MCP surface
                   ┌────┬────┬────┐
                   ▼    ▼    ▼
                devops product intel     ← one daftari child per vault
```

Every tool the router exposes is one of two shapes:

| Shape | Behavior | Examples |
|---|---|---|
| **vault-required** | Errors without a `vault` arg or vault-prefixed path | `vault_read`, `vault_write`, `vault_append`, `vault_promote`, `vault_deprecate`, `vault_tension_log`, `vault_search_related`, `vault_provenance` |
| **fan-out** | No `vault` arg → run against every child, merge results. With `vault` arg (or a vault-prefixed `path`) → run against one | `vault_search`, `vault_index`, `vault_lint`, `vault_status`, `vault_themes`, `vault_reindex` |

Writes never fan out. If you don't specify a vault for a write, it's rejected.
That's deliberate — silent multi-write is the kind of footgun the router
refuses to enable.

---

## Connect from Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "daftari": {
      "command": "node",
      "args": [
        "/absolute/path/to/daftari/packages/router/dist/cli.js",
        "--config",
        "/absolute/path/to/vaults.yaml"
      ]
    }
  }
}
```

Use absolute paths. Restart Claude Desktop. The 14 `vault_*` tools appear and
each one transparently routes to the right child.

---

## Common patterns

### Pattern 1 — Search everywhere at once

```jsonc
// vault_search (no vault arg)
{ "query": "trust boundary data governance" }
```

The router fans the query to every child, merges by score, and returns ranked
hits with a `vault:` field on each so the agent knows which vault it came from.

**Caveat:** merge assumes all vaults use the same embedding model. If you mix
`local-minilm` (384-dim) and `openai-3-small` (1536-dim), rankings will be
incoherent. Use one model across all vaults in Phase 1.

### Pattern 2 — Search a specific vault

Two ways to scope to one vault. Both work:

```jsonc
// Option A: explicit vault arg
{ "query": "k8s autoscaler", "vault": "devops" }

// Option B: not applicable for vault_search (no path argument)
```

For tools that take a `path`, you can also use a **vault-prefixed path**:

```jsonc
// vault_read
{ "path": "devops:runbooks/k8s-autoscaler.md", "agent": "agent:claude-code" }
```

The router strips the `devops:` prefix before forwarding to the child. Vault
names cannot contain `:`, and document paths cannot start with a segment that
collides with a vault name followed by `:`.

### Pattern 3 — Write to a specific vault

Writes are vault-required. Pick one:

```jsonc
// vault_write — with explicit vault arg
{
  "vault": "product",
  "path": "specs/onboarding-v2.md",
  "agent": "agent:claude-code",
  "frontmatter": { /* … */ },
  "body": "# Onboarding v2\n\n…"
}
```

```jsonc
// vault_write — with vault-prefixed path
{
  "path": "product:specs/onboarding-v2.md",
  "agent": "agent:claude-code",
  "frontmatter": { /* … */ },
  "body": "# Onboarding v2\n\n…"
}
```

Tools whose path argument isn't called `path` (`vault_provenance` uses
`filePath`; `vault_tension_log` uses `sourceA`/`sourceB`) require the
explicit `vault:` arg — the prefix shorthand doesn't apply.

### Pattern 4 — Inspect health across all vaults

```jsonc
// vault_status (no vault arg)
{}
```

Returns an aggregate health roll-up plus a per-vault breakdown
(`{ vaults: { devops: {...}, product: {...}, intel: {...} } }`). Same shape
for `vault_lint`, `vault_index`, `vault_themes`.

### Pattern 5 — Reindex one vault, not all

```jsonc
// vault_reindex
{ "vault": "devops" }
```

Without `vault`, every child reindexes. With `vault`, only that one. Useful
when one vault changed under the router (e.g. you pulled new docs into
`~/vaults/devops` from git outside the agent loop).

---

## Tool reference (one line each)

| Tool | No `vault` | With `vault` |
|---|---|---|
| `vault_read` | error | reads from named vault |
| `vault_write` | error | writes to that vault |
| `vault_append` | error | appends to that vault |
| `vault_promote` | error | promotes in that vault |
| `vault_deprecate` | error | deprecates in that vault |
| `vault_tension_log` | error | logs in that vault |
| `vault_provenance` | error | provenance from that vault |
| `vault_search_related` | error | related-docs in that vault |
| `vault_search` | fan-out + merge by score | search only that vault |
| `vault_index` | aggregate across all | filtered to that vault |
| `vault_status` | aggregate + per-vault | health of that vault |
| `vault_lint` | aggregate + per-vault | lint that vault |
| `vault_themes` | merged across all | themes from that vault |
| `vault_reindex` | reindex all | reindex that vault |

---

## Adding a vault later

1. `npx daftari --init ~/vaults/<newvault>`
2. Append a block to `vaults.yaml`:
   ```yaml
   vaults:
     newvault:
       path: ~/vaults/newvault
       user: agent
       role: admin
       description: "What this vault is for"
   ```
3. Restart the router (SIGINT, then re-run). Phase 1 has no hot-reload.

---

## Removing a vault

1. Stop the router.
2. Delete the vault's block from `vaults.yaml`.
3. Restart. The child process is no longer spawned. The vault's files are
   untouched — delete the directory only if you mean it.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `error: vault required` | Called a vault-required tool without `vault:` arg or prefix | Pass `vault: "name"` or use `name:path/to/doc.md` |
| Search returns hits from only one vault | One vault is empty, or its child crashed | Check the router's stderr for child-startup failures |
| Search rankings look wrong across vaults | Mixed embedding models | Use one embedding provider across all vaults in Phase 1 |
| `vault not found: foo` | Typo, or vault missing from `vaults.yaml` | Compare the arg to the YAML keys |
| Router exits immediately on start | A child's daftari version is too old | Each child needs daftari >= 1.10.0 |
| `tool catalog mismatch` warning | Children expose different tool sets | Match daftari versions across all vaults |

---

## Caveats (Phase 1)

- **One embedding model across all vaults** — search merge does not normalize
  cross-model scores.
- **Tool catalog seeded from the first child** — if vaults expose different
  daftari versions, the router only surfaces the first child's tools.
- **Vault names cannot contain `:`** — reserved as the path-prefix separator.
- **Writes never fan out** — ambiguous writes are silently rejected.
- **No auth layer** — the router inherits each child's RBAC. Run on trusted
  infrastructure.
- **No hot-reload of `vaults.yaml`** — restart the router after edits.
- **No child auto-restart** — if a child crashes, the router stays up but
  that vault is offline until restart.

---

## Agent quick reference

If you're an agent reading this doc to learn the surface, this is what you
need to know in one block:

```
- Every tool may take an optional `vault: <name>` arg.
- Write/curate tools (write, append, promote, deprecate, tension_log) REQUIRE
  a vault. Pass `vault: "<name>"` or prefix the path: `<name>:path/to/doc.md`.
- Read/lookup tools that take a path (read, search_related, provenance) also
  require a vault; same two ways to supply it.
- `vault_search` with no `vault` arg fans out across all vaults and merges
  results by score. Each hit carries a `vault:` field.
- `vault_status`, `vault_lint`, `vault_index`, `vault_themes` aggregate
  across vaults when called with no `vault` arg.
- `vault_reindex` with no `vault` arg reindexes every vault. Slow — only do
  this if you mean it.
- When a tool errors with "vault required", retry with `vault:` filled in.
- Vault names appear in `vault_status` output under `vaults.{name}`. Use
  that as the source of truth for which vault names are valid.
```

---

## Next

- [packages/router/README.md](../packages/router/README.md) — reference
  documentation, architecture diagram, contributor notes.
- [getting-started.md](getting-started.md) — single-vault walkthrough.
- [curation-workflow.md](curation-workflow.md) — the lint → promote →
  deprecate loop, which works the same per-vault under the router.
