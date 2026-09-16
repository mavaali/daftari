# Plan — Board browser-login shim (cookie session for `/board`)

Bead: `mavaali-beads-7q9`. Branch: `feat/board-login-shim` (off `origin/main` @ 3.8.0).

## Problem

`/board` mounts only on the `serve` path, behind `authenticate()` which requires
`Authorization: Bearer <token>` on every request (`src/serve/index.ts:427-496`,
board gate `571-747`). A browser navigation sends no bearer → 401, so the board
is unreachable from a browser. The board page also renders **read-only** cards —
disposition buttons were explicitly deferred (`src/view/board-page.ts:22-24`).

Goal: an operator logs in once from a browser and can **view** `/board` and
**click dispose/resolve**, without weakening the existing bearer/OAuth paths.

## Design (locked)

A **cookie session** as a *third* credential type, composable with bearer + OAuth.
Bearer/OAuth paths are untouched; the cookie is only consulted when no valid
bearer is presented.

- **Session token**: `base64url(JSON{v:1,user,role,exp})` + `"." ` + base64url(HMAC-SHA256(key, payload)).
  Key from env (like `tokens`, never in config). Verify = constant-time HMAC
  compare + `exp` in the future + `role` still declared in `config.roles`.
- **Cookie**: `daftari_session=<token>; HttpOnly; SameSite=Strict; Path=/;` plus
  `Secure` **iff** `server.transport_security === "external"` (loopback http can't set Secure).
- **CSRF**: cookie-authenticated *state-changing* POSTs (dispose/resolve/logout)
  additionally require (a) a same-origin signal — `Sec-Fetch-Site: same-origin`
  OR an `Origin` in the server's loopback/known set — AND (b) a double-submit CSRF
  token: a non-HttpOnly `daftari_csrf` cookie whose value must match an
  `X-CSRF-Token` header the board page's `fetch` sends. Bearer-authenticated POSTs
  are exempt (no ambient credential → no CSRF surface).

## Config (`src/utils/config.ts`)

Add `"session"` to `RECOGNISED_SERVER_AUTH_KEYS` (`:1090`) and a `validateSession`
mirroring `validateOAuth`'s loud shape-only validation (`:1096-1144`). Startup
(serve) resolves the env vars and checks the role exists — same posture as the
token loop in `src/serve/index.ts:140-155`.

```yaml
server:
  auth:
    session:
      signing_key_env: DAFTARI_SESSION_KEY   # HMAC key (>= 32 bytes)
      credential_env:  DAFTARI_BOARD_PASSWORD # login password
      maps_to: { user: mihir, role: admin }   # identity a login receives
      lifetime_hours: 12                       # default 12
```

## Implementation Units

- **U1 — session crypto (pure)** `src/serve/session.ts` (new): `signSession`,
  `verifySession` (constant-time, exp check), payload codec. TDD first; no I/O.
- **U2 — config schema** `SessionConfig` interface + `validateSession` +
  `RECOGNISED_SESSION_KEYS`; wire into `validateServer` (`:1204-1241`). Loud on
  unknown keys / non-string fields / missing `maps_to`.
- **U3 — startup resolution** in `runServe`/`startHttpServer`: resolve
  `signing_key_env` + `credential_env`, verify `maps_to.role in config.roles`,
  fail loud (exit 2) if env unset or role undeclared. Carry a `ResolvedSession`
  beside `tokens`.
- **U4 — authenticate() cookie branch** (`:427`): after bearer/oauth miss and
  before the 401, if a `daftari_session` cookie verifies → `resolveAccess`.
  Invalid cookie is **not** a guest downgrade — falls through to the existing
  401/redirect + penalty box.
- **U5 — login/logout routes** (before the board gate): `GET /board/login` (HTML
  form + fresh CSRF cookie), `POST /board/login` (constant-time credential
  compare, penalty-boxed, set session+csrf cookies, 302 `/board`),
  `POST /board/logout` (clear cookies, 302 `/board/login`). These live **outside**
  `authenticate()` but **inside** the existing rebinding/Origin guard (`:541`).
- **U6 — browser redirect** on `GET /board` no-cred: if `Accept` contains
  `text/html` → 302 `/board/login`; else the existing 401 JSON (curl/API
  unchanged).
- **U7 — CSRF enforcement** for cookie-authenticated dispose/resolve/logout:
  same-origin + double-submit check; 403 on mismatch. Bearer path exempt.
- **U8 — board page interactivity** `src/view/board-page.ts`: render dispose/
  resolve buttons + a logout link; a small inline script POSTs with
  `X-CSRF-Token` + `credentials:"same-origin"` and reloads on success. Replaces
  the read-only-only note (`:22-24`).

## Test scenarios (TDD)

1. valid session cookie → correct role; board filtered by that role.
2. forged cookie (wrong key) → rejected, penalty charged, no guest downgrade.
3. tampered payload (role escalated to admin) → HMAC fails → rejected.
4. expired session (`exp` past) → rejected.
5. `POST /board/login` correct password → 302 + Set-Cookie (HttpOnly, SameSite=Strict; Secure only when external).
6. wrong password → 401, penalty charged, constant-time compare.
7. `GET /board` no cred + `Accept: text/html` → 302 `/board/login`; + curl Accept → 401 JSON.
8. logout clears cookie; post-logout request unauthenticated.
9. CSRF: cookie-auth `POST /api/board/dispose` without matching `X-CSRF-Token` → 403; with token → 200.
10. cross-site Origin on cookie-auth POST → 403 (loopback guard + same-origin check).
11. bearer path unchanged: bearer dispose still works with **no** CSRF token (regression).
12. no session configured → bearer/oauth behavior identical to today (regression).
13. env var unset at startup → exit 2, loud message (like the token loop).
14. `maps_to.role` not in `config.roles` → exit 2.

## Out of scope (v1)

Multi-user browser logins (OAuth is that path), password rotation UX, remember-me.

## Deploy (separate, gated on Mihir)

The code above is architecture-neutral. Serving `/board` on the **live**
`mavaali-vault` needs `serve` to be the single vault holder (repoint the agent
MCP stdio→HTTP `/mcp`). That is bead-tracked separately and needs Mihir's
explicit go — it touches live memory wiring.
