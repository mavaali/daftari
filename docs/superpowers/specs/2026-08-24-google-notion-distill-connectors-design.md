# Google Docs and Notion Distillation Connectors

## Status

Approved for implementation on 2026-08-24. Implemented on the feature branch;
final verification and merge remain pending.

## Problem

`daftari distill` currently accepts a local file or standard input. A first-class
connector must authorize a deployment to read one Google account and one Notion
workspace, discover the documents the account can access, react to changes, and
place resulting claims in Daftari's existing staged-ratification path. It must
not become a second document store, silently ratify knowledge, or modify source
systems.

## Decisions

- V1 supports one Google account and one Notion workspace per vault.
- Google scope is native Google Docs only. Text PDF support is the first
  follow-up and shares the connector contract.
- The deployment supplies provider OAuth client credentials; Daftari has no
  shared OAuth application or hosted account layer.
- Provider refresh tokens are AES-256-GCM encrypted in local `.daftari` state.
  A configured environment variable supplies the base64-encoded 32-byte key.
- Sync is webhook-first when `server.public_base_url` is configured with HTTPS.
  A localhost-only server uses the same incremental reconciler on a configured
  polling interval.
- Fetched source text exists only in memory for normalization and distillation.
  State keeps IDs, metadata, content hashes, revisions/cursors, encrypted
  credentials, and proposal/run references; it never stores document bodies.
- Each changed source is automatically distilled and staged. The existing
  ratification gate remains the only way to promote a claim.
- Remote deletion or loss of access marks the source unavailable and appends an
  operator review event. It never changes the status of derived documents.

## Architecture

`src/integrations/` is a provider-neutral connector engine. `serve` owns only
the connector lifecycle, route registration, and periodic-job scheduling
because it already owns the writable vault process and HTTP server. It contains
no Google- or Notion-specific OAuth, webhook, discovery, or state logic.
Provider adapters implement those concerns behind one shared contract. The
engine serializes syncs per provider, hashes normalized content before LLM
work, invokes the existing distill proposal pipeline, and serializes every
read/await/write transaction over the vault-wide encrypted state envelope.

```text
provider webhook or timer
        |
        v
serve integration route / scheduler
        |
        v
connector engine -- adapter discovery/fetch --> normalized text (memory only)
        |                                           |
        |                                     SHA-256 comparison
        v                                           |
encrypted local state <--- staged distill proposals <--- changed source only
        |
        v
unavailable-source review queue
```

## Configuration

The optional `integrations:` block lives in `.daftari/config.yaml`.

```yaml
integrations:
  encryption_key_env: DAFTARI_INTEGRATIONS_KEY
  polling_interval_minutes: 15
  google:
    client_id_env: GOOGLE_OAUTH_CLIENT_ID
    client_secret_env: GOOGLE_OAUTH_CLIENT_SECRET
  notion:
    client_id_env: NOTION_OAUTH_CLIENT_ID
    client_secret_env: NOTION_OAUTH_CLIENT_SECRET
```

`server.public_base_url`, when present, is an absolute HTTPS URL. It determines
the OAuth callback and webhook addresses. The server refuses webhook setup on
a non-HTTPS or absent public URL, but it may still poll. Credentials are read
only from named environment variables; neither client secrets nor encryption
keys are accepted in YAML.

Connector control routes require a role with the independent,
deny-by-default `manage_integrations: true` grant. Ordinary vault read, write,
promotion, or ratification authority does not imply access to OAuth connection
or webhook verification material.

## State and security

`.daftari/integrations.state.enc` contains a versioned AES-256-GCM envelope.
It is gitignored alongside other operator-local state. The authenticated
plaintext includes exactly one `ProviderState` per configured provider:

```ts
type ProviderName = "google" | "notion";

interface SourceState {
  id: string;
  revision: string;
  contentHash: string;
  available: boolean;
  lastSeenAt: string;
  lastDistillRunId?: string;
}

interface ProviderState {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt?: string;
  cursor?: string;
  webhookSetupToken?: string;
  webhook?: {
    id: string;
    secret: string;
    expiresAt?: string;
    verificationRequired?: boolean;
  };
  sources: Record<string, SourceState>;
}
```

OAuth `state` values are random, single-use, short-lived entries in this
encrypted state and bind a provider, callback nonce, and PKCE verifier. The
callback rejects a missing, expired, or replayed state. Webhook routes perform
provider authentication before queuing work, acknowledge quickly, and never
place content in the request log.

## Provider behavior

### Google Docs

Discovery enumerates accessible Drive files and keeps only the native Google
Docs MIME type. The adapter uses the immutable Drive file ID as source identity
and normalizes the Google Docs document structure into text. It uses the Drive
change cursor to find modified, removed, or inaccessible files. A Drive change
channel is renewed before expiration when a public callback is available.

### Notion

Discovery enumerates the pages and data sources accessible to the authorized
connection. The adapter recursively retrieves page blocks, renders a stable
plain-text representation, and uses the page ID as source identity. Page and
data-source events queue targeted refreshes; container-level changes also
request a discovery refresh so newly accessible pages are included.

Notion webhook subscriptions are created manually in the connection UI. Before
the unsigned one-time verification request may set a signing secret, an
authenticated operator arms setup and receives a callback URL containing a
single-use nonce. Daftari captures the verification token into encrypted state;
the operator retrieves it over an authenticated, CSRF-protected route, enters it
in Notion, and explicitly confirms activation. Ordinary events remain disabled
until that confirmation and are HMAC-verified afterward.

## Distillation and lifecycle

The normalized text is compared to the prior content hash. An unchanged source
performs no LLM call. A changed source receives a stable source ID of
`<provider>:<remote-id>` and enters the same claim extraction and staged
proposal path as `daftari distill --propose`. Its provenance stays synthesized,
low confidence, and requires ratification. Each proposal/run records the
provider source ID and revision. A new remote revision only creates proposals;
it does not overwrite, supersede, deprecate, or delete older Daftari knowledge.
Post-extraction output is fenced deterministically before staging: a model may
not reproduce the source body or exceed the configured verbatim allowance.

On a remote deletion or access failure, the source's `available` field becomes
false and an append-only `.daftari/integration-review.jsonl` event records the
provider, source ID, last revision, time, and reason. The event is an operator
review queue. A later rediscovery restores availability without erasing history.

## Failure behavior

- Missing config, environment variables, or an invalid encryption key prevents
  connector startup and performs no provider call.
- OAuth provider errors retain prior encrypted state and surface a safe
  diagnostic without printing credentials or response bodies.
- A webhook event ID is deduplicated and returns success after durable queueing.
  Pending events for one provider coalesce into one reconciliation. Fatal
  provider batches retry five times before tombstoning; periodic reconciliation
  continues afterward, and a poison event cannot starve another provider.
- One source fetch or distillation failure does not stop other changed sources.
  Its hash is not advanced, and the provider change cursor remains on the prior
  page, so the source is retried without losing successful siblings.
- A provider authorization failure leaves all existing source records and
  Daftari documents intact and surfaces a safe reconcile failure.

## Testing and acceptance

Tests use injected HTTP transports and fixture responses; no test calls a live
provider or an LLM. Coverage includes config validation, encryption round trips
and tamper rejection, OAuth state/PKCE validation, Google and Notion discovery
and normalization, unchanged-hash skipping, source unavailability, webhook
authentication/deduplication, polling fallback, and `serve` route wiring.
`npm run build`, focused integration tests, the full test suite, and Biome must
run before merge. A PR must receive an independent code review and pass CI
before auto-merge.
