# Deployment and access

Daftari has one canonical write boundary: one process owns one writable vault.
Choose how clients reach that process, then configure identity, mounts, and
backups around it.

## Choose an operating mode

| Need | Mode | Command |
|---|---|---|
| One local MCP client | stdio | `daftari --vault ./my-vault --user me --role admin` |
| Several clients sharing one vault | Streamable HTTP | `daftari serve --vault ./my-vault` |
| Read across several vaults while writing to one | federation mounts | Configure `federation.mounts` |
| Write to several independent vaults through one MCP connection | router package | Follow the [multi-vault how-to](multi-vault-howto.md) |

Federation and the router solve different problems. A mount adds read-only
documents to one vault's search space. The router keeps several writable
vaults independent and dispatches calls to the selected server.

## Process ownership

`.daftari/process.lock` records the process serving a vault. Stale
locks whose process no longer exists are replaced automatically. Live holders
follow a stricter policy:

- A new stdio process may replace an existing stdio holder after terminating
  it and waiting briefly. This preserves the single-user desktop workflow.
- A stdio process refuses to replace a live HTTP server.
- A new HTTP server refuses to replace any live holder unless started with
  `--takeover`.

The lock is ephemeral and must not be committed.

## Configure roles

Daftari does not maintain a user database. Roles and collection grants live in
`.daftari/config.yaml`; the server starts with one identity in stdio mode and
resolves one identity per request in HTTP mode.

```yaml
roles:
  analyst:
    read: [competitive-intel, pricing]
    write: [competitive-intel, _drafts]

  curator:
    read: ["*"]
    write: ["*"]
    promote: true

  admin:
    read: ["*"]
    write: ["*"]
    promote: true
    ratify: true
    verify_repo_sources: true
```

`verify_repo_sources` is separate from vault read access. It permits the role
to check the existence and metadata of `repo:` provenance targets under the
configured `repo_root`; it does not grant arbitrary file reads.

No `--role`, or a role name absent from config, becomes the deny-all guest.
Create a separate role for unattended curation: grant the reads and writes it
needs, but leave `ratify` off so the agent proposes and a human disposes.

## Run locally over stdio

```bash
daftari --vault ./my-vault --user mihir --role admin
```

The MCP client owns the process lifecycle and communicates over stdin/stdout.
Use this mode when one desktop client or agent runtime owns the vault.

Narrow the tool registry for context-sensitive clients:

```yaml
tools:
  tier: standard       # core | standard | full
  include:
    - vault_tension_log
  exclude:
    - vault_status
```

`exclude` wins over `include`. Unknown names warn and are ignored so a config
written for a newer Daftari still loads. Exposure controls `tools/list`; a
client holding a cached tool name can still call any registered tool.

## Run a shared HTTP server

`daftari serve` exposes the same vault over Streamable HTTP:

```bash
daftari serve --vault ./my-vault
daftari serve --vault ./my-vault --bind 0.0.0.0 --port 9000
```

Loopback without auth is the only guest-server configuration. A non-loopback
bind refuses to start unless both authentication and the explicit external-TLS
acknowledgment are configured.

### Static bearer tokens

Put token values in environment variables, never in the YAML file:

```yaml
server:
  transport_security: external
  auth:
    tokens:
      - env: DAFTARI_TOKEN_ETL
        user: agent:etl
        role: curator
```

### OAuth 2.1 resource server

```yaml
server:
  transport_security: external
  auth:
    oauth:
      issuer: https://idp.example.com
      audience: daftari
      jwks_uri: https://idp.example.com/.well-known/jwks.json
      subjects:
        "alice@example.com":
          user: human:alice
          role: analyst
```

Daftari resolves the bearer on every request. A missing or invalid credential
is a 401; a valid JWT whose subject is not mapped is a 403. Neither falls back
to guest.

`transport_security: external` means TLS terminates in Caddy, nginx, a load
balancer, or another upstream component. Daftari does not terminate TLS.

`--legacy-http` temporarily enables compatibility with 2025-era MCP clients.
It uses the same per-request identity model and does not reintroduce server-side
sessions.

## Mount another vault read-only

One process can search its writable vault together with mounted read-only
vaults:

```yaml
# Writable vault: .daftari/config.yaml
federation:
  mounts:
    - alias: research
      path: ../research-vault
      index: lexical      # lexical | full
```

The mounted vault grants access in its own config, keyed by the caller's
authenticated identity:

```yaml
# Mounted vault: .daftari/config.yaml
federation:
  principals:
    "human:mihir":
      role: researcher
```

Federated document addresses include the alias, such as
`research:notes/pricing.md`. Search combines ranked results across vaults, but
mounts expose documents only: their tensions, edges, provenance, lint, locks,
and Git state do not cross the boundary. No tool writes under a mounted root.

Mount indexes live inside the writable vault's `.daftari/` directory. Refresh
one with `vault_reindex {"mount":"research"}`. HTTP server mode currently
refuses configs with mounts; federation is stdio-only.

## Back up to object storage

The local Git working copy remains canonical. Storage backends are opaque sync
targets, not alternate databases:

```yaml
storage:
  backend: s3            # fs | s3 | azure
  bucket: team-vault
  region: us-east-1
  # endpoint: https://…  # MinIO, R2, or another S3-compatible endpoint
  # sync_interval_minutes: 15
```

```bash
daftari sync --vault ./my-vault
daftari sync --vault ./my-vault --dry-run
daftari sync --vault ./empty-dir --restore --backend s3 --bucket team-vault
```

Sync includes markdown, `.git`, and durable `.daftari` journals. It excludes
the rebuildable SQLite index and lock files. It also excludes `.git/config` and
`.git/hooks`, because a backup channel must not deliver executable Git
configuration. Re-add remotes and local hooks after restore.

Cloud SDKs are optional peer dependencies. Install the backend in use:

```bash
npm install @aws-sdk/client-s3
# or
npm install @azure/storage-blob
```

Credentials come from each SDK's standard environment chain, never from vault
config. Restore refuses a non-empty target and rebuilds the index after
materializing the vault.

## Deployment checklist

- Use an absolute vault path.
- Keep `.daftari/process.lock`, SQLite indexes, and lock databases out of Git.
- Define the least-privileged role each client needs.
- Keep `ratify` off unattended agent roles.
- Keep bearer-token values out of config and version control.
- Terminate TLS upstream before any non-loopback bind.
- Test a bad credential and an unmapped OAuth subject before exposing the
  service.
- Run `daftari sync --dry-run` before the first backup.
- Test restore into a new empty directory; an untested backup is not a recovery
  plan.

## Related guides

- [Getting started](getting-started.md) — local stdio setup.
- [Multi-vault how-to](multi-vault-howto.md) — several writable vaults.
- [Adopting existing notes](adoption.md) — local and cloud-synced wikis.
- [Privacy](../PRIVACY.md) — data and network boundaries.
