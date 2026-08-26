# Google Docs and Notion integrations

Daftari can continuously read one Google account and one Notion workspace per
vault. A changed source is distilled into the existing proposal queue; it is
never ratified automatically. The providers remain read-only source systems.

Google native Docs and Notion pages are supported. PDFs are not yet ingested.

## Before you start

Integrations run only with `daftari serve`. The process needs:

- an explicit `distill:` model and the corresponding `ANTHROPIC_API_KEY`, or
  `DAFTARI_LLM_TRANSPORT=openrouter` plus `OPENROUTER_API_KEY`;
- a deployment-owned OAuth client for each provider;
- a stable, canonical-base64 32-byte key used to encrypt provider state; and
- an authenticated HTTP server if it binds beyond loopback.

Generate the state key once and keep the same value across restarts:

```bash
openssl rand -base64 32
```

Put the result in the environment named by `encryption_key_env`. Losing or
rotating this value without reconnecting makes the existing encrypted state
unreadable.

## Configure the vault

Add the integration and distill blocks to `.daftari/config.yaml`. Values in
`*_env` fields are environment variable names, not secrets.

```yaml
distill:
  model: claude-haiku-4-5

roles:
  integration-operator:
    read: ["*"]
    write: ["*"]
    promote: true
    ratify: true
    manage_integrations: true

server:
  transport_security: external
  trust_proxy: true
  public_base_url: https://vault.example.com/daftari
  auth:
    tokens:
      - env: DAFTARI_OPERATOR_TOKEN
        user: human:operator
        role: integration-operator

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

`polling_interval_minutes` defaults to 15. `server.public_base_url` is optional,
but when present it must be an absolute HTTPS URL without credentials, a query,
or a fragment. Its path prefix is preserved in every callback URL and mounted
by Daftari's integration router. `manage_integrations` is deny-by-default and
independent of read, write, promotion, and ratification grants.

Set `server.trust_proxy: true` only when Daftari is directly behind a reverse
proxy that removes any client-supplied `X-Forwarded-For` value and writes the
real client address. This keeps public callback/webhook rate limits per client
instead of collapsing every provider and attacker onto the proxy socket. Leave
it false for direct or localhost serving.

Export the named secrets before starting the server:

```bash
export DAFTARI_INTEGRATIONS_KEY='<canonical base64 key>'
export GOOGLE_OAUTH_CLIENT_ID='<client id>'
export GOOGLE_OAUTH_CLIENT_SECRET='<client secret>'
export NOTION_OAUTH_CLIENT_ID='<client id>'
export NOTION_OAUTH_CLIENT_SECRET='<client secret>'
export DAFTARI_OPERATOR_TOKEN='<operator bearer token>'
export ANTHROPIC_API_KEY='<distillation API key>'
```

Startup fails before provider calls if configuration, credentials, encrypted
state, queue state, or adapter capabilities are invalid.

## Register OAuth callbacks

Register these exact redirect URIs in the provider consoles:

```text
https://vault.example.com/daftari/integrations/google/callback
https://vault.example.com/daftari/integrations/notion/callback
```

Enable the Google Drive API and Google Docs API for the Google OAuth client.
Create a public Notion OAuth integration with read-content access, then share
the pages that Daftari should see with that connection. Provider access is the
scope boundary: Daftari discovers the native Docs or Notion pages visible to
the authorized connection.

Without `public_base_url`, the callbacks use the actual loopback listener, for
example `http://127.0.0.1:8787/integrations/google/callback`. Provider OAuth
rules determine which loopback redirect forms are accepted. Webhooks stay off
and the incremental reconciler polls.

## Connect a provider

Start the server, then request an authorization redirect with an authenticated
POST from a role with `manage_integrations: true`. Bearer-authenticated requests
do not need a CSRF header. Guest, read-only, and ordinary write roles receive
HTTP 403 from connector-management routes.

```bash
curl -i -X POST \
  -H "Authorization: Bearer $DAFTARI_OPERATOR_TOKEN" \
  https://vault.example.com/daftari/integrations/google/connect
```

Open the returned `Location` in a browser and complete provider consent. Repeat
with `notion` in the URL. The callback returns JSON confirming the connected
provider and immediately schedules discovery. Reconnecting replaces the tokens
for that provider while retaining its source history. V1 has no second account
slot.

Cookie-authenticated operator requests must also echo the `daftari_csrf` cookie
in the `X-CSRF-Token` header for every POST described in this guide.

## Enable webhooks

### Google

No manual route is needed. With a public HTTPS base URL, Daftari creates a
Google Drive changes channel after authorization and renews it before expiry.
Incoming notifications are authenticated with the private channel token,
durably queued, acknowledged with HTTP 202, and reconciled asynchronously.

### Notion

Notion subscriptions are created and verified manually in the connection UI.
Use the following guarded exchange so an unsigned verification request cannot
set the signing secret unless an operator has just armed setup.

1. Ask Daftari for a one-time callback URL:

   ```bash
   curl -sS -X POST \
     -H "Authorization: Bearer $DAFTARI_OPERATOR_TOKEN" \
     https://vault.example.com/daftari/integrations/notion/webhook/setup
   ```

2. In the Notion connection's **Webhooks** tab, create a subscription using the
   returned `callbackUrl` exactly as supplied. Select page and data-source
   lifecycle/content events relevant to the shared content.

3. After Notion sends its one-time verification POST, retrieve the captured
   token through the authenticated route:

   ```bash
   curl -sS -X POST \
     -H "Authorization: Bearer $DAFTARI_OPERATOR_TOKEN" \
     https://vault.example.com/daftari/integrations/notion/webhook/verification
   ```

4. Paste `verificationToken` into Notion's verification form. After Notion
   accepts it, activate signed event processing:

   ```bash
   curl -i -X POST \
     -H "Authorization: Bearer $DAFTARI_OPERATOR_TOKEN" \
     https://vault.example.com/daftari/integrations/notion/webhook/verification/confirm
   ```

Daftari rejects ordinary Notion events before this confirmation and verifies
later events with the captured HMAC secret.

## Sync and failure behavior

Webhooks wake the same incremental reconciler used by the timer. Polling remains
enabled as a retry and missed-event safety net even when webhooks are active.
Provider syncs are serialized; a wake during an active pass causes an immediate
follow-up pass. Events already waiting for the same provider are coalesced into
one reconciliation pass. A fatal provider batch is retried five times before
its event IDs are tombstoned; the periodic reconciler continues trying the
provider afterward, so one poison event cannot starve other provider work.

Only a changed normalized-content hash invokes the LLM. Successful extraction
creates staged proposals with a stable source ID such as `google:<file-id>` or
`notion:<page-id>`. Extraction, budget, or proposal errors leave the previous
hash unadvanced so the source is retried. Existing knowledge is never modified
or removed by the integration.

If a source is deleted or becomes inaccessible, Daftari marks its metadata
unavailable and appends an operator event to
`.daftari/integration-review.jsonl`. Access returning later restores
availability; it does not erase the review history.

## Local state and retention

The following files are local operator state and are ignored by Git:

| Path | Contents |
|---|---|
| `.daftari/integrations.state.enc` | AES-256-GCM encrypted tokens, OAuth transactions, cursors, webhook secrets, source IDs/revisions/hashes, and run references |
| `.daftari/integration-queue.json` | Metadata-only durable webhook work and processed-event replay tombstones retained for up to 30 days and capped at 20,000 IDs |
| `.daftari/integration-review.jsonl` | Append-only unavailable-source review events |
| `.daftari/distill-state.json` | Distill hashes, landed claim keys, and an exact distilled-claim remainder while a partial proposal batch is retrying |

Fetched document text and provider response bodies are held in memory only for
normalization and distillation, then discarded. The staged Markdown proposals
are distilled claims, not copies of the fetched documents. A deterministic
post-extraction fence rejects model output that reproduces the source body or
exceeds the configured verbatim allowance before staging. Queue and review files
are not encrypted, but contain metadata rather than source bodies or
credentials; protect the vault's `.daftari` directory as operational data.

## Troubleshooting

- `integration state encryption key ... must be canonical base64`: restore the
  exact 32-byte base64 value originally used; do not trim padding.
- `integration provider ... is not authorized`: complete the provider's
  `/connect` flow.
- OAuth `redirect_uri_mismatch`: make the provider-console URI exactly match
  the computed callback, including scheme, path prefix, and trailing slash.
- `public_webhook_url_required`: configure `server.public_base_url` with public
  HTTPS, or keep polling-only operation.
- `verification_not_pending`: arm Notion setup first and wait for its initial
  verification POST.
- Repeated reconcile warnings: confirm the provider connection still has access
  to the source and that the distill API key/model are valid. Failed sources
  remain retryable rather than being marked current.

Provider references: [Google OAuth for web servers](https://developers.google.com/identity/protocols/oauth2/web-server),
[Google Drive change notifications](https://developers.google.com/workspace/drive/api/guides/push),
and [Notion webhooks](https://developers.notion.com/reference/webhooks).
