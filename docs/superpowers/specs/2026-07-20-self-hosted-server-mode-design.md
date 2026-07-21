# Self-hosted server mode — design

2026-07-20. Status: **proposed — awaiting Mihir's review; implementation not
started.**
Issues: #5 (server mode), #7 (OAuth), #6 (pluggable storage). The three are
one deployment story and their load-bearing decisions interlock, so they are
settled together in one document, then implemented in sequence.

## Why

v1 is a per-user stdio process: each user launches `daftari --vault … --user
… --role …`, and RBAC binds to that process for its lifetime. On a shared
filesystem that already delivers multi-user. What it cannot deliver is a
team's one always-on instance — no per-user local setup, no shared-filesystem
assumption. That is the self-hosted story: the software becomes deployable;
the project hosts nothing (explicitly NOT a managed SaaS).

The blocking design questions, from the issues:

1. Which network transport (#5)?
2. Per-connection identity — the server runs as ONE identity today (#5, #7).
3. Git provenance under object storage — CLAUDE.md: "Git is the version
   control layer… do not build a separate versioning system"; you cannot
   `git log` an S3 bucket (#6).

## Decision 1 — transport: Streamable HTTP, stdio stays the default

`daftari serve --vault <path> [--port <n>] [--bind <addr>]` starts server
mode. Plain `daftari` keeps today's stdio behavior unchanged — server mode is
a separate subcommand, not a flag on the default path, so the desktop-extension
flow cannot drift into it by accident.

Transport is **Streamable HTTP** (the current MCP spec), using the SDK's
`StreamableHTTPServerTransport` — already present in the pinned
`@modelcontextprotocol/sdk` (^1.29.0). The older HTTP+SSE transport is
deprecated in the spec; we do not ship it. Clients that cannot speak
Streamable HTTP can keep using stdio.

Bind address defaults to `127.0.0.1`. Binding to a non-loopback address with
no authentication configured is a **startup error**, not a warning — the same
fail-loud posture as a malformed RBAC config, and for the same reason: a
permission system that silently serves an open network socket is worse than
one that refuses to start.

## Decision 2 — identity is per MCP session, resolved at session open

The mechanical insight that keeps this small: `createServer(vaultRoot,
access, toolsConfig)` already parameterizes the access context — the whole
tool registry closes over whatever identity it is given. Server mode
therefore creates **one `Server` instance per MCP session**, bound to the
identity resolved when the session opens. No tool handler changes; every
RBAC and existence-disclosure invariant (omission over redaction, no
existence leak, the 2026-07-14 spec) is enforced per access context and is
transport-independent by construction.

Identity resolution is phased:

### Phase 1 (ships with #5): static bearer tokens, config-declared

```yaml
server:
  auth:
    tokens:
      - env: DAFTARI_TOKEN_ALICE   # secret value comes from this env var
        user: human:alice
        role: analyst
      - env: DAFTARI_TOKEN_ETL
        user: agent:etl
        role: curation-loop
```

- Token **values never appear in config**. `.daftari/config.yaml` lives in
  the vault, which is a git repo and may be synced or committed; config
  declares the *mapping*, the environment carries the secret. An entry whose
  env var is unset at startup fails loud.
- This is RBAC staying config-driven (the house rule): users and roles are
  declared, not managed. No signup, no token minting endpoint, no state.
- Comparison is constant-time (`crypto.timingSafeEqual`).
- **Once auth is configured, a missing or unmatched token is REJECTED at
  session open (401) — on every bind, loopback included.** It is never
  downgraded to guest: a silent guest session over a network socket is a
  probe surface (it confirms the server exists and advertises the tool
  list), and the fail-loud posture applies per session exactly as it does at
  startup. The deny-all guest exists in server mode only in the one
  configuration where no auth is declared at all — which the startup rule
  restricts to loopback binds (the dev-convenience case, matching stdio's
  guest fallback).

### Phase 2 (#7): OAuth 2.1, layered on, not replacing the model

Per the MCP authorization spec, `daftari serve` becomes an OAuth 2.1
**resource server**: it validates bearer JWTs against the IdP's JWKS
(`server.auth.oauth.jwks_uri`, `issuer`, `audience`) and never issues or
stores credentials itself. Identity→role mapping stays declarative in config,
keyed on the token's subject claim:

```yaml
server:
  auth:
    oauth:
      issuer: https://idp.example.com
      audience: daftari
      jwks_uri: https://idp.example.com/.well-known/jwks.json
      subjects:
        "alice@example.com": { user: "human:alice", role: analyst }
```

JWKS validation (not introspection): it keeps the server stateless and
offline-tolerant after key fetch, and matches the self-hosted posture — the
org's IdP is the source of truth, daftari only verifies. A subject absent
from the mapping is the deny-all guest, never an implicit default role.

Static tokens and OAuth can coexist (agents commonly get static tokens while
humans come through the IdP); either block may be omitted. stdio mode is
untouched by all of this — `--user`/`--role` remains its identity model.

## Decision 3 (#6) — provenance: option (a), formalized

**The local git working copy is canonical; object storage is durable backing.**

The server always operates on a local working copy — reads, writes,
auto-commits, locks, and the SQLite index all behave exactly as today. The
storage backend (ADLS/S3/GCS) enters as a **sync target**: the working copy
pushes to it (git remote where the backend supports it, else an rsync-shaped
object sync of the tree + git dir). `git log` works, hand-editing works,
CLAUDE.md's "git is the version control layer" survives intact. Option (b) —
a separate degraded provenance mechanism for cloud vaults — is rejected, as
the issue anticipated.

Consequences that fall out:

- The backend interface is minimal and dumb: `get/put/list/delete` over
  opaque keys. No backend needs to understand markdown, frontmatter, git, or
  locks.
- `.daftari/index.db` stays local and ephemeral (rebuildable), never synced.
- Write locks stay local-SQLite. This is sound because the **process lock
  already enforces one daftari per vault** (`.daftari/process.lock`); the
  single-instance assumption is today's invariant, and server mode keeps it —
  one always-on instance IS the deployment model. Multi-instance/HA would
  need shared locks and is explicitly out of scope until someone needs it.

## Sequencing

1. **#5** — `daftari serve` + per-session identity + phase-1 token auth.
   Independently useful; unblocks #7.
2. **#7** — the OAuth block. Config + a JWKS validator; no transport work.
3. **#6** — storage backends, last. Biggest surface, least urgent (a
   self-hosted box with a disk already works end-to-end after #5/#7).

Each lands as its own PR against this spec.

## Out of scope

- Managed/multi-tenant SaaS, billing, tenancy isolation.
- Multi-instance deployments and shared locking (single-instance invariant
  holds; revisit only with a concrete need).
- Any Tension Court surface over the network — court/docket code never takes
  an access context, and exposing a court surface via ANY transport still
  requires revisiting the 2026-07-14 edge-graph spec first.
- Per-user rate limiting / quotas.
- CRDT or merge-based concurrent editing (#1 stays the parking lot).

## Test posture

Server mode is testable without a network flake surface: bind to an
ephemeral loopback port, drive it with the SDK's Streamable HTTP client
transport in-process. The cases that matter: two sessions with different
tokens see different RBAC vantages over the same vault (the existence-
disclosure fixtures from test/tools reused verbatim); with auth configured a
bad/absent token is rejected at session open (401) on every bind; with no
auth on loopback an unauthenticated session is the deny-all guest;
non-loopback bind without auth refuses to start; stdio mode's behavior is
byte-identical before and after.
