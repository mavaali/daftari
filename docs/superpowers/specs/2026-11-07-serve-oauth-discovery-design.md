# OAuth discovery for `daftari serve` — design

Readiness: implemented (this document records the decisions the code follows).

## Why

`daftari serve` already validates OAuth 2.1 bearer JWTs (issuer, audience,
JWKS, subject → role). What it did not do is tell a client *where to sign
in*. Remote MCP clients — ChatGPT, claude.ai, Claude Desktop, Claude mobile,
Cowork, Claude Code — locate the authorization server through OAuth
discovery: a `401` carrying `WWW-Authenticate: Bearer resource_metadata="…"`
(RFC 6750 §3), or an RFC 9728 protected-resource document at
`/.well-known/oauth-protected-resource[/<mcp path>]`. Serve returned a plain
JSON 401 and 404'd the well-known paths, so with OAuth configured no remote
client could start sign-in. Only header-capable clients (Claude Code with a
static bearer) could connect.

Motivating case: one user running agents from several harnesses and devices
against one vault. Anything that cannot spawn a local process reaches memory
only through a network endpoint, and those clients only speak OAuth with
discovery.

## Requirements

- **R1** When `server.auth.oauth` and `server.public_base_url` are both set,
  serve publishes the RFC 9728 document at
  `/.well-known/oauth-protected-resource` and at
  `/.well-known/oauth-protected-resource<prefix>/mcp`, where `<prefix>` is
  the path of `public_base_url` (empty at the root). Exact pathname match;
  GET and HEAD only, other methods 405 with `Allow: GET, HEAD`;
  `Content-Type: application/json`, `Cache-Control: no-store`.
- **R2** The document is exactly `{ resource, authorization_servers,
  bearer_methods_supported }` with `resource = <public_base_url>/mcp`,
  `authorization_servers = [issuer]`, `bearer_methods_supported = ["header"]`.
  Nothing from vault files, roles, subjects, counts or collections.
- **R3** Every Bearer 401 written by `authenticate()` carries
  `WWW-Authenticate: Bearer resource_metadata="<path-aware well-known URL>"`,
  plus `, error="invalid_token"` when a bearer was presented. The 403 for an
  authenticated-but-unmapped subject carries no challenge. The browser
  redirect (302) and the board password-form 401 are untouched.
- **R4** `<prefix>/mcp` routes to the MCP handler alongside bare `/mcp`, so
  the URL the document publishes reaches auth rather than a 404.
- **R5** `server.auth.oauth.audience` becomes optional. Effective audience =
  explicit value, else the resource URL. Startup refuses oauth with neither
  `audience` nor `public_base_url`. An explicit audience that differs from
  the resource produces a stderr warning, not a refusal.
- **R6** The well-known routes sit outside the ops floor: no penalty box, no
  per-principal bucket, no in-flight slot, no audit line.
- **R7** Without `public_base_url`, behaviour is unchanged: no document, no
  challenge header, a one-line startup warning that discovery is off.

## Decisions

1. **`resource` comes from config, never from the request.** Reuse
   `server.public_base_url` rather than a new key; derive nothing from `Host`
   or `X-Forwarded-*`. Same rule that confines `X-Forwarded-For` to
   `trusted_proxies`.
2. **Audience defaults to the resource.** ChatGPT and Claude send the MCP URL
   as RFC 8707 `resource` and expect the IdP to mint it as `aud`; requiring
   the operator to type the same URL twice manufactures a mismatch. The
   explicit override survives for IdPs that mint a fixed API identifier.
   Kill condition: if the first two real IdP deployments both need an
   explicit audience, revert to required-with-a-warning.
3. **Missing `public_base_url` is a capability absence, not a weakening.**
   Discovery failing is visible at the client; the repo's fail-loud rule is
   for postures that silently weaken security. Fail-loud would also break
   every loopback-IdP test fixture, since `public_base_url` must be HTTPS.
4. **No gates on the document.** The normal flow is 401 (which charges the
   penalty box) then the discovery fetch; gating discovery would lock a client
   out of sign-in. A precomputed string does no vault work.
5. **No `scopes_supported`.** Daftari has no scopes; roles come from the
   subjects table. Kill condition: an IdP that requires a scope to mint an
   access token for a custom API forces an optional passthrough — additive,
   not a design change.
6. **The 403 stays header-less.** `insufficient_scope` means "re-request with
   more privilege"; no scope fixes an absent `subjects` entry, and advertising
   it invites a re-auth loop.
7. **Daftari is only the resource server.** It never issues tokens or
   registers clients; the IdP must support PKCE S256 and DCR or CIMD. This
   follows the standing decision not to build user management.

## Not in scope

- A loopback fallback for `resource` (`http://<bind>:<port>/mcp`) so Claude
  Code can sign in to a local serve with a local IdP — ephemeral-port
  resolution happens after listen and complicates the audience default.
- CORS headers on the well-known routes for browser-based clients — the
  targeted clients fetch discovery server-side.
- Verifying that ChatGPT speaks the 2026-07-28 protocol revision —
  `--legacy-http` is the fallback.

## What already exists

- JWT verification and subject mapping: `src/serve/index.ts` `authenticate()`.
- `server.public_base_url`: validated absolute HTTPS URL, trailing slash
  stripped, already used for connector callbacks.
- The ops floor (penalty box, buckets, slot gate) and the auth audit log.

## Tests

`test/serve/discovery.test.ts` (prefixed base, omitted audience): document
on both paths with headers, HEAD/405, near-miss 404s, challenge on `/mcp` and
`/api/board`, no challenge on 403, `aud = resource` accepted on both MCP
paths via the SDK client, other audience 401, discovery reachable while the
caller is in the penalty box, startup-gate cases. `test/serve/oauth.test.ts`:
no document and no challenge without `public_base_url`.
`test/utils/config.test.ts`: audience omitted loads, empty audience rejected.
