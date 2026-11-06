# Google Docs, Notion, and Microsoft 365 integrations

Daftari can continuously read one Google account, one Notion workspace, and
one Microsoft 365 account per vault. A changed source is distilled into the
existing proposal queue; it is never ratified automatically. The providers
remain read-only source systems.

Google native Docs and Notion pages are supported. PDFs are not yet ingested
for Google/Notion. Microsoft 365 (see its own section below) supports native
Word/PowerPoint, text-layer PDFs, and legacy `.doc`/`.ppt` via lossy PDF
conversion — but only for explicitly enrolled files/folders, not an entire
account.

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
  estimated_usd_per_call: 0.01

roles:
  integration-operator:
    read: ["*"]
    write: ["*"]
    promote: true
    ratify: true
    manage_integrations: true

server:
  transport_security: external
  trusted_proxies:
    - 10.0.0.0/8
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
  microsoft:
    client_id_env: MICROSOFT_OAUTH_CLIENT_ID
    client_secret_env: MICROSOFT_OAUTH_CLIENT_SECRET
    tenant_id: 11111111-2222-3333-4444-555555555555
    scope_profile: sharepoint
    collections: ["engineering", "product"]
    include_speaker_notes: true
    picker_host: https://contoso.sharepoint.com
```

`polling_interval_minutes` defaults to 15. `server.public_base_url` is optional,
but when present it must be an absolute HTTPS URL without credentials, a query,
or a fragment. Its path prefix is preserved in every callback URL and mounted
by Daftari's integration router. `manage_integrations` is deny-by-default and
independent of read, write, promotion, and ratification grants.

`integrations.microsoft` carries these keys (`client_id_env`/`client_secret_env`
are the same environment-variable-name pair as Google/Notion; the rest are
Microsoft-only):

| Key | Meaning | Default |
|---|---|---|
| `client_id_env` | Env var holding the Entra app's client ID | required |
| `client_secret_env` | Env var holding the Entra app's client secret | required |
| `tenant_id` | Entra tenant GUID or verified domain; builds the authority URL | required |
| `scope_profile` | `onedrive` or `sharepoint` — which delegated Graph scope to request | `sharepoint` |
| `collections` | Non-empty allowlist of collection names an enrollment may target | required |
| `include_speaker_notes` | Whether PowerPoint speaker notes are extracted (ignored for docx/pdf) | `true` |
| `picker_host` | SharePoint host URL the browser-side File Picker authenticates against | none (optional; needed for the SharePoint picker) |

As with Google/Notion, `client_id_env`/`client_secret_env` name environment
variables — the secret values are never written into config.yaml. An unknown
key under `integrations.microsoft` (or a missing `tenant_id`/`collections`)
fails config load loudly rather than silently defaulting.

`distill.estimated_usd_per_call` is also optional and provider-neutral: when
set, the Microsoft enrollment preview (see below) includes an `estimatedUsd`
figure; when absent, that field is omitted rather than guessed.

Set `server.trusted_proxies` to the CIDR(s) of the reverse proxy(ies) you run in
front of Daftari. `X-Forwarded-For` is honored only when the immediate peer is
inside one of those ranges, and the client is taken from the first hop that is
not itself a trusted proxy — so a direct attacker cannot forge the header to
move their rate-limit key onto another address. This keeps public
callback/webhook rate limits per client instead of collapsing every provider
onto the proxy socket. Leave the list empty (the default) for direct or
localhost serving.

Export the named secrets before starting the server:

```bash
export DAFTARI_INTEGRATIONS_KEY='<canonical base64 key>'
export GOOGLE_OAUTH_CLIENT_ID='<client id>'
export GOOGLE_OAUTH_CLIENT_SECRET='<client secret>'
export NOTION_OAUTH_CLIENT_ID='<client id>'
export NOTION_OAUTH_CLIENT_SECRET='<client secret>'
export MICROSOFT_OAUTH_CLIENT_ID='<client id>'
export MICROSOFT_OAUTH_CLIENT_SECRET='<client secret>'
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
https://vault.example.com/daftari/integrations/microsoft/callback
```

Enable the Google Drive API and Google Docs API for the Google OAuth client.
Create a public Notion OAuth integration with read-content access, then share
the pages that Daftari should see with that connection. Provider access is the
scope boundary: Daftari discovers the native Docs or Notion pages visible to
the authorized connection. Microsoft's app registration needs a second redirect
URI beyond this server callback (for the browser-side file picker) — see
"Microsoft 365" below for the full Entra setup.

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
with `notion` or `microsoft` in the URL. The callback returns JSON confirming
the connected provider and immediately schedules discovery. Reconnecting
replaces the tokens for that provider while retaining its source history. V1
has no second account slot.

Connecting Microsoft this way authorizes the server's own delegated Graph
access (discovery, fetch, webhook management) — it does not by itself select
which files are ingested. After connecting, an operator still has to enroll
specific files/folders through the picker UI described in "Microsoft 365"
below; nothing is discovered account-wide.

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

### Microsoft

Like Google, no manual route is needed. With a public HTTPS base URL, Daftari
creates one Microsoft Graph change-notification subscription per enrolled
drive (`/drives/{id}/root`), renewing each roughly 28 days before its
~28.5-day (41,000-minute) expiry. Notifications are validated with a
timing-safe `clientState` check, durably queued, acknowledged with HTTP 202,
and reconciled asynchronously — same shape as Google's channel. See "Webhooks"
under "Microsoft 365" below for the subscription/fan-out model and the
`/webhook/lifecycle` endpoint. Without a public base URL, subscriptions are
never created and the incremental reconciler polls instead, same as
Google/Notion.

## Microsoft 365

Microsoft 365 differs from Google/Notion in one important way: Google/Notion
discover everything the authorized account/connection can see, but Microsoft
only ever ingests **explicitly enrolled** OneDrive/SharePoint files and
folders. Connecting the account (`/connect` above) authorizes the server; it
does not select content. Enrollment is a separate, explicit step through a
picker UI.

### Scope

- One Microsoft 365 account per vault, same as Google/Notion.
- In scope: Word (`.docx`), PowerPoint (`.pptx`), text-layer PDF (`.pdf`), and
  legacy `.doc`/`.ppt` (converted server-side to PDF before extraction) —
  but only for files/folders an operator explicitly enrolled through the
  picker.
- Out of scope: Excel, OCR of scanned/image-only PDFs, Teams messages, email,
  and reading sensitivity-label state (the status endpoint reports
  `sensitivityLabels: "not checked (V1)"` — labels are neither read nor
  enforced). IRM-protected/password-encrypted legacy Office files are
  detected by their OLE container header before any bytes are inflated and
  are skipped as `encrypted`, never partially extracted.

### Entra app registration (the one-page IT ticket)

Microsoft 365 ingestion needs a single-tenant Entra app registration with two
redirect platforms on the same client ID:

- **Web platform**: redirect URI `{base}/integrations/microsoft/callback` —
  the confidential-client redirect the server uses for the `/connect` OAuth
  code exchange. This is a Web platform entry because the client secret
  (`client_secret_env`) is presented here; `{base}` is `server.public_base_url`
  (or the loopback listener when that's unset).
- **SPA platform**: redirect URI `{base}/integrations/microsoft/ui` — the
  PKCE public-client redirect the browser-side file picker uses. This is an
  SPA platform entry (no secret ever crosses into the browser) on the *same*
  client ID as the Web platform above.
- **Single-tenant**: register the app as single-tenant against the tenant
  named by `tenant_id` (a GUID or verified domain) — Daftari builds its
  authority URL from that value and does not support multi-tenant `/common`
  registrations.
- **Delegated Graph permissions**: `offline_access`, `User.Read`, `openid`,
  plus one resource scope selected by `scope_profile` — `Files.Read` for
  `onedrive`, `Files.Read.All` for `sharepoint` (the default). These are the
  scopes the server's own `/connect` OAuth flow requests; grant admin consent
  for whichever one your `scope_profile` uses.
- **Browser-side picker scope**: the file picker (loaded from the `/ui` page)
  authenticates separately, in the browser, via MSAL popup against a
  `{picker_host}/.default` scope — a SharePoint-resource scope, not a Graph
  scope — so `picker_host` (the tenant's SharePoint root URL, e.g.
  `https://contoso.sharepoint.com`) must also be reachable/consented for the
  signed-in user. This is a distinct authorization surface from the server's
  delegated Graph scope above; only the SPA registration above enables it.
- **Loopback vs public HTTPS base**: on a loopback deployment (no
  `server.public_base_url`), both callback URIs resolve to
  `http://127.0.0.1:<port>/...` and webhooks are never created — the
  incremental reconciler polls on `polling_interval_minutes` instead. Graph
  change-notification subscriptions require a publicly reachable HTTPS base,
  same requirement as Google's Drive changes channel.

### Webhooks

With a public HTTPS base, Daftari creates one Graph change-notification
subscription per enrolled drive (resource `/drives/{driveId}/root`), fanned
out under a single stable webhook channel id and `clientState` secret shared
across all of a connection's subscriptions. Each subscription is created with
a ~28.5-day (41,000-minute) expiry and renewed with headroom before that,
mirroring the same renew-before-expiry contract as Google's channel. An
enrollment covering a drive with no existing subscription gets one created on
the next reconcile pass; a drive with no remaining enrollment has its
subscription deleted as orphaned.

Two endpoints matter here: `/integrations/microsoft/webhook` receives Graph's
change notifications (validated by `clientState`, then durably queued and
acknowledged 202), and `/integrations/microsoft/webhook/lifecycle` receives
Graph's separate subscription-lifecycle notifications (e.g.
`subscriptionRemoved`, which is queued so the reconciler recreates the
subscription). Neither route needs manual setup or a verification handshake —
unlike Notion's webhook, Microsoft's is `webhookSetup: "automatic"`.

Without a public base URL, no subscriptions are ever requested and the
incremental reconciler polls instead — same fallback behavior as Google.

### Enrollment & operator flow

1. An operator with `manage_integrations: true` opens
   `{base}/integrations/microsoft/ui` in a browser (an authenticated GET,
   same auth gate as the other connector-management routes).
2. The page lets the operator pick individual files or whole
   folders/containers via the SharePoint File Picker (v8, opened as a popup
   against `{picker_host}/_layouts/15/FileBrowser.aspx`, multi-select up to
   50 items, filtered to `.docx`/`.pptx`/`.pdf`/`.doc`/`.ppt`/folders), choose
   one of the `collections` allowlisted in config from a dropdown, and check
   an audience-disclosure acknowledgement checkbox — the Enroll button stays
   disabled until both a selection exists and the checkbox is checked.
3. **Preview** (`POST /integrations/microsoft/enrollments/preview`) re-fetches
   each selected item/folder with the server's own delegated token (the raw
   picker selection is never trusted as-is), expands folders (up to 1,000
   eligible files per container), and returns the eligible count, the
   collection's configured readers/ratifiers, and — when
   `distill.estimated_usd_per_call` is set — an estimated USD cost.
4. **Enroll** (`POST /integrations/microsoft/enrollments`) requires
   `acknowledged: true` in the body (the audience disclosure must be
   explicitly acknowledged, never inferred) and the caller must have write
   access to the chosen collection. It persists one `EnrollmentRecord` per
   selected item/expanded folder, capturing who enrolled it, when, the
   audience-ack timestamp, and the collection's readers at that moment.
   Enrolling more items than `2,000` total already-discovered-plus-new
   sources for this connector is rejected.
5. **Status** (`GET /integrations/microsoft/status`) reports connection
   state, webhook state, enrollments, and per-source lifecycle state
   (current/pending/failed/unavailable/over_limit). Per-enrollment source
   counts are structurally present in the response shape but currently
   always read `0` — the engine does not yet populate
   `SourceState.enrollmentId` for any provider, so grouping sources under
   their enrollment has nothing to group yet. Treat any non-zero
   per-enrollment count you might see in a future release as the signal that
   plumbing has landed; today it is not a working feature.
6. **Unenroll** (`DELETE /integrations/microsoft/enrollments/{id}`) removes
   the enrollment record only. The underlying sources' metadata
   (`contentHash`, `available`, history) is retained, not deleted, and an
   `unenrolled` event is appended to `.daftari/integration-review.jsonl`.
   Knowledge already distilled from an unenrolled source is never removed.

### Extraction & limits

- Native extraction for `.docx` and `.pptx`; PowerPoint speaker notes are
  included when `include_speaker_notes` is true (the per-enrollment value
  overrides the config default when it can be resolved unambiguously,
  otherwise the config default applies).
- Text-layer `.pdf` is extracted directly; scanned/image-only PDF content is
  not OCR'd.
- Legacy `.doc`/`.ppt` are converted to PDF by Graph itself
  (`?format=pdf` on the content request) before extraction — this path is
  lossy (no speaker notes survive the conversion, since the source is no
  longer a native pptx). The conversion is tagged internally as
  `pdf-conversion`, but that tag does not currently survive into persisted
  source state or the `/status` response — there is no `pdf-conversion`
  label visible to an operator today; don't expect to see one.
- Download cap: 25 MiB, checked against the file's declared size before any
  download is attempted, and again while streaming the response body.
  Malware-scanned files (Graph's `malware` facet present) are rejected before
  download. A file whose type isn't one of the above is rejected as
  `unsupported_type`.
- Extraction-time caps (shared with Google/Notion's own extractors): 32 MiB
  inflated per archive entry and 96 MiB inflated total for a docx/pptx
  (they're zip containers), and 500 pages for a PDF.
- A prior `empty`/`encrypted`/`unsupported_type`/`too_large` failure on the
  exact same file revision short-circuits future fetch attempts without
  re-downloading; other failure reasons (network, distill, timeout) always
  retry.

### `scope_profile` guidance

- `sharepoint` (default): requests `Files.Read.All`, reaching SharePoint
  document libraries in addition to the connected user's own OneDrive. Pick
  this for team/shared-drive ingestion.
- `onedrive`: requests the narrower `Files.Read`, scoped to the connected
  user's own OneDrive only. Pick this when the account should only ever
  surface its own files.

The choice only changes which delegated Graph scope the server's OAuth flow
requests — it does not change the browser-side picker's SharePoint-resource
scope (`{picker_host}/.default`), which is independent either way.

## Sync and failure behavior

Webhooks wake the same incremental reconciler used by the timer. Polling remains
enabled as a retry and missed-event safety net even when webhooks are active.
Provider syncs are serialized; a wake during an active pass causes an immediate
follow-up pass. Events already waiting for the same provider are coalesced into
one reconciliation pass. A fatal provider batch is retried five times before
its event IDs are tombstoned; the periodic reconciler continues trying the
provider afterward, so one poison event cannot starve other provider work.

Each provider response is limited to 8 MiB and 30 seconds. A reconciliation
accepts at most 10,000 sources, 8 MiB of normalized text per source, and 64 MiB
of normalized text in total. Discovery rejects repeated cursors and more than
1,000 provider pages. Notion traversal is additionally capped at 10,000 blocks
per page, 10,000 block-response pages, and 32 nested block levels. Crossing a
bound fails the affected source or batch without advancing its
successful-content marker.

Only a changed normalized-content hash invokes the LLM. Successful extraction
creates staged proposals with a stable source ID such as `google:<file-id>`,
`notion:<page-id>`, or `microsoft:<drive-id>:<item-id>`. Microsoft's own
download/extraction caps (25 MiB per file, 500 PDF pages, 32/96 MiB inflate
caps) sit inside this reconciliation's own limits — see "Extraction & limits"
under "Microsoft 365" above. Extraction, budget, or proposal errors leave the previous
hash unadvanced so the source is retried. Existing knowledge is never modified
or removed by the integration. A provider change cursor advances only after
every source discovered on that change page succeeds; partial failures replay
from the prior cursor.

If a source is deleted or becomes inaccessible, Daftari marks its metadata
unavailable and appends an operator event to
`.daftari/integration-review.jsonl`. Access returning later restores
availability; it does not erase the review history.

## Local state and retention

The following files are local operator state and are ignored by Git:

| Path | Contents |
|---|---|
| `.daftari/integrations.state.enc` | AES-256-GCM encrypted tokens, OAuth transactions, cursors, webhook secrets/subscriptions, source IDs/revisions/hashes, Microsoft enrollment records (who/when/collection/audience-ack), and run references |
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
Microsoft's enrollment records are metadata too — label, collection, who
enrolled it and when, and the audience-ack timestamp — never a copy of the
document's content. Unenrolling or disconnecting Microsoft never deletes
knowledge already distilled into the vault; it only stops future ingestion
from that source.

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
- `collection_not_allowed`: the enrollment request's `collection` isn't in
  `integrations.microsoft.collections` — add it to the allowlist or pick an
  allowlisted one.
- `enrollment_rejected` / `acknowledgement_required`: the picker's selection
  couldn't be resolved against Graph (permission, type, or 1,000-per-container
  limit), or the enrollment POST omitted `acknowledged: true`.
- Microsoft enrollments never appear to grow past 0 sources in `/status`:
  expected in the current build — per-enrollment source counts aren't wired
  up yet (see "Enrollment & operator flow" above); check the flat `sources`
  list in the same response instead.
- Repeated reconcile warnings: confirm the provider connection still has access
  to the source and that the distill API key/model are valid. Failed sources
  remain retryable rather than being marked current.

Provider references: [Google OAuth for web servers](https://developers.google.com/identity/protocols/oauth2/web-server),
[Google Drive change notifications](https://developers.google.com/workspace/drive/api/guides/push),
[Notion webhooks](https://developers.notion.com/reference/webhooks), and
[Microsoft identity platform OAuth 2.0](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow)
and [Microsoft Graph change notifications](https://learn.microsoft.com/en-us/graph/api/resources/webhooks).
