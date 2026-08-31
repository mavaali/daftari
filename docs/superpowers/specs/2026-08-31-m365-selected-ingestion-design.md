# Microsoft 365 Human-Selected Document Ingestion

## Status

Proposed 2026-08-31 (issue #492). Architecture decision only — follow-up
implementation issues are created after this design is accepted, per the
issue's acceptance criteria.

Preconditions before implementation starts:

- The P1 production dependency advisory review completes first (issue #492
  displacement list). As of this writing the default branch carries two
  high-severity Dependabot advisories.
- The shared text-layer PDF extraction work (Bead `daftari-6e2`) defines the
  one extractor this connector consumes (§ Extraction). This design defines
  only the interface; it does not create a second PDF parser or retention
  path.

## Problem

Daftari has a compile-on-ingest pipeline and continuous Google Docs and
Notion connectors, but a human cannot yet connect Microsoft 365, select
specific Office documents, choose a target collection, preview the
distillation cost, and keep those sources distilled into staged proposals.
The connector must be an ingestion front door for the existing compiler —
not a second document store, a second trust path, or a provider fork of the
integration engine.

Work IQ is not the ingestion plane. Microsoft Graph provides stable source
identities, downloads, revisions, webhooks, and delta reconciliation;
Work IQ may later help a human *discover* candidates, but a human confirms
concrete Graph items before anything is enrolled.

## Decisions

1. **Enrollment is a first-class, provider-neutral concept.** Selected-source
   ingestion is expressed through the existing adapter contract: the M365
   adapter's `discover()` returns the union of enrolled files and the
   eligible descendants of enrolled folders — never everything the token can
   see. The engine's reconciliation, unavailable-source, cursor, hash, and
   limit machinery is reused unchanged in shape. Google and Notion adapters
   compile unchanged (enrollment is optional state they never set).
2. **Broad delegated token, Daftari-enforced enrollment boundary.** Scopes
   are delegated `Files.Read.All` + `Sites.Read.All` + `offline_access` +
   `openid profile`, on a deployment-owned Entra application with one-time
   tenant-admin consent. Selected-scope alternatives are rejected for v1:
   `Files.SelectedOperations.Selected` is a per-item grant model without
   drive delta, which contradicts delta-as-truth reconciliation;
   `Sites.Selected` is noted as the v2 SharePoint tightening path once
   delegated support and per-site delta are verified. The enrollment set —
   not the token — is the privilege boundary, and injected-transport tests
   must make a fetch outside enrollment structurally impossible to ship.
3. **Delta is truth, webhooks are wake-ups, polling stays on.** Per-drive
   delta cursors taken at drive root and filtered by ancestry against the
   enrollment set; per-folder cursors are rejected (inconsistent Graph
   support, worse failure modes). Unlike the Google/Notion webhook-or-poll
   split, m365 keeps the periodic reconcile running even in webhook mode:
   Graph notifications are lossy by contract, so a lost subscription
   degrades latency, never correctness.
4. **One extraction path.** Word and PowerPoint are converted server-side by
   Graph to transient PDFs; the shared text-layer PDF extractor then serves
   .docx, .pptx, and native text PDFs alike. Speaker notes are excluded
   (verified absent by fixture, not assumed). A native per-format XML
   extractor is the named contingency if the fixture gate shows
   decision-critical loss — a fallback, not a parallel v1 path.
5. **Collection ACL: advisory disclosure, not a permission bridge.** The
   answer to the issue's open question is **no** — the target collection is
   not constrained to be no broader than the principals who can read every
   enrolled source. Enforcing that requires enumerating effective M365
   permissions, bridging M365 principals onto Daftari roles, and letting an
   external ACL drive vault RBAC — exactly the "new authorization system"
   kill condition. Instead: the enrollment preview discloses which vault
   roles can read the target collection; the human with
   `manage_integrations` makes the flattening decision explicitly; and
   sensitivity labels are the one machine-readable hard gate (default: any
   labeled file is refused at enrollment).
6. **Source changes only ever create proposals.** A new remote revision
   enters the same staged-distill path as every other connector; it never
   overwrites, supersedes, deprecates, promotes, or erases Daftari
   knowledge. Remote deletion marks the source unavailable and appends an
   operator review event; automatic erasure of ratified knowledge on remote
   deletion is rejected — it would let an external system silently rewrite
   the vault. True erasure remains the operator's `vault_erase` path.
7. **Setup must reach a first staged proposal within five minutes** of
   tenant setup (the issue's first kill condition). Consequences: enrollment
   triggers an immediate reconcile; webhook subscription setup is off the
   critical path (`webhookSetup: "automatic"`, ensured lazily); the cost
   preview is metadata-only and never blocks on content; the setup surface
   is exactly env vars, the admin-consent URL, connect, picker, enroll.

## Architecture

```text
human opens /integrations/m365/picker  (authorized, manage_integrations, CSRF)
        |
        v
Microsoft File Picker v8 (browser-side MSAL token, postMessage)
        |
        v
POST /integrations/m365/enroll  -> adapter.resolveEnrollment()
        |     server-side re-validation with the CONNECTED account's token:
        |     exists, readable, eligible type, size caps, sensitivity label
        v
EnrollmentRecord[] in encrypted provider state  ->  immediate reconcile wake
        |
        v
Graph webhook wake-up ----\
periodic poll -------------+--> discover(): drive-root delta, ancestry-filtered
        |                                   to enrolled files + folder descendants
        v
fetch: content download, or transient convert-to-PDF for .docx/.pptx
        |
        v
shared text-layer PDF extraction (bounded, in memory)
        |
        v
existing distill pipeline -> staged proposals in the enrolled targetCollection
        |
        v
discard downloaded bytes and extracted text; persist hashes/metadata only
```

The provider-neutral boundary holds: `serve` owns lifecycle, routes, and
scheduling; the engine owns encrypted state and the change gate; the M365
adapter owns Graph OAuth, the picker asset, delta, conversion, and
validation. One serve-layer fix rides along: the integration route matcher
currently hardcodes `/(google|notion)/` — it must derive provider names from
the registered adapters instead.

### Shared-layer changes (additive)

```ts
// types.ts
export type ProviderName = "google" | "notion" | "m365";

export interface EnrollmentRecord {
  ref: string;               // provider-scoped, e.g. "drive:<driveId>:<itemId>"
  kind: "file" | "folder";
  label: string;             // display metadata for the operator UI only
  targetCollection: string;
  enrolledAt: string;
  enrolledBy: string;        // authenticated principal
}

export interface ProviderState {
  // ...existing fields...
  enrollment?: EnrollmentRecord[];        // absent = google/notion behavior
  adapterData?: Record<string, unknown>;  // opaque, adapter-owned
}
```

- Optional `ProviderAdapter.resolveEnrollment(candidates, state)` turns
  client-supplied picker output into validated `EnrollmentRecord`s.
- `UnavailableSourceEvent.reason` widens to
  `"no_longer_discovered" | "access_denied" | "deleted" | "unenrolled"` so
  the review queue distinguishes an operator's un-enrollment from Microsoft
  taking access away. The widening is backward-compatible with the JSONL.
- The engine's provisional-cursor discipline (cursor commits only when no
  source in the page failed) extends to also snapshot/restore `adapterData`,
  so delta links stay replayable across partial cycles.
- Webhook setup becomes two-phase for automatic providers: mint and persist
  a pending channel (clientState secret + URL nonce) under the state lock,
  release, call the provider, then record subscription IDs under the lock —
  because Graph validates the notification URL synchronously *during*
  subscription creation. A `verification`-kind `VerifiedWebhook` may carry
  `{respondBody, respondContentType}` so the route can echo Graph's
  `validationToken` as `text/plain`.
- `ReconcileLimits` gains an optional `maxCycleMs` (soft: stop starting new
  fetches, commit what is done; the failed-source retry path already
  tolerates partial cycles).

### Target-collection plumbing

`DistillationInput` gains `targetCollection?: string`, and
`DistillUpsertInput` gains a `collection?` override (default `"distill"`,
landing path `<collection>/<source_group>/<slug>--<hash8>.md`). The engine
threads the value from the source's owning `EnrollmentRecord`; Google and
Notion pass nothing. The output fence's raw-tier refusal runs against the
overridden collection too. `manage_integrations` alone must not aim
proposals at an arbitrary collection: the enroll route also checks the serve
process's write permission for `targetCollection`, reusing the stage-time
write-gate rationale.

## M365 adapter state

`adapterData` (persisted opaquely inside the existing encrypted envelope):

```ts
interface M365AdapterData {
  deltaLinks: Record<string, string>;         // per driveId, taken at drive root
  subscriptions: Record<string, { id: string; expiresAt: string }>;
  folderIndex?: Record<string, string[]>;     // enrolled folder -> descendant ids
  tenantId: string;
  status?: "ok" | "reconnect_required";
}
```

- **Source identity**: `m365:<driveId>:<itemId>`. [TRAINING] `itemId` is
  stable within a drive across renames and moves; a cross-drive move mints a
  new id (verify with a move fixture). A rename/move inside an enrolled
  folder is a metadata no-op; a move out is an unavailable event; a
  cross-drive move is two events — old id unavailable, new id a fresh source
  iff it lands under an enrolled folder. V1 does not chase identity across
  drives.
- **Revision**: `cTag` primary, `eTag` fallback. [TRAINING] `eTag` ticks on
  metadata-only changes; `cTag` only on content change (verify presence for
  SharePoint library items). The SHA-256 content hash remains the spend
  gate either way, so a wrong choice costs bandwidth, never LLM calls.
- **Delta**: initialized per drive at first enrollment touching that drive;
  paginated (bounded pages per discover); dedup within a batch is
  last-writer-wins per itemId; a 410 `resync` restarts delta from scratch
  for that drive, and replay safety comes from the content hash, not cursor
  cleverness — a full replay is LLM-free for unchanged content.

## Entra setup, OAuth, and callback

- Deployment-owned Entra application; the deployment supplies client
  credentials via environment variables, matching the existing pattern. No
  Daftari-hosted multitenant app in v1 (explicitly deferred by the issue).
- One-time tenant-admin setup is the standard admin-consent URL
  (`https://login.microsoftonline.com/{tenant}/v2.0/adminconsent?client_id=…`).
  [TRAINING] `Files.Read.All`/`Sites.Read.All` delegated typically require
  admin consent in work tenants — verify per-scope consent flags at
  implementation. If most target tenants refuse consent, the issue's kill
  condition on the deployment-owned model fires by design.
- Delegated auth-code + PKCE through the existing provider-neutral OAuth
  transaction machinery (encrypted single-use state, nonce, replay
  rejection).
- Callback split is unchanged from the 2026-08-24 design:
  `server.public_base_url` (HTTPS) enables webhooks; a localhost serve uses
  the same reconciler on the polling interval. [TRAINING] Entra accepts
  `http://localhost:<port>` redirect URIs (verify), so connect + picker +
  enroll + poll all work locally; only webhooks need the public URL.

### Configuration

```yaml
integrations:
  encryption_key_env: DAFTARI_INTEGRATIONS_KEY
  polling_interval_minutes: 15
  m365:
    client_id_env: M365_OAUTH_CLIENT_ID
    client_secret_env: M365_OAUTH_CLIENT_SECRET
    allowed_sensitivity_labels: []   # default: refuse any labeled file
```

## File Picker integration

- The picker page is served by `serve` at `/integrations/m365/picker`,
  behind the same `authorize` + `manage_integrations` + CSRF gate as the
  other integration control routes. The page is a provider *asset*
  (registered by the adapter), so serve hosts provider UI bytes without
  provider logic. [TRAINING] Picker v8 is an embedded iframe/popup driven by
  postMessage and needs a browser-side MSAL.js token against the same Entra
  app — verify the channel protocol and SPA redirect requirements at
  implementation; all of it stays client-side.
- The page POSTs picker results (driveId/siteId/itemId tuples plus the
  chosen `targetCollection`) to `POST /integrations/m365/enroll`.
- **A picker selection is not authorization.** The enroll route re-validates
  every candidate server-side with the connected account's token, for three
  independent reasons: the postMessage payload is client-controlled bytes;
  the browser user and the connected account may differ; and under
  `Files.Read.All` a selection confers nothing at Graph — enrollment is
  authorization *inside Daftari*. Validation checks existence, readability,
  eligible type (.docx, .pptx, text PDF), size caps, and the sensitivity
  label, then writes `EnrollmentRecord`s and wakes an immediate reconcile.

## Extraction

Word and PowerPoint fetch via Graph convert-to-PDF
(`GET /drives/{d}/items/{i}/content?format=pdf` — [TRAINING] verify the
format support matrix and size limits); native PDFs download directly. Both
stream to memory and pass through the one shared extractor:

```ts
// consumed from the shared PDF work (Bead daftari-6e2); defined here, built there
extractPdfText(
  bytes: Uint8Array,
  limits: { maxBytes: number; maxPages: number; maxTextBytes: number },
): Result<{ text: string; pages: number; truncated: boolean; hasTextLayer: boolean }, Error>;
```

`hasTextLayer: false` (a scanned PDF) fails the source with a typed reason
in the review surface ("no text layer; OCR out of scope") — never a silent
empty distill. Downloaded bytes and extracted text are discarded after
distillation; only the normalized-text SHA-256 and metadata persist, per the
existing engine guarantee and the compile-on-ingest retention posture.

**Conversion fixture gate (the kill-condition test, built before shipping):**
fixture pairs — a .docx with tables, tracked changes, comments, and
footnotes; a .pptx with dense slide bodies and speaker notes — with
hand-written ground-truth claim lists. Assert (a) converted text contains
every decision-critical ground-truth string, (b) speaker notes are absent,
(c) comment/tracked-change behavior is documented from the fixture result.
If (a) fails on tables or body text, fall to a native XML extractor for the
failing format only.

## Permissions, labels, and collection ACLs

- **Sensitivity labels are the hard gate.** `resolveEnrollment` reads each
  item's label ([TRAINING] via the driveItem sensitivity-label surface;
  verify delegated availability); a label outside
  `allowed_sensitivity_labels` refuses enrollment by name. The label is
  re-checked on every fetch; a label appearing later flips the source
  unavailable with an `access_denied`-class reason and a
  `sensitivity_label_disallowed` detail.
- **Permission breadth is disclosed, not computed.** The enrollment preview
  names the target collection and — from the vault's own config — the roles
  that can read it. No M365 permission enumeration, no principal bridge, no
  external ACL driving vault RBAC.
- **Why "silently flattened" is structurally impossible**: what lands is
  claims (verbatim-fenced, never the document), aimed by an explicit
  operator enrollment, gated by the stage-time write gate on the target
  collection, and promoted only through human ratification.
- Consistency with the 2026-07-14 existence-disclosure rules: enrollment,
  preview, and review surfaces list *external* items to a
  `manage_integrations` operator — no vault doc list or count crosses an ACL
  boundary; the vault-facing addition (collection landing) rides existing
  gates.

## Cost preview

- **Pre-fetch (enrollment preview): an upper bound, labeled as one.** From
  Graph metadata only (file count, byte sizes): estimated text characters
  via a fixture-derived chars-per-byte table per format, then worst-case
  call arithmetic from the existing distill cost model (every call at
  `inCallInputCap`, capped by `maxLlmCalls` per source). Presented as "at
  most ~X; hard-capped at Y LLM calls per source" — the caps are the real
  promise; the preview never blocks on content.
- **Post-fetch: exact plan per source**, recorded in the existing distill
  receipt store. No new mechanism.

## Limits

| Limit | Value | Where |
|---|---|---|
| `maxSourceTextBytes` | 8 MiB (existing default) | engine, reused |
| `maxCycleTextBytes` | 64 MiB (existing default) | engine, reused |
| `maxSources` (engine sanity) | 10,000 (existing) | engine, reused |
| Max enrolled files (post-folder-expansion) | 500 | enrollment + discover refusal |
| Max source file bytes (pre-conversion) | 20 MiB | adapter fetch guard |
| Max PDF pages | 300 | `extractPdfText` limits |
| Per-fetch timeout (download or convert) | 60 s | adapter transport |
| Max reconcile cycle wall time | 10 min soft (`maxCycleMs`) | engine addition |
| Delta pages per discover, per drive | 50 | adapter |
| Webhook body | 256 KiB / 10 s (existing) | routes, reused |

Human-selected means human-scale: the 500-file cap is raised deliberately,
not by default. Oversize and over-page sources fail with typed reasons into
the review surface — enrolled-but-uningestable must be visible.

## Failure and lifecycle

| Event | Detection | Behavior |
|---|---|---|
| Item deleted | delta deleted facet / 404 | unavailable + review event (`deleted`); derived docs untouched |
| Permission revoked on item | 403 on fetch | unavailable + review event (`access_denied`); rediscovery restores without erasing history |
| Label added post-enrollment | label check on fetch | as `access_denied`, with label detail |
| Move within drive | delta (stable itemId) | ancestry re-check: inside enrollment ⇒ no-op; outside ⇒ unavailable |
| Cross-drive move | old id gone, new id appears | two events: old unavailable; new source iff under an enrolled folder |
| Refresh-token expiry / consent revoked | `invalid_grant` | `status: "reconnect_required"` on manage routes; state intact; one review event so it is not silent |
| Subscription expired/lost | renewal failure; [TRAINING] Graph lifecycle notifications (register `lifecycleNotificationUrl`; verify) | `ensureWebhook` recreates; polling continues regardless, so loss is latency, not correctness |
| Webhook notification | `clientState` mismatch ⇒ 401 | existing verify + queue dedup/coalesce; hint scoped to the notifying drive; notifications carry no content |
| Delta 410 `resync` | discover | restart delta for that drive; content hashes make replay LLM-free |
| Un-enrollment | operator route | records removed; next reconcile marks orphans unavailable (`unenrolled`) |

Microsoft deletion/correction requirements reconcile with the existing
policy as follows: Daftari retains no source content — only fenced claims —
so remote deletion creates an operator review event, and a correction
obligation is an operator act via ratified supersession or, for true
erasure, the existing `vault_erase` scrub. No automatic propagation.

## Kill conditions (from #492, kept testable)

1. First staged proposal within 5 minutes of tenant setup — measured over
   the connect → pick → enroll → immediate-reconcile path.
2. Conversion fixture gate shows decision-critical loss ⇒ per-format native
   extractor fallback; if that also fails, the one-path premise dies.
3. Enrolled-but-never-ratified: the review surface exposes the staged-vs-
   ratified ratio per source so the tripwire is observable, not
   archaeological.
4. Tenant admin consent unobtainable for most target users ⇒ the
   deployment-owned OAuth model dies; escalate to the deferred multitenant
   app decision.
5. Preserving Microsoft permissions demands a principal bridge ⇒ already
   answered: rejected in v1 by design (Decision 5); if disclosure-plus-
   labels proves insufficient in practice, that is a new design, not a
   patch.

## Testing and acceptance

Tests use injected transports and fixtures; no test calls live Microsoft
services or an LLM. Coverage includes: enrollment validation (including the
three re-validation reasons), ancestry filtering, delta pagination/replay/
410-resync, provisional cursor + `adapterData` snapshot, two-phase webhook
creation and `validationToken` echo, `clientState` rejection, token refresh
and `reconnect_required`, sensitivity-label refusal at enroll and at fetch,
target-collection threading and the write gate, cost-preview arithmetic,
and every row of the lifecycle matrix. A structural test asserts no fetch
occurs for an item outside the enrolled set.

The evaluation corpus includes representative Word documents, PowerPoint
decks, and text-layer PDFs, including malformed, encrypted, oversized,
empty, scanned (no text layer), and permission-revoked cases, plus the
conversion fixture pairs with ground-truth claim lists.

Consolidated [TRAINING] verifications for implementation time (each has an
injected-transport fixture path, so none blocks test authorship): per-scope
admin-consent flags; `?format=pdf` support matrix and size limits;
subscription max TTL and the lifecycle-notification contract; delta
410-resync semantics; Picker v8 postMessage protocol and MSAL SPA
requirements; Entra localhost-redirect rules; delegated sensitivity-label
read surface; itemId stability across moves; cTag presence on SharePoint
library items.

## Displacements and pushback recorded against #492

- `Files.SelectedOperations.Selected` is rejected harder than "evaluate":
  it is a different sync model (per-item grants, no drive delta) that
  contradicts delta-as-truth. `Sites.Selected` is the named v2 tightening.
- The collection-ACL open question is answered **no** (Decision 5); one
  branch of the issue's open choice is the kill condition in disguise.
- Per-folder delta cursors (implied by the issue's delta bullet) are
  displaced in favor of per-drive root delta filtered by enrollment
  ancestry.
- Polling stays on under webhooks for m365 — a deliberate departure from
  the 2026-08-24 webhook-or-poll split, converting subscription loss from a
  correctness bug into a latency blip.
