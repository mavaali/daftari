# Microsoft 365 (Graph) Human-Selected Document Ingestion — Design

Readiness: requirements-only
Date: 2026-09-02
Issue: `mavaali/daftari#492` — "Design human-selected Microsoft 365 document ingestion"
Bead: `mavaali-beads-1wz`
Precedent spec: `docs/superpowers/specs/2026-08-24-google-notion-distill-connectors-design.md`
Precedent plan: `docs/superpowers/plans/2026-08-24-google-notion-distill-connectors.md`
Status: design decision; no implementation issues filed yet (per #492 acceptance criteria)

Claim labels used below: `[DATA]` = read from this repo or from Microsoft's
published docs during this design session; `[TRAINING]` = model knowledge not
verified this session; `[INFERENCE]` = derived, with the kill condition named.

---

## 0. Premise verdict — hold with changes

#492's decision-to-validate (a human connects one M365 account, picks files
with the File Picker, chooses a collection, sees a preview, gets low-confidence
proposals, and only the enrolled set keeps reconciling) **holds**. The
architecture it demands — a third `ProviderAdapter` on `src/integrations/` —
is the right shape and is cheaper than #492 fears: the engine, OAuth
transaction, encrypted state, queue, unavailable-review, and distill staging
are reused unchanged in their contracts, with five small provider-neutral
extensions listed in §2.4.

Three of #492's bets do not survive contact with the code and are overridden:

1. **Transient-PDF conversion for Word/PowerPoint is rejected as the primary
   path.** There is no PDF extractor to share (`docs/integrations.md:7` — PDFs
   are out of scope today; `src/search/watcher.ts` excludes them; the only
   guarded reader is `src/audit/readtext.ts`, which is text-only). Routing
   `.docx`/`.pptx` through Graph `?format=pdf` would make the *hardest*
   extractor (PDF) load-bearing for every type, add a second round trip through
   a pre-authenticated download URL, and provably drop speaker notes (PDF
   export renders slides, not notes). Decision: native OOXML text-run
   extraction for `.docx`/`.pptx`, a bounded PDF text-layer extractor for
   native PDFs, and Graph PDF conversion only as the *lossy fallback* for
   legacy binary `.doc`/`.ppt`. §3.
2. **"Choose a Daftari collection" is not supported by the emitter today.**
   `src/distill/propose.ts:402-425` hardcodes `collection: DISTILL_COLLECTION`
   (`"distill"`, `:39`) and `derivePath` (`:180-192`) roots every proposal under
   `distill/`. The comment at `:16-18` anticipates a config hook. Decision: a
   bounded, allowlisted collection override threaded through
   `DistillIds` → `DistillUpsertInput` → `DistillationInput`, default
   unchanged. §9.
3. **Per-source permission preservation is declared impossible in Daftari's
   ACL and is replaced by explicit, attributable, twice-gated declassification.**
   RBAC is role→collection (`src/access/rbac.ts:46-53`, `RoleConfig` in
   `src/utils/config.ts:32-`); there is no per-document principal list and no
   mapping from Entra identities to Daftari roles. The kill condition
   ("requires a new authorization system") does **not** fire because this
   design does not attempt preservation; it makes the flattening visible and
   signed at enrollment and again at ratification. §9.

Two bets hold as scoped: deployment-owned single-tenant OAuth (§4, with the
kill condition turned into a measured probe rather than a guess) and
delta + webhooks as the sync spine (§6–§7).

Discrepancies confirmed against the repo: bead `daftari-6e2` does not exist;
extraction is owned here. `[DATA]`

---

## 1. What already exists (reuse, don't rebuild)

| Sub-problem | Existing mechanism (verified 2026-09-02) | Reuse |
|---|---|---|
| Adapter contract | `ProviderAdapter` `src/integrations/engine.ts:86-106`; `RemoteSource`/`NormalizedRemoteSource` `:77-84` | Implement as-is; add optional methods (§2.3) |
| Capability gate | `validateContinuousAdapterCapabilities` `engine.ts:179-195` | Microsoft supplies `refreshTokens`, `ensureWebhook`, `verifyWebhook` |
| OAuth transaction (PKCE S256, 10-min state, one-time consume) | `src/integrations/oauth.ts:45-199` | Unchanged; adapter supplies `authorizationUrl`/`exchangeCode` |
| Token refresh | `refreshExpiredTokens` `engine.ts:274-332` | Unchanged; adds a `reconnect_required` marker (§2.4) |
| Encrypted state (AES-256-GCM, 0600, atomic rename, single-writer) | `src/integrations/state.ts:38-56, 243-288` | Unchanged; validators extended for new optional fields |
| Routes + bounded body (256 KiB / 10 s) + `manage_integrations` gate | `src/integrations/routes.ts:61-119, 130-334` | Add provider to regex; add enrollment/status/ui/lifecycle routes |
| Public admission, rate limit, CSRF, callback base | `src/serve/index.ts:146-157, 860-978` | Unchanged |
| Reconcile, provisional cursor, hash gate, limits | `reconcileProvider` `engine.ts:469-681`; `DEFAULT_RECONCILE_LIMITS` `:137-160` | Unchanged |
| Webhook renewal (24 h lead) and wake path | `runtime.ts:227-238, 322-327`; `queue.ts` coalescing `:128-138` | Unchanged |
| Durable queue, tombstones, 5 attempts | `src/integrations/queue.ts` | Add provider to `validQueueItem` |
| Distill staging, verbatim fence, budgets | `src/integrations/distill.ts:101-203`; `DISTILL_NUMERIC_DEFAULTS` `src/utils/config.ts:280-286` | Unchanged except optional `collection` |
| Unavailable-source policy (never erase) | `engine.ts:556-576`; `src/integrations/review.ts` | Unchanged; one added `reason` value |
| Guarded byte reading pattern | `src/audit/readtext.ts` (stat-before-read, NUL sniff, strict UTF-8) | Pattern copied for downloaded bytes; not the same code path (binary input) |
| Operator docs | `docs/integrations.md` | Add a Microsoft section mirroring Google/Notion |
| Adapter tests (injected transport, fixture responses) | `test/integrations/google.test.ts:1-40` | Same harness shape |

---

## 2. Architecture — the third adapter

### 2.1 Shape

```text
browser (operator, manage_integrations role)
  GET  /integrations/microsoft/ui            server-rendered page + vendored msal-browser
  POST /integrations/microsoft/connect       302 → Entra authorize (existing route)
  GET  /integrations/microsoft/callback      code exchange (existing route)
  [File Picker v8 popup: SharePoint-resource token via MSAL PKCE, browser-only]
  POST /integrations/microsoft/enrollments/preview   picker items + collection → estimate + audience
  POST /integrations/microsoft/enrollments           commit enrollment(s), wake reconcile
  GET  /integrations/microsoft/status                per-enrollment / per-source states
  DELETE /integrations/microsoft/enrollments/{id}    unenroll → unavailable + review event

Graph
  POST /integrations/microsoft/webhook               change notifications (clientState) + validationToken echo
  POST /integrations/microsoft/webhook/lifecycle     reauthorizationRequired / subscriptionRemoved / missed

engine (unchanged orchestration)
  timer or queue wake → reconcileProvider → adapter.discover (delta per root)
    → adapter.fetch (download → src/extract worker → text) → hash gate → distill → staged proposals
```

Everything provider-specific lives in `src/integrations/microsoft.ts` (Graph
HTTP, Entra OAuth, delta bookkeeping, subscription fan-out, picker payload
validation) and `src/extract/` (format → text, provider-neutral). `serve`
gains no Microsoft logic (#492 exclusion honored): the new routes are
provider-neutral and dispatch to optional adapter methods.

### 2.2 `ProviderName` decision — extend the closed union, derive it from one list

Recommendation: keep the closed union. `Record<ProviderName, IntegrationAdapterFactory>`
(`runtime.ts:60-63`) is what makes a forgotten factory a compile error; an open
registry would trade that guarantee for flexibility nobody has asked for.
Reduce the cross-cutting cost by deriving everything from one constant:

```ts
// src/integrations/types.ts
export const PROVIDER_NAMES = ["google", "notion", "microsoft"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];
export function isProviderName(v: unknown): v is ProviderName { … }
```

Every edit site (exhaustive, from `rg` on 2026-09-02) `[DATA]`:

| # | File:line | Edit |
|---|---|---|
| 1 | `src/integrations/types.ts:4` | union → derived from `PROVIDER_NAMES`; add `microsoft?: MicrosoftProviderConfig` to `IntegrationConfig` (`:10-16`) |
| 2 | `src/integrations/state.ts:110-112` | `isProviderName` → import from types |
| 3 | `src/integrations/runtime.ts:13, 60-63, 65-67` | import `createMicrosoftAdapter`; add factory; `configuredProviders` iterates `PROVIDER_NAMES` |
| 4 | `src/integrations/routes.ts:51` | regex built from `PROVIDER_NAMES.join("|")` |
| 5 | `src/integrations/queue.ts:94` | `validQueueItem` uses `isProviderName` |
| 6 | `src/utils/config.ts:537-541, 547, 595` | `RECOGNISED_INTEGRATIONS_KEYS` + provider loop from `PROVIDER_NAMES`; a per-provider recognised-key table because Microsoft carries extra keys (§4.4) |
| 7 | `docs/integrations.md` | Microsoft section; state-file table |
| 8 | `test/integrations/*.test.ts`, `test/utils/config.test.ts` | fixtures |

### 2.3 Optional adapter methods (provider-neutral additions to `ProviderAdapter`)

```ts
answerWebhookChallenge?(input: WebhookRequest): string | undefined;     // stateless echo (§6.2)
verifyLifecycleWebhook?(input: WebhookRequest, state: ProviderState): Promise<Result<VerifiedWebhook, Error>>;
resolveEnrollment?(selection: unknown, state: ProviderState, ctx: EnrollmentContext): Promise<Result<EnrollmentDraft, Error>>;
estimateEnrollment?(draft: EnrollmentDraft, state: ProviderState): Promise<Result<EnrollmentEstimate, Error>>;
describeStatus?(state: ProviderState): ProviderStatus;                    // pure, from state only
```

Routes return 404 for providers lacking a method (same pattern as
`webhookSetup !== "manual"` → 404 at `routes.ts:199-202`). Google/Notion
compile unchanged.

### 2.4 Provider-neutral state extensions (all optional, all validated in `state.ts`)

| Field | Type | Written by | Why |
|---|---|---|---|
| `ProviderState.enrollments` | `Record<string, EnrollmentRecord>` (§5.2) | enrollment route | The human-selected subset is a neutral concept (Google could adopt it) |
| `ProviderState.account` | `{ id; tenantId; displayName?; upn? }` | `completeAuthorization` via `ProviderTokens.account?` | Status page shows *which* account; tenant pin for §4 |
| `ProviderState.authorization` | `{ status: "ok" \| "reconnect_required"; at; reason? }` | `refreshExpiredTokens` on terminal refresh failure; cleared on reconnect | #492 step 7 "reconnect-required" state |
| `SourceState.enrollmentId` | `string` | adapter `discover` (via `rememberNewSources`-style hook) | group sources under their enrollment; unenroll |
| `SourceState.lastFailure` | `{ at; reason: ExtractReason \| "fetch" \| "distill" \| "limit" }` | engine, in each `failedSourceIds.push` branch (`engine.ts:597-660`) | #492 step 7 "failed" state; today failures are returned, not persisted `[DATA]` |
| `WebhookChannel.subscriptions` | `Array<{ id; resource; expiresAt }>` | adapter `ensureWebhook` | one channel fans out to N Graph subscriptions (one per drive root) |
| `UnavailableSourceEvent.reason` | add `"unenrolled"` | enrollment route | operator review distinguishes human unenroll from remote loss |
| `ProviderTokens.account` | optional | adapter `exchangeCode` | see `account` |
| `VerifiedWebhook` | add `{ kind: "lifecycle"; eventId; action: "reauthorize" \| "recreate" \| "reconcile" }` | adapter | §6.4 |
| `WebhookRequest.query` | `Record<string,string>` | routes | Graph's `validationToken` arrives as a query param `[DATA]` |
| `DistillationInput.collection` / `DistillUpsertInput.collection` / `DistillIds.collection` | optional string | engine → distill | §9 |

`oauth.ts:110-122` (`providerState()` on reconnect) must carry `enrollments`,
`account`, and reset `authorization` — today it carries only
`sources`/`cursor`/`webhook` `[DATA]`.

The adapter-opaque `ProviderState.cursor` string holds a JSON map of delta
links keyed by root (§7); the engine's provisional-cursor handling
(`engine.ts:527-531, 671-673`) treats it as opaque and needs no change.

---

## 3. Office/PDF → text: the extraction decision

### 3.1 Decision

| Input | Path | Library | Preserves |
|---|---|---|---|
| `.docx` | download → OOXML walker | `fflate` (MIT, zip) + hand-rolled text-run walker in `src/extract/office.ts` | body paragraphs in order, tables (row/cell), text boxes, footnotes/endnotes, inserted tracked text (`w:ins`); drops deleted tracked text (`w:del`), headers/footers, comments |
| `.pptx` | download → OOXML walker | same | slides in `presentation.xml` order, titles/bodies/tables/grouped shapes, **speaker notes** (per-enrollment toggle, default on), skips hidden slides |
| `.pdf` (text layer) | download → PDF text extractor | `pdfjs-dist` legacy build (Apache-2.0), text content only, no rendering | page text in order; no OCR |
| `.doc`, `.ppt` (legacy binary) | Graph `?format=pdf` → 302 → PDF extractor | as above | lossy: no notes, flattened tables; status marks `extractor: "pdf-conversion"` |
| anything else | not a source | — | ignored at discover and filtered in the picker |

Both extractors run in a `worker_threads` Worker (`src/extract/worker.ts`)
with a hard wall-clock timeout and `resourceLimits`, so a pathological file
cannot stall or OOM the `serve` process. The worker receives bytes and a kind
and returns `{ text, pages?, notes? }` or an `ExtractError`; nothing touches
disk.

Why not Graph PDF conversion for everything (#492 bet 1): (a) the PDF path is
greenfield either way, so "one shared path" is a fiction — the OOXML walker is
the *cheaper* of the two extractors, roughly 300 lines with no parser
dependency; (b) speaker notes are lost in PDF export, which #492 itself names
as decision-critical if preservable; (c) conversion adds a Graph call, a
short-lived pre-authenticated URL fetch, and Microsoft-side rendering variance
that makes content hashes unstable across identical source revisions
`[INFERENCE — kill condition: if the corpus shows byte-identical PDF output for
unchanged sources across days, this point is moot]`; (d) `?format=pdf` is
documented for `.docx`/`.pptx` but conversion fidelity is unspecified `[DATA]`.

Why a hand-rolled walker rather than an XML parser: the extractor needs only
element boundaries (`w:p`, `w:tbl`/`w:tr`/`w:tc`, `w:t`, `w:tab`, `w:br`,
`w:ins`/`w:del`, `w:txbxContent`, `a:p`, `a:t`, `a:br`, `p:sp`, `p:graphicFrame`)
and entity decoding; a linear tokenizer over machine-generated OOXML is
bounded and has no DTD/entity-expansion surface. Kill condition: if the
evaluation corpus (§3.4) shows >2 % of decision sentences lost on well-formed
inputs, swap in `fast-xml-parser` behind the same function signature.

### 3.2 Normalized text format (deterministic; hashes depend on it)

- `.docx`: paragraphs joined by `\n`; table rows as cells joined by ` | `;
  footnotes/endnotes appended after a `--- notes ---` line in reference order.
- `.pptx`: `## Slide N` (visible index) line, then paragraphs; tables as
  above; then `[speaker notes]` line + notes paragraphs when enabled.
- `.pdf`: pages joined by `\n\n`; runs joined by space, `hasEOL` → `\n`.
- Whitespace: CRLF→LF, trailing whitespace stripped, ≥3 blank lines collapsed
  to 2. Output must be valid UTF-8 without NUL (mirrors `readtext.ts`).

### 3.3 Failure classes (persisted as `SourceState.lastFailure.reason`)

`too_large` (bytes, inflated bytes, pages, or text), `encrypted` (OLE
`EncryptedPackage` container or PDF password), `malformed` (not a zip / no
`[Content_Types].xml` / pdfjs parse error), `empty` (no extractable text — the
scanned-PDF signal), `unsupported_type`, `timeout`, `malware` (driveItem
`malware` facet present → never downloaded), `permission_revoked` (403/404 on
fetch), `converted_unavailable` (legacy `?format=pdf` non-302).

### 3.4 Evaluation corpus plan (adjudicates #492 kill condition "conversion loses decision-critical content")

Location `test/fixtures/extract/`; every fixture is synthetic and small
(hand-authored OOXML zips and generated PDFs; no real corporate documents).
Each fixture ships with `<name>.expected.txt` (golden normalized text) and
`<name>.decisions.json` (the list of *decision sentences* that must survive as
substrings). Cases:

| Class | Fixtures |
|---|---|
| Word | headings + lists + 2 tables + footnote; tracked changes (ins kept, del dropped); text box; empty body; 40 MB inflated `document.xml` with a 200 KB zip (bomb → `too_large`); truncated zip (`malformed`); OLE compound `EncryptedPackage` (`encrypted`); non-UTF-8 entity soup |
| PowerPoint | 3 slides with notes + table + group; hidden slide; slide order ≠ filename order; empty deck; notes-only content |
| PDF | text-layer 3 pages; scanned (images only → `empty`); password-protected (`encrypted`); 600 pages (`too_large`); malformed xref; mixed fonts/ligatures |
| Legacy | `.doc`/`.ppt` served through a recorded `?format=pdf` transport fixture (302 → bytes); asserts the *known* loss (notes absent) so the lossy label is evidence-backed |
| Access | 403 on content; 404 on item; `malware` facet; 429 with `Retry-After` |

Metric per fixture: decision-sentence recall (must be 100 % for OOXML/PDF
happy paths), failure-reason exactness for the negative cases, and measured
`text_chars / source_bytes` per type (feeds §12 estimates). The legacy PDF
path is expected to *fail* the notes fixture — that failure is the recorded
evidence for keeping conversion out of the primary path.

### 3.5 Extraction data-flow traces

- Happy: 2 MB `.pptx` → 302 followed without `Authorization` → 2 MB in memory
  → worker → 14 KB text → hash differs → distill → proposals; bytes and text
  dropped at function return.
- Empty: scanned PDF → `empty` → `failedSourceIds` + `lastFailure` → status
  "failed: no text layer"; retried each cycle only if revision changes
  (revision unchanged → the engine's unchanged fast path never re-fetches
  because `contentHash` is still empty… `[DATA]` `engine.ts:585-588` requires
  `contentHash.length > 0` for the fast path, so it *does* re-fetch each cycle).
  Decision: adapter short-circuits — if `lastFailure.reason ∈ {empty, encrypted,
  unsupported_type, too_large}` and `revision` unchanged, `fetch` returns the
  same failure without downloading.
- Error: worker timeout → `timeout`; the worker is terminated; the cycle
  continues with the next source.
- Upstream: 429 → honor `Retry-After` once if ≤ 30 s, else fail the cycle
  (`discover`/`fetch` return `err`), cursor stays provisional and replays.

---

## 4. OAuth, Entra app, scopes, tenant consent

### 4.1 App registration (deployment-owned, single tenant)

One Entra app registration in the customer's tenant, created once by whoever
holds the "can register applications" right (any user by default; IT in
locked tenants `[TRAINING]`):

- Audience: "Accounts in this organizational directory only" (single tenant) `[DATA]`.
- Platform **Web**: redirect `{base}/integrations/microsoft/callback`
  (confidential client, client secret in the env var named by
  `client_secret_env`).
- Platform **SPA**: redirect `{base}/integrations/microsoft/ui` (the picker
  page; PKCE public client, same client id, no secret in the browser).
- Delegated Microsoft Graph permissions: `Files.Read.All`, `offline_access`,
  `User.Read`.
- Delegated SharePoint permissions (picker only): `AllSites.Read`,
  `MyFiles.Read` `[DATA — picker docs]`.
- No application permissions. No `Sites.Read.All`.

`{base}` is `server.public_base_url` when set, else the loopback
`httpCallbackBase` (`src/serve/index.ts:146-157`), exactly as Google/Notion
(`docs/integrations.md:98-116`). Entra accepts `http://localhost` and
`http://127.0.0.1` loopback redirects for the Web platform `[TRAINING]`;
webhooks stay off on loopback and the reconciler polls (existing behavior).

### 4.2 Scopes — decision and the one fact to verify first

- **Server (Graph):** `Files.Read.All offline_access User.Read`.
  `Files.Read.All` covers OneDrive and every SharePoint library item the user
  can already open, addressed by `/drives/{driveId}/items/{itemId}` `[TRAINING]`.
  Graph's delta and content-format pages list `Files.Read` as least
  privileged `[DATA]`, but the permissions reference distinguishes "user's
  files" (`Files.Read`) from "all files the user can access"
  (`Files.Read.All`) `[TRAINING]`. A config profile `scope_profile:
  onedrive | sharepoint` (default `sharepoint`) selects `Files.Read` vs
  `Files.Read.All`; the first implementation probe verifies that
  `Files.Read` alone cannot read a SharePoint library item, and if it can,
  the default flips to the narrower scope.
- **Not chosen:** `Files.Read.Selected` / `Files.SelectedOperations.Selected`.
  These are delegated, non-admin (`isAdmin: false`) but their grant is
  "files explicitly permissioned to the application … configured in
  SharePoint Online or OneDrive" `[DATA — permissions-descriptions.json]`,
  i.e. an admin-side per-item grant, not a picker-driven one. `Sites.Selected`
  is likewise a site-collection grant configured by an admin. Neither maps to
  "a human picks files in a browser". They are the right scopes for a future
  application-permission (headless) mode, not for V1.
- **Admin consent required?** Unverified this session: two fetches of the
  permissions reference truncated before the `F`/`S` entries; the
  summarizer's earlier claim that `Files.Read.All` needs admin consent is
  therefore `[TRAINING, contested]`. Whether *any* delegated scope needs
  admin consent is also a tenant policy ("disable user consent" /
  "verified publishers, low-impact only" / "all applications") `[DATA]`, and a
  single-tenant app registered in the same tenant counts as "your
  organization" under the middle policy `[DATA]`.

### 4.3 Adjudicating "most target users cannot obtain tenant consent"

The kill condition is real but it is a *measurement*, not a design fact. The
design minimizes what has to be consented (three delegated Graph scopes, two
SharePoint read scopes, no application permissions, single tenant) and writes
the setup as a one-page IT ticket in `docs/integrations.md`. The probe:

- Instrument the connect flow's failure modes (`AADSTS65001` consent
  required, `AADSTS900xx` app-registration policy) into the status page as
  `reconnect_required` reasons, so the operator sees *which* step blocked.
- Pilot in three tenants (a personal dev tenant, a default-policy business
  tenant, a locked-down tenant). Kill fires if the locked-down tenant cannot
  reach admin consent within five business days via the built-in admin
  consent request workflow `[DATA]`; the reframe then is a multitenant,
  publisher-verified registration (explicitly out of V1).

### 4.4 Config

```yaml
integrations:
  microsoft:
    client_id_env: MS_OAUTH_CLIENT_ID
    client_secret_env: MS_OAUTH_CLIENT_SECRET
    tenant_id: "<guid or verified domain>"       # authority https://login.microsoftonline.com/{tenant}
    scope_profile: sharepoint                     # onedrive | sharepoint (default)
    collections: ["distill", "decisions"]         # allowlist for enrollment targets (§9)
    include_speaker_notes: true                   # default for new enrollments
    picker_host: "https://contoso-my.sharepoint.com"   # optional override; else derived from /me/drive.webUrl
```

Secrets stay in env vars (existing rule). `validateIntegrationProvider`
gets a per-provider recognised-key table.

### 4.5 Token lifecycle and reconnect

Authorization URL: `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize`
with `response_type=code`, PKCE S256 (`oauth.ts:37-39`), `scope` from the
profile plus `offline_access`, `prompt=select_account`. Exchange and refresh at
`/oauth2/v2.0/token` (`client_secret` + `code_verifier`). Refresh returns a
rotated refresh token; store it. `exchangeCode` also calls `GET /me?$select=id,displayName,userPrincipalName`
and returns `ProviderTokens.account`; the tenant id is read from the id token's
`tid` claim (no signature verification needed for a value only displayed;
`[INFERENCE]` — if `tid` is absent, fall back to `/organization`).

Terminal refresh errors (`invalid_grant`, `interaction_required`,
`AADSTS70008` expired refresh token) set `authorization.status =
reconnect_required`; every cycle then returns `err` early (as today, `engine.ts:294-`)
and the status page shows **Reconnect** → `/connect` (which retains
enrollments, sources, cursor, webhook — `oauth.ts:110-122` extended).

Traces: happy (code → tokens → `/me` → state written → wake); empty (callback
with unknown `state` → 400 `oauth_callback_rejected`, existing); error (Entra
returns `error=consent_required` → callback 400 + `authorization.reason`
recorded for the status page); upstream (token endpoint 5xx → prior state
retained, safe diagnostic — existing behavior).

---

## 5. File Picker v8 enrollment

### 5.1 Browser flow

The `ui` page (server-rendered, `writeHtml` in `src/serve/index.ts:393`;
cookie- or bearer-authenticated via the existing `authorize`; CSRF cookie
echoed on POSTs) loads a vendored `@azure/msal-browser` from
`/integrations/microsoft/ui/assets/`. On "Select files":

1. MSAL acquires a SharePoint-resource token (`{pickerHost}/.default`) via
   PKCE popup; the picker "relies on SharePoint tokens and not Graph" `[DATA]`.
2. Opens the picker as a **popup** (not iframe) and POSTs the form to
   `{pickerHost}/_layouts/15/FileBrowser.aspx` with
   `fileBrowser={sdk:"8.0", entry:{oneDrive:{files:{}}}, authentication:{},
   messaging:{origin, channelId}, typesAndSources:{mode:"all",
   filters:[".docx",".pptx",".pdf",".doc",".ppt","folder"],
   pivots:{oneDrive:true, recent:true, shared:true, sharedLibraries:true}},
   selection:{mode:"multiple", maximumCount:50}}` `[DATA — v8 schema]`.
   Popup keeps the page CSP to `default-src 'self'; script-src 'self';
   connect-src 'self' https://login.microsoftonline.com https://*.sharepoint.com;
   form-action 'self' https://*.sharepoint.com`. `serve` sets no CSP today
   `[DATA]`; this page sets its own.
3. The `pick` result's items are POSTed to `/enrollments/preview`. The
   browser never sends its SharePoint token to Daftari; only item references
   cross the boundary.

`[INFERENCE]` A OneDrive-hosted picker can browse SharePoint libraries via
the shared-libraries pivot with `AllSites.Read`; verify in the first probe,
else the page offers a second "Browse a SharePoint site" entry with
`entry.sharePoint.byPath.web` supplied by the operator.

### 5.2 Enrollment record (in the encrypted envelope)

```ts
interface EnrollmentRecord {
  id: string;                       // uuid
  kind: "item" | "container";       // file vs folder
  driveId: string; remoteId: string;
  siteId?: string; listId?: string; // from picker sharepointIds when present
  label: string; webUrl?: string;   // display only
  collection: string;               // allowlisted target (§9)
  includeSpeakerNotes: boolean;
  enrolledBy: string; enrolledAt: string;
  audienceAckAt: string; readersAtEnrollment: string[]; // §9 disclosure
  cursorKey: string;                // "enrollment:<id>" or "drive:<driveId>"
}
```

`resolveEnrollment` validates the picker payload server-side by fetching each
item's metadata (`GET /drives/{driveId}/items/{id}?$select=id,name,eTag,file,folder,size,webUrl,sharepointIds,parentReference,malware`)
with the **server's** delegated token, so a forged payload cannot enroll
something the connected account cannot read. Items the account cannot read
are rejected with the item name (never enrolled silently).

### 5.3 Folder expansion and bounds

A container enrollment is expanded by folder-scoped delta at first discovery
(§7.1), recursively, filtered to supported extensions, bounded to 1,000 files
per container and 2,000 enrolled sources per vault (below the engine's 10,000
so one folder cannot consume the cycle). Exceeding a bound fails the
enrollment at preview time ("folder has 1,342 eligible files; enroll
sub-folders") rather than truncating silently. New files appearing later in
an enrolled folder are picked up by delta and count against the same bound;
crossing it marks the enrollment `over_limit` in status and stops adding.

Traces: happy (3 files + 1 folder → preview → confirm → 47 sources pending →
first cycle distills); empty (picker returns zero items → 400 `empty_selection`);
error (payload references a drive the account cannot read → 422 with names);
upstream (Graph 429 during metadata check → preview fails with "retry",
nothing persisted).

---

## 6. Graph webhook lifecycle onto `ensureWebhook` / `verifyWebhook`

### 6.1 Subscription model

Subscriptions exist only on a drive root `[DATA — driveItem relationships:
"Only supported on the root of a drive"]`, support only `changeType: updated`
`[DATA]`, and expire after at most 42,300 minutes `[DATA]`. So: one Graph
subscription per **drive** touched by any enrollment, `resource:
/drives/{driveId}/root`, `expirationDateTime = now + 41,000 min`, one shared
`clientState` (32 random bytes base64url, ≤128 chars `[DATA]`), `notificationUrl
= {public}/integrations/microsoft/webhook`, `lifecycleNotificationUrl =
{public}/integrations/microsoft/webhook/lifecycle`.

`ensureWebhook(state, {callbackUrl, now, renewBefore})`:
- requires HTTPS callback (as Google, `google.ts:626-628`);
- for each enrolled drive: existing subscription with `expiresAt > renewBefore`
  → keep; else `PATCH /subscriptions/{id}` with a new expiration; 404 → `POST /subscriptions`;
- drives with no enrollments → `DELETE /subscriptions/{id}`;
- returns `{ id: channelSetId (stable uuid per provider state), secret:
  clientState, expiresAt: min(subscription expirations), subscriptions: [...] }`.
  The engine's 24 h renewal lead (`runtime.ts:20, 227-238`) then triggers the
  next renewal on whichever subscription is earliest.

### 6.2 Validation handshake

Graph POSTs `?validationToken=…` and expects `200 text/plain` with the decoded
token within 10 s `[DATA]`. This happens *while* `ensureWebhook` is inside the
state lock, and on first creation `state.webhook` is undefined, so the
existing engine path would demand a manual setup token. Hence the stateless
`answerWebhookChallenge(input)` adapter method: the route calls it *before*
`verifyProviderWebhook`; a returned string is written as `200 text/plain`
(one new branch at `routes.ts:275-`). The echo carries no secret and is
rate-limited by `admitPublic`.

### 6.3 Event verification

`verifyWebhook` parses `{ value: [...] }`, requires every entry's
`clientState` to equal the secret (timing-safe), and every `subscriptionId`
to be in `webhook.subscriptions`. Drive notifications carry no item identity
`[DATA — the delta doc: "Delta query is the only way…"; scan guidance: follow
the notification with delta]`, so the hint is `{ kind: "reconcile" }` (as
Google). Event id: the notification's `id` when present, else
`${subscriptionId}:${receivedAt}:${uuid}` — Graph retries then produce distinct
ids that the queue coalesces (`mergeHints`) rather than tombstones that would
suppress future legitimate notifications. Respond `202` within 3 s `[DATA]`
(the route already enqueues then responds).

### 6.4 Lifecycle notifications

`verifyLifecycleWebhook` validates `clientState` and maps:
`reauthorizationRequired` → `{kind:"lifecycle", action:"reauthorize"}` (next
cycle calls `POST /subscriptions/{id}/reauthorize`, then reconciles);
`subscriptionRemoved` → `recreate` (drop from set; `ensureWebhook` recreates);
`missed` → `reconcile`. All enter the durable queue; none mutate state in the
request path. Lost-subscription recovery without lifecycle events: the
polling timer (`polling_interval_minutes`, default 15) is the safety net and
Microsoft's own guidance recommends a periodic delta regardless `[DATA]`.

Traces: happy (create → validation echo → 201 → stored); empty (no enrolled
drives → no subscriptions, `expiresAt` undefined → engine treats as needing
renewal each cycle → `ensureWebhook` returns the empty set; cheap); error
(validation fails because the public URL is unreachable → `ensureWebhook`
err → `onError("webhook renewal failed")`, polling continues); upstream
(Graph 403 `ExtensionError` on subscription for a drive → that drive is
marked `webhook: unavailable` in status, others proceed).

---

## 7. Graph `delta` onto the cursor contract

### 7.1 Roots and initialization

`ProviderState.cursor` = `{"v":1,"roots":{"<cursorKey>":"<@odata.deltaLink>"}}`.

- Container enrollment → `cursorKey = enrollment:<id>`, delta on
  `/drives/{driveId}/items/{folderId}/delta` `[INFERENCE from the v1.0 SDK
  surface `Drives[id].Items[id].Delta`; kill condition: a 400 on a SharePoint
  library folder → fall back to drive-root delta with ancestry filtering by
  `parentReference.id` chains, tracked by id because delta omits
  `parentReference.path` [DATA]]`. Initial call enumerates the subtree
  (bounded §5.3) and yields the first `deltaLink`.
- Item enrollments → grouped per drive, `cursorKey = drive:<driveId>`,
  initialized with `/drives/{driveId}/root/delta?token=latest` `[DATA]` so a
  large library is never enumerated; the enrolled items are fetched by id once
  at enrollment for their revision.
- `$select=id,name,eTag,cTag,size,file,folder,deleted,parentReference,malware`;
  `deltaExcludeParent` header to skip ancestor echoes `[DATA]`.

### 7.2 Discovery algorithm (per cycle)

For each root: follow `@odata.nextLink` pages (≤1,000 pages, repeated-link
guard as `google.ts:465-472`), apply items to the remembered set (last
occurrence wins `[DATA]`): `deleted` facet or parent outside the enrolled
subtree → remove; supported file → upsert `{id, revision}`; folder → track
for ancestry. Collect the terminal `@odata.deltaLink` per root into a new
cursor map. Return the **entire** enrolled, present set (as Google does via
`rememberedSources`), so the engine's not-returned → unavailable rule
(`engine.ts:556-576`) marks deleted/moved-out/inaccessible items.

Cursor commit: the adapter sets `state.cursor` to the new map; the engine
restores the previous value until every source succeeds and commits only
then (`engine.ts:527-531, 671-673`). One failed source therefore replays
*all* roots next cycle; replay is idempotent (revision equality → unchanged
fast path; hash gate → no LLM). Accepted V1 cost.

### 7.3 Resync

`410 Gone` with `resyncChangesApplyDifferences` / `resyncChangesUploadDifferences`
and a `Location` starting a fresh enumeration `[DATA]` → the adapter drops
that root's link and re-initializes it (container: full subtree; item group:
`token=latest` + per-item metadata refresh). Bounded by the same limits. This
is the Google `changes` 410 path (`google.ts:486-488`) per root.

Traces: happy (two roots, 3 changed items → 3 fetches); empty (no
enrollments → `ok([])` → all remembered sources become unavailable with
review events — correct after "unenroll all"); error (malformed page → `err`
→ cycle fails, cursor untouched); upstream (410 → resync; 429 → single
bounded retry else fail-cycle).

---

## 8. Stable source identity and revision

- `RemoteSource.id = "${driveId}:${itemId}"`. Graph item ids are unique only
  within a drive; ids contain `!` and base64url characters but no `:` `[TRAINING]`.
  `sourceIdentity` yields `microsoft:<driveId>:<itemId>` in proposals'
  `sources:` refs. Ids survive rename and move *within* a drive `[DATA —
  "track items by id"]`; a cross-drive move is a new id (old → unavailable,
  new → source only if inside an enrolled root).
- `RemoteSource.revision = eTag`. `cTag` would be the content-only choice but
  delta on OneDrive for Business omits `cTag` on create/modify `[DATA]`.
  Metadata-only edits therefore trigger a fetch, and the normalized-text
  SHA-256 gate (`engine.ts:636-642`) prevents an LLM call. `fetch` echoes the
  discovered revision (the engine requires equality, `engine.ts:611-616`); if
  the item changed between delta and download, the next delta reports the
  newer eTag and the hash gate does the rest.
- Legacy-conversion sources use the same identity/revision; only the
  extractor differs.

---

## 9. The ACL decision (discrepancy #3)

**Decision: option (c) with two mechanical guardrails and one honest
disclosure — "explicit declassification", not "permission preservation".**

What Daftari can express: `RoleConfig.read/write` per collection, `ratify`,
`manage_integrations` (`rbac.ts:46-53, 95-97`). What it cannot: who in Entra
can read a driveItem, and how that maps to Daftari roles. Option (a)
("target readers ⊆ source readers") needs an Entra→role identity mapping —
that *is* a new authorization system; the kill condition would fire. Option
(b) (label→collection) needs `extractSensitivityLabels` per item, which
requires broader scopes `[TRAINING]`, and still cannot verify the reader-set
inclusion. Neither is built.

What is built:

1. **Allowlisted target collection + writer check.** `collection` must be in
   `integrations.microsoft.collections`; the enrolling principal's role must
   `canWrite(collection)` (`IntegrationRouteAuthorization` gains `user` and
   `role`; the serve adapter at `src/serve/index.ts:860-` already resolves
   them). Default collection stays `distill`; proposals keep `status: draft`,
   `confidence: low`, `provenance: synthesized`, `proposed_by: agent:distill`
   (`propose.ts:402-425`, unchanged invariants). The only emitter change is
   the collection/path root.
2. **Audience disclosure and acknowledgement.** The preview response lists
   the roles that can read and ratify the target collection (computed from
   config); the enrollment stores `readersAtEnrollment` and `audienceAckAt`.
   Ratification (`vault_ratify`, `ratify` grant, `staged-actions.ts:158-180`
   write-gate) is the second human gate. Flattening is therefore never
   *silent* (#492's word) — it is a signed act by two humans.
3. **Fail-closed for protected content.** IRM/sensitivity-label-encrypted
   Office files download as an encrypted container `[TRAINING]`; the walker
   classifies them `encrypted` and they are never distilled. Password PDFs
   likewise. The strongest label class is mechanically excluded without
   reading labels.
4. **Disclosure in status:** `sensitivity_labels: not checked (V1)`.

What breaks: a human can enroll a document they are allowed to read into a
collection readable by roles who could not read the source. That is the same
power `vault_write` already gives any writer of that collection; the design
makes it attributable (`enrolledBy`, `audienceAckAt`, `sources:` refs with
`microsoft:` ids). If a deployment requires true preservation, that is a
separate design (identity mapping), explicitly out of V1.

---

## 10. Deletion, access loss, GDPR — onto the unavailable-source policy

| Microsoft-side event | Detection | Daftari effect (never erases knowledge) |
|---|---|---|
| Item deleted / recycled | delta `deleted` facet | `available:false`, review event `no_longer_discovered` (existing) |
| Item moved out of enrolled folder / cross-drive | delta parent change / new id | same as deletion; the new location is not auto-enrolled |
| Permission revoked | metadata/content 403/404 → item omitted from discovery (item groups) or absent from delta | same as deletion; status reason `permission_revoked` when the fetch saw it |
| Human unenrolls | route | review event `unenrolled` + engine's `no_longer_discovered` next cycle; sources retained as metadata |
| Account disconnected / consent revoked | refresh `invalid_grant`; lifecycle `reauthorizationRequired` | `reconnect_required`; no source state changes |
| Correction (document edited) | new eTag | new proposals; prior ratified claims untouched — the ratifier supersedes explicitly (`vault_supersede`), never the connector (keystone: a change is not a supersession) |
| Data-subject erasure request | out-of-band | operator reviews `integration-review.jsonl` and, only with the `erase` grant, runs `vault_erase` (`rbac.ts:73`); the connector never invokes it |

Encrypted state holds ids, eTags, hashes, enrollment metadata, and display
labels (`label`, `webUrl`) — no bodies. Queue/review files carry ids and
reasons only (`docs/integrations.md:219-236` retention unchanged).

---

## 11. Limits table

| Bound | Value | Where enforced |
|---|---|---|
| Graph request timeout / JSON response | 30 s / 8 MiB | adapter (`RequestLimits`, as Google) |
| Download bytes per file (`.docx/.pptx/.pdf`, and converted PDF) | 25 MiB | adapter, `Content-Length` precheck + streaming cap |
| Inflated OOXML per entry / total | 32 MiB / 96 MiB | `fflate` filter on declared sizes + running total |
| PDF pages | 500 | extractor |
| Extraction wall-clock / worker heap | 60 s / 512 MB | worker `resourceLimits` + terminate |
| Normalized text per source / per cycle | 8 MiB / 64 MiB | engine (existing) |
| Sources per vault / per container enrollment / per pick | 2,000 / 1,000 / 50 | adapter + picker `maximumCount` |
| Delta pages per root / discovery roots per cycle | 1,000 / 200 | adapter |
| Subscriptions | one per enrolled drive; expiry ≤ 41,000 min; renew ≥ 24 h ahead | adapter + runtime lead |
| Webhook body / lifecycle body | 256 KiB / 10 s | routes (existing) |
| 429 handling | one retry if `Retry-After ≤ 30 s`, else fail cycle | adapter transport |
| Distill per source | `maxLlmCalls 100`, `maxClaims 50`, `inCallInputCap 16000`, `maxVerbatimChars 8000` | existing config |

---

## 12. Cost / work preview (#492 step 4)

`estimateEnrollment(draft)` runs during `/enrollments/preview` using
metadata only (no downloads): per eligible item `estChars = min(size, 25 MiB) ×
ratio[type]` with initial ratios docx 0.35, pptx 0.05, pdf 0.5
`[INFERENCE; replaced by the measured ratios from §3.4]`; `estCalls =
Σ min(maxLlmCalls, ceil(estChars / inCallInputCap))` using the vault's
`distill` config (`DISTILL_NUMERIC_DEFAULTS` fallbacks). The response:

```json
{ "eligible": 47, "skipped": [{"name":"budget.xlsx","reason":"unsupported_type"}],
  "bytes": 61234567, "byType": {"docx": 30, "pptx": 12, "pdf": 5},
  "estimatedCalls": {"low": 60, "expected": 118, "high": 236},
  "estimatedUsd": {"expected": 0.71},
  "collection": "decisions", "readers": ["integration-operator","analyst"], "ratifiers": ["integration-operator"],
  "warnings": ["1 legacy .ppt will use lossy PDF conversion"] }
```

`estimatedUsd` appears only when `distill.estimated_usd_per_call` (new
optional config key) is set; Daftari has no pricing table and will not invent
one. The page renders this beside the collection dropdown and the audience
disclosure; "Enroll" is disabled until the acknowledgement checkbox is set.

---

## 13. Browser operator flow and states (#492 step 7)

`GET /integrations/microsoft/status` (JSON, drives the page):

- Connection: `disconnected` | `connected(account)` | `reconnect_required(reason)`.
- Webhook: `off (no public_base_url)` | `active(n subscriptions, earliest expiry)` | `degraded(drive list)`.
- Per enrollment: label, collection, counts by source state.
- Per source: `pending` (enrolled, `contentHash` empty, no failure) |
  `current` (available, `lastDistillRunId` set, `lastSeenAt`) |
  `failed(reason, at)` (`lastFailure` set, still available) |
  `unavailable(since)` (`available:false`) | `over_limit`.
- Last cycle: `distilled / unchanged / failed / unavailable` counts from the
  most recent `ReconcileOutcome` (kept in memory by the runtime; the status
  route reads it through `describeStatus`).

Five-minute path (#492 kill condition 1): connect (≈30 s) → pick (≈60 s) →
preview + ack (≈30 s) → wake → first cycle downloads + extracts + one distill
call per chunk. With `claude-haiku` and a 20-page doc this is under two
minutes `[INFERENCE; measured in the pilot]`.

---

## 14. Requirements (stable R-IDs for `writing-plans`)

Architecture and provider identity
- **R1** `microsoft` is a `ProviderName` derived from `PROVIDER_NAMES`; every site in §2.2 is updated; Google/Notion behavior is byte-identical.
- **R2** `src/integrations/microsoft.ts` implements `ProviderAdapter` with `refreshTokens`, `ensureWebhook`, `verifyWebhook`, `discover`, `fetch`, plus the optional methods in §2.3; no Microsoft-specific code in `serve` or the engine.
- **R3** State extensions in §2.4 are optional, validated in `state.ts`, and round-trip through the encrypted envelope; old envelopes without them still parse.
- **R4** `oauth.ts` reconnect retains `enrollments`, `account`, `sources`, `cursor`, `webhook` and clears `authorization`.

OAuth / Entra
- **R5** Authorization uses the tenant authority from `tenant_id`, PKCE S256, scopes per `scope_profile` + `offline_access` + `User.Read`; the client secret is used only server-side.
- **R6** `exchangeCode` returns rotated refresh tokens and `account`; refresh persists the rotated token.
- **R7** Terminal refresh failures set `authorization.status = reconnect_required` with a reason; the status route exposes it; `/connect` clears it.
- **R8** `docs/integrations.md` documents the app registration (Web + SPA redirect, five delegated permissions, single tenant) and the loopback vs public callback behavior.

Picker and enrollment
- **R9** The `ui` page hosts the File Picker v8 in a popup with the configuration in §5.1 and never transmits the browser's SharePoint token to Daftari.
- **R10** `/enrollments/preview` and `/enrollments` require `manage_integrations`, CSRF for cookie sessions, `collection ∈ integrations.microsoft.collections`, and `canWrite(role, collection)` for the caller.
- **R11** `resolveEnrollment` re-fetches every picked item with the server token and rejects unreadable or unsupported items by name.
- **R12** Container enrollments expand recursively to supported files only, bounded per §5.3; bound violations fail the preview, never truncate silently.
- **R13** The enrollment record persists `enrolledBy`, `audienceAckAt`, `readersAtEnrollment`, `collection`, `includeSpeakerNotes`.
- **R14** `DELETE /enrollments/{id}` appends an `unenrolled` review event per source and removes the enrollment; source metadata is retained.

Webhooks
- **R15** `ensureWebhook` maintains one subscription per enrolled drive with the parameters in §6.1 and returns a fan-out channel whose `expiresAt` is the earliest expiry.
- **R16** `answerWebhookChallenge` echoes `validationToken` as `200 text/plain` without touching state; the route calls it before engine verification.
- **R17** `verifyWebhook` rejects any notification whose `clientState` or `subscriptionId` is unknown; accepted notifications enqueue `{kind:"reconcile"}` with a unique event id; the route answers `202` before reconciliation.
- **R18** `verifyLifecycleWebhook` maps `reauthorizationRequired`/`subscriptionRemoved`/`missed` to queued actions; `reauthorize` is executed in-cycle.
- **R19** Without `public_base_url`, no subscription is attempted and polling covers reconciliation (existing behavior preserved).

Delta and identity
- **R20** `cursor` is a versioned JSON map of per-root delta links; container roots use folder-scoped delta; item groups use drive-root `token=latest`.
- **R21** `discover` returns the full enrolled present set with `id = driveId:itemId`, `revision = eTag`, applying delta semantics (last occurrence wins, `deleted` removes, out-of-subtree removes).
- **R22** `410 Gone` re-initializes only the affected root; cursor commit remains engine-controlled (only when no source failed).
- **R23** Pagination is bounded (1,000 pages/root) with a repeated-link guard; 429 is retried once within 30 s else fails the cycle without cursor advance.

Extraction
- **R24** `src/extract/` provides `extractText(bytes, kind, limits)` for `docx`, `pptx`, `pdf` in a worker with the limits of §11 and the failure classes of §3.3; it is provider-neutral and has no Graph imports.
- **R25** `.docx` output preserves paragraph order, tables, text boxes, footnotes/endnotes, inserted tracked text; excludes deleted tracked text, headers/footers, comments.
- **R26** `.pptx` output preserves slide order from `presentation.xml`, skips hidden slides, and includes speaker notes when the enrollment enables them.
- **R27** `.pdf` extraction is text-layer only; password-protected → `encrypted`; no text → `empty`.
- **R28** Legacy `.doc`/`.ppt` go through Graph `?format=pdf` → PDF extractor; the 302 is followed without the `Authorization` header; status labels the source `pdf-conversion`.
- **R29** Items with a `malware` facet are never downloaded; downloads exceeding 25 MiB are refused before reading the body.
- **R30** `fetch` short-circuits repeat failures (`empty`, `encrypted`, `unsupported_type`, `too_large`) while the revision is unchanged.
- **R31** The evaluation corpus of §3.4 exists as fixtures with golden text and decision-sentence assertions; the legacy path's notes loss is asserted as expected.

Distill and ACL
- **R32** `DistillationInput.collection` flows to `proposeAllClaims`; unset → `distill` (byte-identical current behavior); set → proposals carry that `collection` and path root, with all other frontmatter invariants unchanged.
- **R33** The preview reports readers and ratifiers of the target collection from config; enrollment is refused without acknowledgement.
- **R34** Encrypted/IRM-protected files are never distilled; status shows `sensitivity_labels: not checked`.

Lifecycle, status, deletion
- **R35** Engine persists `SourceState.lastFailure` on every failure branch; success clears it.
- **R36** `/status` reports the states in §13 for connection, webhook, enrollments, and sources, and the last cycle summary.
- **R37** Deletion, move-out, and access loss all resolve to `available:false` plus a review event; no derived document is modified.
- **R38** Reconnect, unenroll, and disconnect never delete source metadata or proposals.

Cost preview
- **R39** `/enrollments/preview` returns the estimate shape in §12; USD appears only when `distill.estimated_usd_per_call` is configured.

Tests
- **R40** All adapter, extractor, route, and runtime tests use injected transports, fixture bytes, and an injected distill; no test contacts Microsoft or an LLM.

---

## 15. NOT in scope (one-line rationale each)

- Excel — PDF/text flattening destroys cell semantics; needs a sheet-aware extractor (#492).
- OCR / scanned PDFs — `empty` is reported, not guessed; OCR is a different cost class.
- Teams, email, meetings, calendars, tenant-wide discovery — different resources, application permissions, and consent posture.
- Work IQ in the pipeline — discovery aid at most; the human confirms Graph items (#492).
- Automatic ratification — keystone: the connector proposes, humans ratify.
- Write-back to M365 — read-only source system (#492).
- Multitenant / publisher-verified app — only if the §4.3 probe kills single-tenant.
- Application-permission (headless) mode with `Files.SelectedOperations.Selected` / `Sites.Selected` — the right future for unattended service ingestion; not human-directed.
- Sensitivity-label reading and label→collection policy — needs broader scopes and an audience model Daftari lacks; V1.1 candidate after §9 has run in a pilot.
- Per-source permission preservation / Entra→role identity mapping — a new authorization system by definition.
- Multiple M365 accounts per vault — one `ProviderState` slot, as Google/Notion.
- Header/footer, comments, and deleted-tracked-text extraction — boilerplate or non-authoritative; revisit with corpus evidence.
- `daftari distill --file x.docx` CLI reuse of `src/extract/` — trivial follow-up, not this slice.
- Google Drive PDF support via the same extractor — the precedent spec's follow-up; unblocked by this design, not delivered by it.
- Per-root cursor commit (partial-failure isolation) — accepted replay cost in V1.

---

## 16. Failure-mode check

**If it succeeds wildly (scale):** 2,000 sources across 30 drives → 30
subscriptions, 30 delta roots per cycle (cheap when unchanged), notification
storms coalesced by the queue; a busy SharePoint library's drive-root delta
returns many non-enrolled items per page — bounded by pages, filtered by id;
the real ceiling is distill spend, which the preview and `maxLlmCalls` bound
per source, and which humans then must ratify (#492 kill condition 3 is the
one to watch: proposals piling up unratified). Throttling (429) degrades to
slower cycles, never to data loss.

**If it fails (rollback):** removing `integrations.microsoft` from config
removes routes and adapters at next start; the encrypted envelope keeps the
Microsoft entry inert (validators accept it, nothing reads it); proposals
already staged remain ordinary staged actions; nothing in the vault was
written except through ratification. Subscriptions expire within 29 days on
their own. No migration is needed to go back.

**Six months on:** enrolled folders grow past bounds (status shows
`over_limit`; the operator splits the enrollment); refresh tokens expire after
long inactivity `[TRAINING: ~90 days]` → `reconnect_required` is visible, not
silent; Microsoft revises the picker (a Microsoft-hosted control — the page
pins `sdk: "8.0"` and the probe suite catches schema drift); the extractor's
ratios drift from the corpus (preview accuracy degrades, not correctness).
The largest six-month risk is social, not technical: humans enroll but do not
ratify. The status page's `pending ratification` count per enrollment exists
to make that visible early.

---

## 17. Test constraint (hard)

Every test injects the HTTP transport (`(url, init) => Promise<Response>`,
as `test/integrations/google.test.ts:26-34`) and the distill dependency
(`ConfiguredIntegrationRuntimeOptions.distill`, `runtime.ts:55`). Graph
responses, picker payloads, delta pages, subscription replies, 302 download
redirects, and lifecycle notifications are fixtures. Extraction tests run the
worker on fixture bytes in `test/fixtures/extract/`. No test opens a network
socket to Microsoft or an LLM. The evaluation corpus is part of the test
suite, not a manual exercise.

---

## 18. Verification probes before the plan is written (ordered by leverage)

1. `Files.Read` vs `Files.Read.All` for a SharePoint library item addressed by
   `/drives/{id}/items/{id}`; and the admin-consent flag of `Files.Read.All`,
   `AllSites.Read`, `MyFiles.Read` in a default-policy tenant. Decides the
   default `scope_profile` and the §4.3 measurement baseline.
2. Folder-scoped delta (`/drives/{d}/items/{folder}/delta`) on a SharePoint
   library; else the root-delta ancestry fallback in §7.1 is promoted.
3. Byte shape of an IRM-protected `.docx` download and the behavior of
   `?format=pdf` on it (expect refusal) — confirms guardrail §9.3.
4. Presence of `id` on driveItem change notifications — decides event-id
   strategy §6.3 default.
5. OneDrive-hosted picker browsing SharePoint via the shared-libraries pivot
   with `AllSites.Read` only.
6. `pdfjs-dist` legacy build in a Node worker without DOM polyfills for
   `getTextContent` only.

### 18.1 Probe results (2026-09-02)

- **Probe 6 — PASS.** `pdfjs-dist` **v6.3.289** legacy build
  (`pdfjs-dist/legacy/build/pdf.mjs`) runs inside a `node:worker_threads` Worker
  on Node 22 and extracts full text-layer content via `getDocument` →
  `page.getTextContent()` with **no DOM polyfill**. The only DOM-ish global in
  the worker is Node 22's own core `navigator`; `window`/`document`/`DOMMatrix`/
  `HTMLElement` are absent and unneeded. A reportlab-generated fixture round-trips
  exactly (`"…decision-critical sentence: revenue fell 12% in Q3."` + a second
  line). Caveat for the extractor: pass `standardFontDataUrl` to
  `getDocument` — without it a non-fatal `UnknownErrorException:
  Ensure that the standardFontDataUrl API parameter is provided` warning fires;
  text-layer extraction still succeeds, but embedded/non-standard fonts can lose
  glyph mapping, so the extractor should ship the standard font data. `doc.destroy`
  is not a method in v6; use `doc.cleanup()` / `loadingTask.destroy()`.
  Evidence: `/tmp/pdfjs-probe/probe.mjs` (worker-thread probe, ephemeral).
- **Probes 1–5 — BLOCKED (require a live Microsoft 365 tenant).** Each needs an
  Entra app registration + delegated Graph credentials + specific tenant
  artifacts (a SharePoint library, an IRM-protected `.docx`, a live change-
  notification subscription, the File Picker) that do not exist in this
  environment. Per the §17 test constraint they are deliberately out of the
  automated suite; they are operator spikes against a real tenant and must be run
  by whoever holds tenant access before `writing-plans` fixes the `scope_profile`,
  the delta-scope fallback (§7.1), the encrypted-file guardrail (§9.3), and the
  event-id strategy (§6.3).

---

## Verdict

**BUILD-WITH-CHANGES.**

Overridden #492 bets, and why:

1. **Transient-PDF conversion as the shared path for Word/PowerPoint** →
   replaced by native OOXML extraction + a bounded PDF text extractor, with
   Graph conversion demoted to the legacy-binary fallback. There is no
   extractor to share; the OOXML walker is cheaper than the PDF path it was
   meant to avoid; PDF export drops speaker notes and adds a rendering hop.
2. **"Choose a Daftari collection"** → bounded to a config allowlist and the
   enroller's write grant, threaded through the emitter's existing named
   constant; today the emitter cannot do it at all.
3. **Collection ACL ⊆ source readers** → replaced by explicit, acknowledged,
   twice-gated declassification with a mechanical fail-closed for encrypted
   content. Daftari's ACL cannot express the inclusion; building the mapping
   would be the new authorization system the kill condition forbids.

Kept: deployment-owned single-tenant OAuth (with a measured, not assumed, consent
probe), one account per vault, delta + webhooks on the existing contract, the
unavailable-source policy, and the never-erase rule.
