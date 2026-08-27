// `daftari serve` (#5, spec 2026-07-20; stateless per spec 2026-07-26
// Decision 1) — server mode over the 2026-07-28 MCP revision.
//
// One always-on instance, many MCP clients, NO sessions: the 2026-07-28
// revision removed the initialize handshake and the Mcp-Session-Id header, so
// identity is per REQUEST, resolved on every request against the same
// config-declared map. createServer already parameterizes the access context,
// so each request gets an instance bound to the identity its own bearer
// resolved to — no tool handler changes, and every RBAC/existence-disclosure
// invariant applies per request, transport-independently.
//
// Serve speaks the 2026-07-28 revision only (`legacy: "reject"`): no
// dual-stacking, the precedent set by refusing the deprecated HTTP+SSE
// transport. Lagging clients use stdio, which serves both eras.
//
// Fail-loud rules (all from the spec, all startup or request-time errors,
// never silent downgrades):
//   - non-loopback bind requires auth configured AND
//     server.transport_security: external declared;
//   - a token entry whose env var is unset, or whose role is not declared,
//     refuses to start;
//   - once auth is configured, a missing/unmatched bearer token is rejected
//     (401) on EVERY request on every bind — never downgraded to guest;
//   - the deny-all guest exists only in the no-auth loopback configuration.

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { type AuthInfo, createMcpHandler } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  type AccessContext,
  canManageIntegrations,
  GUEST_ROLE,
  resolveAccess,
} from "../access/rbac.js";
import { loadAttestKey } from "../attest/sign.js";
import type { BoardFilters } from "../board/board.js";
import { listBoard } from "../board/board.js";
import { ok, type Result } from "../frontmatter/types.js";
import { installShutdownHandlers, parseFlag, startVaultServices } from "../index.js";
import {
  createConfiguredIntegrationRuntime,
  type IntegrationRuntime,
} from "../integrations/runtime.js";
import { acquireLock, releaseLock } from "../lifecycle/lock.js";
import { setCoverageEnabled } from "../search/coverage.js";
import { setGraphExpandConfig } from "../search/graph-expansion.js";
import { setDefaultWeights, setVecKnnK } from "../search/hybrid.js";
import { setSuppressSuperseded } from "../search/suppression.js";
import { setProvider } from "../search/vector.js";
import { createServer, resolveToolExposure, SERVER_VERSION } from "../server.js";
import { createBackend, type StorageBackend } from "../storage/backend.js";
import { directoryExists } from "../storage/local.js";
import { syncVault } from "../storage/sync.js";
import { vaultBoardDispose, vaultBoardResolve } from "../tools/board.js";
import { type DaftariConfig, loadConfig } from "../utils/config.js";
import { ensureVaultGitignore } from "../utils/vault-gitignore.js";
import { renderBoardPage } from "../view/board-page.js";
import { type AuthEvent, appendAuthEvent, tokenHint } from "./auth-log.js";
import {
  type Bucket,
  chargePenalty,
  makeBucket,
  makeBucketRegistry,
  makePenaltyBox,
  makeSlotGate,
  penaltyAllows,
  releaseSlot,
  type SlotGate,
  takeFromRegistry,
  tryAcquireSlot,
  tryTake,
} from "./limits.js";
import { type CidrRange, parseTrustedProxies, resolvePublicRemote } from "./proxy-trust.js";
import { signSession, verifySession } from "./session.js";

export const DEFAULT_PORT = 8787;
export const DEFAULT_BIND = "127.0.0.1";

const HELP = `daftari serve — server mode over Streamable HTTP (spec 2026-07-20).

Usage:
  daftari serve --vault <path> [--port <n>] [--bind <addr>] [--takeover]
                [--legacy-http]

Defaults:
  --port ${DEFAULT_PORT}
  --bind ${DEFAULT_BIND}   (loopback; non-loopback binds require auth AND
                    server.transport_security: external in config)

  --takeover      deliberately replace a LIVE daftari holding this vault
                  (a plain serve refuses against any live holder)

  --legacy-http   ALSO answer 2025-era MCP clients through the SDK's
                  stateless legacy fallback (#366). Temporary migration
                  flag; auth and RBAC apply per request either way.

Endpoint: http://<bind>:<port>/mcp   (MCP 2026-07-28, stateless — lagging
                                     clients use stdio or --legacy-http)

Auth: clients send "Authorization: Bearer <token>" on EVERY request. Two
composable schemes:
  server.auth.tokens — static tokens; values come from the env vars named in
    config, never from config itself.
  server.auth.oauth  — OAuth 2.1 resource-server validation: bearer JWTs are
    verified against the IdP's JWKS (issuer + audience + expiry) and the
    subject claim maps through the declared subjects table. A valid token
    with an unmapped subject is 403 (authenticated, not authorized).
With any auth configured, a missing/invalid credential is a 401 on every
request — never a guest downgrade; with no auth (loopback only), requests run
as the deny-all guest.

Exit codes: 2 config/usage error, 3 runtime error.
`;

// A resolved phase-1 credential: the secret bytes and the identity a match
// binds the request to.
interface ResolvedToken {
  secret: Buffer;
  user: string;
  roleName: string;
}

// Minimum HMAC signing-key length. A short key weakens the session MAC; refuse
// startup rather than mint forgeable cookies.
const MIN_SESSION_KEY_BYTES = 32;

// A resolved browser-session credential (bead 7q9): the HMAC key, the login
// password bytes, the identity a login receives, and the lifetime in ms.
export interface ResolvedSession {
  key: Buffer;
  credential: Buffer;
  user: string;
  roleName: string;
  lifetimeMs: number;
}

const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);

export function httpCallbackBase(bind: string, port: number): string {
  const callbackHost = isLoopbackBind(bind) ? bind : "127.0.0.1";
  const authority = callbackHost.includes(":") ? `[${callbackHost}]` : callbackHost;
  return `http://${authority}:${port}`;
}

function remoteOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

export function isLoopbackBind(bind: string): boolean {
  return LOOPBACK_BINDS.has(bind);
}

// Pure startup gating (#5): everything that must refuse before a socket
// opens. Exported for direct tests — the rules matter more than the wiring.
export function validateServeStartup(
  config: DaftariConfig,
  bind: string,
  env: NodeJS.ProcessEnv,
):
  | { ok: true; tokens: ResolvedToken[]; session: ResolvedSession | null }
  | { ok: false; error: string } {
  // Federation is stdio-only in v1 (#297, spec Decision 8): per-bearer
  // identity would need per-request resolution against every mount's
  // principals, and the "vault labels do not leak" disclosure ruling was
  // derived for a single-identity process. Fail-loud like every policy
  // conflict rather than silently serving without the mounts.
  if (config.federation !== undefined && config.federation.mounts.length > 0) {
    return {
      ok: false,
      error: "federation is stdio-only in v1; remove the federation block or run stdio",
    };
  }
  const authConfigured =
    config.server.tokens.length > 0 ||
    config.server.oauth !== undefined ||
    config.server.session !== undefined;
  if (!isLoopbackBind(bind)) {
    if (!authConfigured) {
      return {
        ok: false,
        error:
          `refusing to bind ${bind} with no authentication configured — ` +
          `declare server.auth.tokens and/or server.auth.oauth in .daftari/config.yaml`,
      };
    }
    if (config.server.transportSecurity !== "external") {
      return {
        ok: false,
        error:
          `refusing to bind ${bind}: declare server.transport_security: ` +
          `"external" to acknowledge that TLS terminates upstream (or the ` +
          `network is trusted); daftari never terminates TLS itself`,
      };
    }
  }
  // #298: a set-but-unusable attestation key refuses startup — a server
  // that silently serves unsigned receipts while the operator believes
  // signing is on is the failure mode this gate exists for.
  if (typeof env.DAFTARI_ATTEST_KEY === "string" && env.DAFTARI_ATTEST_KEY.length > 0) {
    const attestKey = loadAttestKey(env.DAFTARI_ATTEST_KEY);
    if (!attestKey.ok) {
      return {
        ok: false,
        error: `DAFTARI_ATTEST_KEY is set but unusable: ${attestKey.error.message}`,
      };
    }
  }
  const tokens: ResolvedToken[] = [];
  for (const t of config.server.tokens) {
    const value = env[t.env];
    if (typeof value !== "string" || value.length === 0) {
      return {
        ok: false,
        error: `server.auth.tokens entry for ${t.user} names env var ${t.env}, which is not set`,
      };
    }
    if (!(t.role in config.roles)) {
      return {
        ok: false,
        error:
          `server.auth.tokens entry for ${t.user} names role '${t.role}', ` +
          `which is not declared in config roles`,
      };
    }
    tokens.push({ secret: Buffer.from(value, "utf-8"), user: t.user, roleName: t.role });
  }
  // OAuth (#7): the block's shape was validated at config load; startup
  // verifies what only this process can — URL parseability and that every
  // mapped role is declared, the same loud posture as the token entries.
  const oauth = config.server.oauth;
  if (oauth) {
    for (const field of [oauth.issuer, oauth.jwksUri]) {
      let parsed: URL;
      try {
        parsed = new URL(field);
      } catch {
        return { ok: false, error: `server.auth.oauth: '${field}' is not a valid URL` };
      }
      // JWKS/issuer over plaintext http would let a network-position
      // attacker serve a forged key set and mint arbitrary authorized
      // sessions — https only, with loopback http as the sole escape hatch
      // (local test IdPs; no network position exists on the host itself).
      // URL.hostname keeps IPv6 brackets ("[::1]"); strip them so the
      // loopback set (written for bare --bind values) matches.
      const loopbackHost = isLoopbackBind(parsed.hostname.replace(/^\[|\]$/g, ""));
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopbackHost)) {
        return {
          ok: false,
          error:
            `server.auth.oauth: '${field}' must use https ` +
            `(plain http is allowed only for loopback test IdPs)`,
        };
      }
    }
    for (const [subject, entry] of Object.entries(oauth.subjects)) {
      if (!(entry.role in config.roles)) {
        return {
          ok: false,
          error:
            `server.auth.oauth.subjects entry for ${subject} names role ` +
            `'${entry.role}', which is not declared in config roles`,
        };
      }
    }
  }
  // Session (bead 7q9): resolve the signing key + login password from env and
  // check the mapped role is declared — the same loud posture as the tokens.
  let session: ResolvedSession | null = null;
  const sessionCfg = config.server.session;
  if (sessionCfg) {
    const keyValue = env[sessionCfg.signingKeyEnv];
    if (typeof keyValue !== "string" || keyValue.length === 0) {
      return {
        ok: false,
        error: `server.auth.session names env var ${sessionCfg.signingKeyEnv}, which is not set`,
      };
    }
    if (Buffer.byteLength(keyValue, "utf-8") < MIN_SESSION_KEY_BYTES) {
      return {
        ok: false,
        error: `server.auth.session signing key (${sessionCfg.signingKeyEnv}) must be at least ${MIN_SESSION_KEY_BYTES} bytes`,
      };
    }
    const credValue = env[sessionCfg.credentialEnv];
    if (typeof credValue !== "string" || credValue.length === 0) {
      return {
        ok: false,
        error: `server.auth.session names env var ${sessionCfg.credentialEnv}, which is not set`,
      };
    }
    if (!(sessionCfg.mapsTo.role in config.roles)) {
      return {
        ok: false,
        error:
          `server.auth.session maps to role '${sessionCfg.mapsTo.role}', ` +
          `which is not declared in config roles`,
      };
    }
    session = {
      key: Buffer.from(keyValue, "utf-8"),
      credential: Buffer.from(credValue, "utf-8"),
      user: sessionCfg.mapsTo.user,
      roleName: sessionCfg.mapsTo.role,
      lifetimeMs: sessionCfg.lifetimeHours * 3_600_000,
    };
  }
  return { ok: true, tokens, session };
}

// Constant-time match of the presented bearer against every configured
// secret. Iterates the FULL list regardless of an early match, so response
// timing does not reveal which (or whether any) entry matched.
export function matchToken(presented: string, tokens: ResolvedToken[]): ResolvedToken | null {
  const presentedBuf = Buffer.from(presented, "utf-8");
  let matched: ResolvedToken | null = null;
  for (const t of tokens) {
    const sameLength = presentedBuf.length === t.secret.length;
    // timingSafeEqual requires equal lengths; compare against self when the
    // lengths differ so every candidate costs one comparison either way.
    const equal = timingSafeEqual(sameLength ? presentedBuf : t.secret, t.secret);
    if (sameLength && equal && matched === null) matched = t;
  }
  return matched;
}

function bearerFrom(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const m = /^Bearer\s+(.+)$/.exec(header);
  return m ? (m[1] as string) : null;
}

// Board-login cookie names (bead 7q9). The CSRF cookie is deliberately NOT
// HttpOnly — the board page's script reads it to echo the value in a header
// (double-submit), which is the whole point.
export const SESSION_COOKIE = "daftari_session";
export const CSRF_COOKIE = "daftari_csrf";

// Minimal, allocation-light cookie parse: the Cookie header is a
// "; "-delimited list of name=value pairs. Values are used verbatim (our own
// tokens are base64url / hex, no encoding needed).
function cookiesFrom(req: IncomingMessage): Map<string, string> {
  const out = new Map<string, string>();
  const header = req.headers.cookie;
  if (typeof header !== "string") return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name.length > 0 && !out.has(name)) out.set(name, value);
  }
  return out;
}

function acceptsHtml(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  return typeof accept === "string" && accept.includes("text/html");
}

// Double-submit CSRF check (bead 7q9): a cookie-authed state-changing request
// must echo the non-HttpOnly CSRF cookie back in an X-CSRF-Token header. A
// cross-site page can send the cookie automatically but cannot read it to set
// the header (it is same-origin to the board), and cannot set a custom header
// on a simple form post. Returns an error string on failure, null when valid.
function checkCsrf(req: IncomingMessage): string | null {
  const cookie = cookiesFrom(req).get(CSRF_COOKIE);
  const raw = req.headers["x-csrf-token"];
  const header = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  if (cookie === undefined || cookie.length === 0 || header === undefined || header.length === 0) {
    return "missing CSRF token";
  }
  const a = Buffer.from(cookie, "utf-8");
  const b = Buffer.from(header, "utf-8");
  const sameLength = a.length === b.length;
  const equal = timingSafeEqual(sameLength ? a : b, b);
  return sameLength && equal ? null : "CSRF token mismatch";
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

// Build a Set-Cookie value for a board-login cookie (bead 7q9). HttpOnly is
// caller-controlled (the session cookie is HttpOnly; the CSRF cookie is not,
// so the board page can echo it). SameSite=Strict blocks cross-site sends,
// the primary CSRF defense; the double-submit token is defense-in-depth.
// Secure is set only when the operator declared transport_security: external —
// a loopback http server cannot set Secure or the browser drops the cookie.
function buildCookie(
  name: string,
  value: string,
  opts: { httpOnly: boolean; maxAgeSec: number; secure: boolean },
): string {
  const parts = [`${name}=${value}`, "Path=/", "SameSite=Strict", `Max-Age=${opts.maxAgeSec}`];
  if (opts.httpOnly) parts.push("HttpOnly");
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

function writeRedirect(res: ServerResponse, location: string, setCookies: string[]): void {
  res.writeHead(302, {
    location,
    ...(setCookies.length > 0 ? { "set-cookie": setCookies } : {}),
  });
  res.end();
}

// Minimal, self-contained login page (bead 7q9). No external assets; a single
// password field POSTing form-encoded to /board/login. `error` renders a
// message after a failed attempt.
function renderLoginPage(error?: string, username?: string): string {
  const errorHtml = error
    ? `<p class="err">${error.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] as string)}</p>`
    : "";
  // A username field paired with the password input lets browser password
  // managers recognize this as a login form and offer save/autofill; a lone
  // password box is skipped. The user is fixed by config (maps_to.user), so it
  // is prefilled and readonly — the server ignores it, it exists only as an
  // autofill anchor.
  const userHtml = username
    ? `<input type="text" name="username" value="${username.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c] as string)}" autocomplete="username" aria-label="User" readonly>`
    : "";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>Board — sign in</title><style>` +
    // Instrument-panel palette — mirrors the :root tokens in view/pages.ts
    // (this page is standalone by design, so the values are inlined).
    `body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#141513;color:#d8d6cb;` +
    `display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}` +
    `form{background:#191a18;border:1px solid #32332e;padding:28px 30px;width:280px}` +
    `h1{font-size:14px;font-weight:700;margin:0 0 4px;letter-spacing:.12em;text-transform:uppercase;color:#f2f0e6}` +
    `p.sub{font-size:11px;color:#8f8e83;margin:0 0 18px}` +
    `input{width:100%;box-sizing:border-box;background:#141513;border:1px solid #4a4b44;` +
    `color:#d8d6cb;padding:9px 11px;font:inherit;margin-bottom:14px}` +
    `button{width:100%;background:transparent;border:1px solid #3fd68c;color:#3fd68c;padding:9px;` +
    `font:inherit;font-weight:700;letter-spacing:.08em;text-transform:uppercase;cursor:pointer}` +
    `button:hover{background:rgba(63,214,140,.12)}` +
    `p.err{color:#e8713d;font-size:12px;margin:0 0 12px}` +
    `</style></head><body><form method="post" action="/board/login">` +
    `<h1>Vault Board</h1><p class="sub">Enter the board password to continue.</p>` +
    errorHtml +
    userHtml +
    `<input type="password" name="password" autofocus autocomplete="current-password" aria-label="Board password">` +
    `<button type="submit">Sign in</button></form></body></html>`
  );
}

// Read the full request body as a UTF-8 string. Returns null if reading fails
// or body exceeds the 1 MiB safety limit.
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const LIMIT = 1_048_576; // 1 MiB
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > LIMIT) {
        if (settled) return; // size-limit path: prevent double-resolve
        settled = true;
        resolve(null);
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    req.on("error", () => {
      if (settled) return;
      settled = true;
      resolve(null);
    });
  });
}

// Absolute wall-clock deadline for receiving a full request body. Bounds a
// slow-loris that dribbles bytes under the size cap forever; a stalled body is
// abandoned and the socket destroyed.
const MCP_BODY_DEADLINE_MS = 30_000;

export type BoundedBodyResult =
  | { status: "ok"; body: string }
  | { status: "too_large" }
  | { status: "timeout" }
  | { status: "error" };

// Read a request body under a HARD byte cap and an absolute deadline. Unlike
// readBody (which only size-caps and collapses every failure to null), this
// distinguishes too-large from timed-out from errored so the caller can answer
// 413 / 408 / 400. It exists for the /mcp path: the MCP adapter's toWebRequest
// buffers the whole stream with `for await (const chunk of req)` and no ceiling,
// so the bound must be enforced here, before the adapter runs. The caller then
// hands the parsed value to the adapter as `parsedBody` and the adapter reads
// nothing from `req`.
export function readBodyBounded(
  req: IncomingMessage,
  maxBytes: number,
  deadlineMs: number,
): Promise<BoundedBodyResult> {
  return new Promise((resolve) => {
    // Cheap pre-check: an honest oversized upload declares its length, so we
    // refuse it without reading (or buffering) a single byte.
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      resolve({ status: "too_large" });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: BoundedBodyResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // The reader never destroys the socket — it is shared with the response, so
    // the CALLER answers 413/408 with `Connection: close`. Past the cap we stop
    // BUFFERING (memory stays bounded) but keep the `data` listener attached so
    // the rest of the body drains into nowhere rather than back-pressuring.
    // A declared length can lie (or be absent on a chunked body): count the
    // bytes actually delivered and cut the moment they cross the cap.
    const timer = setTimeout(() => finish({ status: "timeout" }), deadlineMs);
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) finish({ status: "too_large" });
      else if (!settled) chunks.push(chunk);
    });
    req.on("end", () => finish({ status: "ok", body: Buffer.concat(chunks).toString("utf-8") }));
    req.on("error", () => finish({ status: "error" }));
  });
}

// Parse BoardFilters from a URLSearchParams instance (query string).
function filtersFromQuery(query: URLSearchParams): BoardFilters {
  const filters: BoardFilters = {};
  const collection = query.get("collection");
  if (collection) filters.collection = collection;
  const check = query.get("check");
  if (check) filters.check = check;
  const certainty = query.get("certainty");
  if (certainty === "low" || certainty === "medium" || certainty === "high") {
    filters.certainty = certainty;
  }
  const owner = query.get("owner");
  if (owner) filters.owner = owner;
  const minAgeDays = query.get("minAgeDays");
  if (minAgeDays !== null) {
    const n = Number(minAgeDays);
    if (Number.isFinite(n) && n >= 0) filters.minAgeDays = Math.floor(n);
  }
  const document = query.get("document");
  if (document) filters.document = document;
  return filters;
}

export interface ServeHandle {
  port: number;
  close: () => Promise<void>;
}

// Starts the HTTP listener and per-request router. Exported separately from
// runServe so tests can drive a live server in-process on an ephemeral port
// without argv parsing, lock acquisition, or process-global side effects.
// DNS-rebinding guard for LOOPBACK binds (MCP Streamable HTTP security
// guidance): a malicious page can rebind its domain to 127.0.0.1 and make
// same-origin fetches to a local server, so the Host header must be one of
// the loopback spellings for the bound port, and a PRESENT Origin must be a
// loopback origin too (absent Origin = non-browser MCP client, allowed).
// Non-loopback binds don't get this guard: bearer auth is mandatory there
// (a rebinded page holds no token), and the operator's reverse proxy owns
// the Host header, which this process cannot allow-list.
interface LoopbackGuard {
  hosts: Set<string>;
  origins: Set<string>;
}

export function makeLoopbackGuard(port: number): LoopbackGuard {
  const spellings = ["127.0.0.1", "localhost", "[::1]"];
  return {
    hosts: new Set(spellings.map((h) => `${h}:${port}`)),
    origins: new Set(spellings.map((h) => `http://${h}:${port}`)),
  };
}

export function violatesLoopbackGuard(
  guard: LoopbackGuard,
  host: string | undefined,
  origin: string | undefined,
): string | null {
  if (!host || !guard.hosts.has(host)) {
    return `Host header '${host ?? "<missing>"}' is not a loopback address for this server`;
  }
  if (origin !== undefined && !guard.origins.has(origin)) {
    return `Origin '${origin}' is not allowed on a loopback bind`;
  }
  return null;
}

export interface StartHttpServerOptions {
  // --legacy-http (#366): serve 2025-era clients through the SDK's stateless
  // legacy fallback instead of rejecting them. Temporary, opt-in; removal
  // criterion lives in the issue.
  legacyHttp?: boolean;
  // Test-only: inject the in-flight gate so tests can preload it to the
  // ceiling instead of racing slow requests.
  slotGate?: SlotGate;
  // The resolved browser-session credential (bead 7q9), or null when no
  // server.auth.session block is configured. Threaded from validateServeStartup.
  session?: ResolvedSession | null;
  /** Provider-neutral connector runtime; provider behavior stays outside serve. */
  integrationRuntime?: IntegrationRuntime;
}

export function startHttpServer(
  vaultRoot: string,
  config: DaftariConfig,
  tokens: ResolvedToken[],
  bind: string,
  port: number,
  opts: StartHttpServerOptions = {},
): Promise<ServeHandle> {
  const oauth = config.server.oauth;
  const session = opts.session ?? null;
  const authConfigured = tokens.length > 0 || oauth !== undefined || session !== null;

  // The ops floor (multi-user item 6). Process-local in-memory state is
  // correct by construction: one serve process per vault is the invariant
  // (.daftari/process.lock), the principal set is config-declared and
  // finite, and a restart re-arms the floor immediately.
  const limits = config.server.limits;
  // Parsed once: which immediate peers are our own proxies, so X-Forwarded-For
  // is honored only from them (finding F4).
  const trustedProxies: CidrRange[] = parseTrustedProxies(config.server.trustedProxies);
  const penaltyBox = makePenaltyBox(limits.authFailureBurst, limits.authFailuresPerMinute);
  const principalBuckets = new Map<string, Bucket>();
  const publicIntegrationBuckets = makeBucketRegistry(limits.burst, limits.ratePerMinute);
  // Public delivery never competes with MCP work or another provider route
  // for the same slots. This reserves bounded callback/webhook capacity.
  const publicIntegrationSlotGates = new Map<string, SlotGate>();
  // Marks requests authenticated via the browser-session COOKIE (bead 7q9).
  // CSRF enforcement (double-submit) applies only to these — bearer-authed
  // requests carry no ambient credential a cross-site page could ride.
  const cookieAuthedReqs = new WeakSet<IncomingMessage>();
  const slotGate = opts.slotGate ?? makeSlotGate(limits.maxInFlight);
  // Fire-and-forget: an audit write must never add latency or failure to a
  // response. Errors surface once per failure on stderr. The in-flight appends
  // are tracked so close() can DRAIN them: appendAuthEvent does mkdirSync(
  // .daftari) + appendFile, so an append still pending after shutdown would
  // resurrect .daftari/ under a vault being torn down (ENOTEMPTY during rmSync
  // — observed as a load-sensitive false-red in the ops-floor suite). Draining
  // on close makes shutdown leave no straggler writer.
  const pendingAudits = new Set<Promise<unknown>>();
  const audit = (entry: Omit<AuthEvent, "ts">): void => {
    if (!config.server.audit) return;
    const p = appendAuthEvent(vaultRoot, entry).then((r) => {
      if (!r.ok)
        process.stderr.write(`daftari serve: auth-log append failed: ${r.error.message}\n`);
    });
    pendingAudits.add(p);
    void p.finally(() => pendingAudits.delete(p));
  };
  // JWKS key set, created lazily on the first OAuth verification: jose
  // caches fetched keys, so the server stays stateless and offline-tolerant
  // after the first fetch (spec Decision 2, phase 2).
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  // Set once the listener is up (the ephemeral-port case needs the BOUND
  // port); no request can arrive before listen resolves.
  let loopbackGuard: LoopbackGuard | null = null;

  // Resolves the request's identity — the first line of EVERY request
  // (spec 2026-07-26, Decision 1) — or writes the rejection and returns
  // null. With auth configured:
  //   - a static-token match binds its declared identity;
  //   - else, with oauth declared, a bearer that verifies against the IdP's
  //     JWKS (issuer + audience + signature + expiry) maps its subject claim
  //     through the declared table — a valid-but-unmapped subject is 403
  //     (authenticated, not authorized), NEVER guest;
  //   - anything else is 401. With no auth at all (startup gating
  //     guarantees loopback) every request runs as the deny-all guest.
  //
  // `auditPath` is the route pathname threaded in by the caller so that
  // board-route auth failures log the actual board path (e.g. "/api/board")
  // rather than the hardcoded "/mcp". Defaults to the request's own URL path.
  const authenticate = async (
    req: IncomingMessage,
    res: ServerResponse,
    auditPath?: string,
    // When set and the request is a browser (Accept: text/html) that fails
    // authentication with a 401 (missing/invalid credential — NOT a 403
    // unmapped-subject), redirect there instead of writing the JSON 401. Lets
    // GET /board send a browser to the login page (bead 7q9, U6).
    htmlRedirectTo?: string,
  ): Promise<AccessContext | null> => {
    const effectiveAuditPath = auditPath ?? new URL(req.url ?? "/", "http://localhost").pathname;
    if (!authConfigured) {
      return resolveAccess(config, "guest", GUEST_ROLE);
    }
    const presented = bearerFrom(req);
    if (presented !== null) {
      const matched = matchToken(presented, tokens);
      if (matched !== null) {
        return resolveAccess(config, matched.user, matched.roleName);
      }
      if (oauth) {
        try {
          jwks ??= createRemoteJWKSet(new URL(oauth.jwksUri));
          const verified = await jwtVerify(presented, jwks, {
            issuer: oauth.issuer,
            audience: oauth.audience,
          });
          const subject = verified.payload.sub;
          // Own-property lookup only: `subjects` is a plain object, and a
          // sub claim like "constructor" or "toString" would otherwise hit
          // an inherited Object.prototype member and skip the 403.
          const mapped =
            subject !== undefined && Object.hasOwn(oauth.subjects, subject)
              ? oauth.subjects[subject]
              : undefined;
          if (mapped === undefined) {
            // Authenticated but unauthorized: charge the penalty box and
            // audit the subject so the operator can see who is knocking.
            chargePenalty(penaltyBox, remoteOf(req), Date.now());
            audit({
              outcome: "deny-403",
              ...(subject !== undefined ? { subject } : {}),
              remote: remoteOf(req),
              method: req.method ?? "",
              path: effectiveAuditPath,
            });
            writeJson(res, 403, {
              error: "forbidden",
              message: "authenticated subject has no declared role mapping",
            });
            return null;
          }
          return resolveAccess(config, mapped.user, mapped.role);
        } catch {
          // Signature/issuer/audience/expiry failure — an invalid
          // credential, not an unmapped one: 401 below.
        }
      }
    }
    // Browser-session cookie (bead 7q9): consulted ONLY when no valid bearer
    // matched. A verifying cookie whose role is still declared authenticates
    // the request; anything else falls through to the 401 below (an invalid
    // cookie is never a guest downgrade). The double-submit CSRF check is NOT
    // done here — authentication and CSRF are separate concerns; the board
    // route layer enforces CSRF on cookie-authed state-changing requests.
    if (session !== null) {
      const cookie = cookiesFrom(req).get(SESSION_COOKIE);
      if (cookie !== undefined) {
        const verified = verifySession(cookie, session.key, Math.floor(Date.now() / 1000));
        if (verified.ok && verified.value.role in config.roles) {
          cookieAuthedReqs.add(req);
          return resolveAccess(config, verified.value.user, verified.value.role);
        }
      }
    }
    chargePenalty(penaltyBox, remoteOf(req), Date.now());
    audit({
      outcome: "deny-401",
      // 8 hex of sha256(presented) — correlates repeated bad tokens, useless
      // for reconstruction; successful bearers are never hashed in.
      ...(bearerFrom(req) !== null ? { token_hint: tokenHint(bearerFrom(req) as string) } : {}),
      remote: remoteOf(req),
      method: req.method ?? "",
      path: effectiveAuditPath,
    });
    if (htmlRedirectTo !== undefined && acceptsHtml(req)) {
      // Browser hitting a protected page with no session → send it to login
      // (penalty + audit already charged above, same as the JSON 401).
      writeRedirect(res, htmlRedirectTo, []);
      return null;
    }
    writeJson(res, 401, {
      error: "unauthorized",
      message: "a valid bearer token is required",
    });
    return null;
  };

  // The MCP handler: per-request, stateless. The factory runs once per
  // request with the identity our authenticate() resolved and stashed in the
  // pass-through authInfo — createServer parameterizes the access context,
  // which is what makes this migration (like 2026-07-20's) cheap. By default
  // `legacy: "reject"` answers 2025-era traffic with the
  // unsupported-protocol-version error: no dual-stacking; lagging clients
  // use stdio. `--legacy-http` (#366) amends that decision with an opt-in
  // escape hatch: the SDK's stateless legacy fallback answers 2025-era
  // requests from the same factory — same process, same per-request auth,
  // no session table (legacy GET/DELETE session operations stay 405).
  //
  // Single-holder stays the process lock's job, not the transport's: two
  // daftari processes on one vault is what .daftari/process.lock refuses
  // (2026-07-20 Decision 4), stateless wire or not.
  const mcpHandler = createMcpHandler(
    ({ authInfo }) => {
      const access =
        (authInfo?.extra as { access?: AccessContext } | undefined)?.access ??
        resolveAccess(config, "guest", GUEST_ROLE);
      return createServer(vaultRoot, access, config.tools);
    },
    { legacy: opts.legacyHttp ? "stateless" : "reject" },
  );
  const nodeHandler = toNodeHandler(mcpHandler);

  const httpServer = createHttpServer((req, res) => {
    void handle(req, res).catch((e) => {
      const reason = e instanceof Error ? e.message : String(e);
      // Log the detail server-side, but never echo internal error text (file
      // paths, git stderr, config contents) to a network client. Return a
      // generic body.
      process.stderr.write(`daftari serve: unhandled request error: ${reason}\n`);
      if (!res.headersSent) {
        writeJson(res, 500, { error: "internal" });
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Rebinding guard runs FIRST — before routing, before auth — so no
    // response (including 404s and 401 bodies) reaches a rebinded page.
    if (loopbackGuard) {
      const originHeader = req.headers.origin;
      const violation = violatesLoopbackGuard(
        loopbackGuard,
        req.headers.host,
        typeof originHeader === "string" ? originHeader : undefined,
      );
      if (violation !== null) {
        writeJson(res, 403, { error: "forbidden", message: violation });
        return;
      }
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (opts.integrationRuntime !== undefined) {
      const handled = await opts.integrationRuntime.handle(req, res, url, {
        admitPublic: (integrationRequest, integrationResponse) => {
          const remote = resolvePublicRemote(
            integrationRequest.socket.remoteAddress,
            integrationRequest.headers["x-forwarded-for"],
            trustedProxies,
          );
          const path = new URL(integrationRequest.url ?? "/", "http://localhost").pathname;
          const take = takeFromRegistry(publicIntegrationBuckets, `${path}\0${remote}`, Date.now());
          if (!take.allowed) {
            integrationResponse.setHeader("Retry-After", String(take.retryAfterSeconds));
            audit({
              outcome: "rate-limited",
              remote,
              method: integrationRequest.method ?? "",
              path,
            });
            writeJson(integrationResponse, 429, {
              error: "rate_limited",
              message: "public integration request rate limit reached",
            });
            return null;
          }
          let publicGate = publicIntegrationSlotGates.get(path);
          if (publicGate === undefined) {
            publicGate = makeSlotGate(Math.max(2, Math.ceil(limits.maxInFlight / 4)));
            publicIntegrationSlotGates.set(path, publicGate);
          }
          if (!tryAcquireSlot(publicGate)) {
            integrationResponse.setHeader("Retry-After", "1");
            audit({
              outcome: "over-capacity",
              remote,
              method: integrationRequest.method ?? "",
              path,
            });
            writeJson(integrationResponse, 503, {
              error: "over_capacity",
              message: "server is at its request ceiling",
            });
            return null;
          }
          audit({
            outcome: "allow",
            remote,
            method: integrationRequest.method ?? "",
            path,
          });
          let released = false;
          return () => {
            if (released) return;
            released = true;
            releaseSlot(publicGate);
          };
        },
        authorize: async (integrationRequest, integrationResponse) => {
          const remote = remoteOf(integrationRequest);
          const path = new URL(integrationRequest.url ?? "/", "http://localhost").pathname;
          const penalty = penaltyAllows(penaltyBox, remote, Date.now());
          if (!penalty.allowed) {
            integrationResponse.setHeader("Retry-After", String(penalty.retryAfterSeconds));
            audit({
              outcome: "rate-limited",
              remote,
              method: integrationRequest.method ?? "",
              path,
            });
            writeJson(integrationResponse, 429, {
              error: "rate_limited",
              message: "too many failed authentication attempts",
            });
            return null;
          }
          const access = await authenticate(integrationRequest, integrationResponse, url.pathname);
          if (access === null) return null;
          let bucket = principalBuckets.get(access.user);
          if (bucket === undefined) {
            bucket = makeBucket(limits.burst, limits.ratePerMinute, Date.now());
            principalBuckets.set(access.user, bucket);
          }
          const take = tryTake(bucket, Date.now());
          if (!take.allowed) {
            integrationResponse.setHeader("Retry-After", String(take.retryAfterSeconds));
            audit({
              outcome: "rate-limited",
              principal: access.user,
              remote,
              method: integrationRequest.method ?? "",
              path,
            });
            writeJson(integrationResponse, 429, {
              error: "rate_limited",
              message: "per-principal rate limit reached",
            });
            return null;
          }
          if (!tryAcquireSlot(slotGate)) {
            integrationResponse.setHeader("Retry-After", "1");
            audit({
              outcome: "over-capacity",
              principal: access.user,
              remote,
              method: integrationRequest.method ?? "",
              path,
            });
            writeJson(integrationResponse, 503, {
              error: "over_capacity",
              message: "server is at its request ceiling",
            });
            return null;
          }
          let released = false;
          const release = (): void => {
            if (released) return;
            released = true;
            releaseSlot(slotGate);
          };
          integrationResponse.once("finish", release);
          integrationResponse.once("close", release);
          audit({
            outcome: "allow",
            principal: access.user,
            remote,
            method: integrationRequest.method ?? "",
            path,
          });
          return {
            cookieAuthenticated: cookieAuthedReqs.has(integrationRequest),
            canManageIntegrations: canManageIntegrations(access.role),
          };
        },
        checkCsrf,
      });
      if (handled) return;
    }

    // ---------------------------------------------------------------------------
    // Board login shim (bead 7q9, U5) — mounted BEFORE authenticate(): the login
    // page and credential POST must be reachable WITHOUT a session. Present only
    // when a server.auth.session block is configured; otherwise these paths 404
    // like any unknown route. The rebinding/Origin guard above already ran.
    //   GET  /board/login   → login form
    //   POST /board/login   → verify password → set session+csrf cookies → 302 /board
    //   POST /board/logout  → clear cookies → 302 /board/login (CSRF-checked)
    // ---------------------------------------------------------------------------
    if (url.pathname === "/board/login" || url.pathname === "/board/logout") {
      if (session === null) {
        writeJson(res, 404, { error: "not_found" });
        return;
      }
      const loginRemote = remoteOf(req);
      const secure = config.server.transportSecurity === "external";

      if (url.pathname === "/board/login" && req.method === "GET") {
        writeHtml(res, 200, renderLoginPage(undefined, session.user));
        return;
      }

      if (url.pathname === "/board/login" && req.method === "POST") {
        // Brute-force lockout shares the pre-auth penalty box, keyed on remote.
        const gate = penaltyAllows(penaltyBox, loginRemote, Date.now());
        if (!gate.allowed) {
          res.setHeader("Retry-After", String(gate.retryAfterSeconds));
          writeJson(res, 429, {
            error: "rate_limited",
            message: "too many failed sign-in attempts",
          });
          return;
        }
        const rawBody = await readBody(req);
        if (rawBody === null) {
          writeJson(res, 400, {
            error: "bad_request",
            message: "request body too large or unreadable",
          });
          return;
        }
        const submitted = new URLSearchParams(rawBody).get("password") ?? "";
        const submittedBuf = Buffer.from(submitted, "utf-8");
        const sameLength = submittedBuf.length === session.credential.length;
        const equal = timingSafeEqual(
          sameLength ? submittedBuf : session.credential,
          session.credential,
        );
        if (!sameLength || !equal) {
          chargePenalty(penaltyBox, loginRemote, Date.now());
          audit({ outcome: "deny-401", remote: loginRemote, method: "POST", path: "/board/login" });
          writeHtml(res, 401, renderLoginPage("Incorrect password.", session.user));
          return;
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const maxAgeSec = Math.floor(session.lifetimeMs / 1000);
        const token = signSession(
          { user: session.user, role: session.roleName, exp: nowSec + maxAgeSec },
          session.key,
        );
        const csrf = randomBytes(18).toString("base64url");
        writeRedirect(res, "/board", [
          buildCookie(SESSION_COOKIE, token, { httpOnly: true, maxAgeSec, secure }),
          buildCookie(CSRF_COOKIE, csrf, { httpOnly: false, maxAgeSec, secure }),
        ]);
        return;
      }

      if (url.pathname === "/board/logout" && req.method === "POST") {
        // Logout mutates session state → CSRF-checked (double-submit). No valid
        // token → 403; the browser UI always sends it, so this only bites forced
        // cross-site logout attempts.
        const csrfError = checkCsrf(req);
        if (csrfError !== null) {
          writeJson(res, 403, { error: "forbidden", message: csrfError });
          return;
        }
        writeRedirect(res, "/board/login", [
          buildCookie(SESSION_COOKIE, "", { httpOnly: true, maxAgeSec: 0, secure }),
          buildCookie(CSRF_COOKIE, "", { httpOnly: false, maxAgeSec: 0, secure }),
        ]);
        return;
      }

      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    // ---------------------------------------------------------------------------
    // Board routes (U12) — mounted BEFORE the /mcp 404 gate so they are
    // reachable, and AFTER authenticate() so every request carries a real
    // AccessContext. The DNS-rebinding / Origin guard above already ran.
    //
    // Route list:
    //   GET  /board              → renderBoardPage HTML (R25/R26/R29)
    //   GET  /api/board          → listBoard JSON (R25/R26/R29)
    //   POST /api/board/dispose  → vaultBoardDispose (R30/R32)
    //   POST /api/board/resolve  → vaultBoardResolve (R30/R32)
    //
    // Non-disclosure (R20): dispose/resolve return 403 for both "not found"
    // and "not permitted" — identical status+body so the HTTP layer adds no
    // existence oracle beyond what the tools carefully hide.
    // ---------------------------------------------------------------------------
    const isBoardPath =
      url.pathname === "/board" ||
      url.pathname === "/api/board" ||
      url.pathname === "/api/board/dispose" ||
      url.pathname === "/api/board/resolve";

    if (isBoardPath) {
      // Board routes share the SAME pre-auth penalty-box and per-principal
      // rate-limit admission as /mcp — a flood of invalid-bearer requests to
      // /api/board/* is penalised and locked out exactly as /mcp is.
      //
      // Layer A (pre-auth): penalty box keyed on socket address. An
      // unauthenticated flood cannot spend CPU on constant-time token matching
      // or JWT verification. Charged only by a 401/403 outcome inside
      // authenticate, so a legitimate client never touches it.
      const boardRemote = remoteOf(req);
      const boardPenalty = penaltyAllows(penaltyBox, boardRemote, Date.now());
      if (!boardPenalty.allowed) {
        res.setHeader("Retry-After", String(boardPenalty.retryAfterSeconds));
        audit({
          outcome: "rate-limited",
          remote: boardRemote,
          method: req.method ?? "",
          path: url.pathname,
        });
        writeJson(res, 429, {
          error: "rate_limited",
          message: "too many failed authentication attempts",
        });
        return;
      }

      // authenticate() charges the penalty box on 401/403 and logs the real
      // board path (not "/mcp") via the auditPath argument. For a browser
      // hitting GET /board with no session, redirect to the login page instead
      // of a JSON 401 (U6) — only meaningful when a session block is configured.
      const htmlRedirectTo =
        url.pathname === "/board" && req.method === "GET" && session !== null
          ? "/board/login"
          : undefined;
      const boardAccess = await authenticate(req, res, url.pathname, htmlRedirectTo);
      if (boardAccess === null) return; // authenticate() already wrote the rejection

      // Layer B (post-auth): per-principal token-bucket, same as /mcp.
      let boardBucket = principalBuckets.get(boardAccess.user);
      if (!boardBucket) {
        boardBucket = makeBucket(limits.burst, limits.ratePerMinute, Date.now());
        principalBuckets.set(boardAccess.user, boardBucket);
      }
      const boardTake = tryTake(boardBucket, Date.now());
      if (!boardTake.allowed) {
        res.setHeader("Retry-After", String(boardTake.retryAfterSeconds));
        audit({
          outcome: "rate-limited",
          principal: boardAccess.user,
          remote: boardRemote,
          method: req.method ?? "",
          path: url.pathname,
        });
        writeJson(res, 429, {
          error: "rate_limited",
          message: "per-principal rate limit reached",
        });
        return;
      }

      const filters = filtersFromQuery(url.searchParams);
      const hasFilters = Object.keys(filters).length > 0;

      if (url.pathname === "/api/board" && req.method === "GET") {
        // GET /api/board → JSON board result
        const result = await listBoard(vaultRoot, boardAccess, hasFilters ? filters : undefined);
        writeJson(res, 200, result);
        return;
      }

      if (url.pathname === "/board" && req.method === "GET") {
        // GET /board → rendered HTML page
        const result = await listBoard(vaultRoot, boardAccess, hasFilters ? filters : undefined);
        const html = renderBoardPage(result, hasFilters ? filters : undefined);
        writeHtml(res, 200, html);
        return;
      }

      if (url.pathname === "/api/board/dispose" && req.method === "POST") {
        // POST /api/board/dispose → vaultBoardDispose
        // CSRF (U7): a cookie-authed browser must echo the double-submit token.
        // Bearer-authed callers carry no ambient credential and are exempt.
        if (cookieAuthedReqs.has(req)) {
          const csrfError = checkCsrf(req);
          if (csrfError !== null) {
            writeJson(res, 403, { error: "forbidden", message: csrfError });
            return;
          }
        }
        const rawBody = await readBody(req);
        if (rawBody === null) {
          writeJson(res, 400, {
            error: "bad_request",
            message: "request body too large or unreadable",
          });
          return;
        }
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          writeJson(res, 400, { error: "bad_request", message: "request body is not valid JSON" });
          return;
        }
        const disposeResult = await vaultBoardDispose(vaultRoot, boardAccess, config, {
          finding_id: typeof args.finding_id === "string" ? args.finding_id : "",
          event: typeof args.event === "string" ? args.event : "",
          ...(typeof args.rationale === "string" ? { rationale: args.rationale } : {}),
          ...(typeof args.expiry === "string" ? { expiry: args.expiry } : {}),
          ...(typeof args.owner === "string" ? { owner: args.owner } : {}),
        });
        if (!disposeResult.ok) {
          // Non-disclosure: use 403 for both "not found" and "not permitted"
          // so the HTTP status code does not become an existence oracle.
          // Input-validation errors (missing/invalid event, missing finding_id)
          // are 400 — they expose no finding existence.
          const msg = disposeResult.error.message;
          const isInputError =
            msg.includes("finding_id is required") ||
            msg.includes("invalid event") ||
            msg.includes("reassign requires");
          const isCapabilityError =
            msg.includes("permission denied") || msg.includes("lacks the dispose capability");
          if (isInputError) {
            writeJson(res, 400, { error: "bad_request", message: msg });
          } else if (isCapabilityError) {
            // Capability check fires BEFORE any finding lookup (Gate 1 in
            // vaultBoardDispose). The role-naming message here is therefore
            // identical whether the finding exists or not — it carries no
            // existence information, so emitting it does not create an oracle.
            // This is deliberately different from the non-disclosure branch
            // below, which emits the fixed "not found or not permitted" body
            // for both "finding absent" and "RBAC-hidden" to prevent those
            // two outcomes from being distinguished by their HTTP bodies.
            writeJson(res, 403, { error: "forbidden", message: msg });
          } else {
            // "not found or not permitted" — the non-disclosing error from the tool.
            // Always 403, never 404, so existence (present-but-hidden vs absent)
            // is indistinguishable to the caller.
            writeJson(res, 403, { error: "forbidden", message: msg });
          }
          return;
        }
        writeJson(res, 200, disposeResult.value);
        return;
      }

      if (url.pathname === "/api/board/resolve" && req.method === "POST") {
        // POST /api/board/resolve → vaultBoardResolve
        // CSRF (U7): cookie-authed browsers must echo the double-submit token.
        if (cookieAuthedReqs.has(req)) {
          const csrfError = checkCsrf(req);
          if (csrfError !== null) {
            writeJson(res, 403, { error: "forbidden", message: csrfError });
            return;
          }
        }
        const rawBody = await readBody(req);
        if (rawBody === null) {
          writeJson(res, 400, {
            error: "bad_request",
            message: "request body too large or unreadable",
          });
          return;
        }
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          writeJson(res, 400, { error: "bad_request", message: "request body is not valid JSON" });
          return;
        }
        const resolveResult = await vaultBoardResolve(vaultRoot, boardAccess, config, {
          finding_id: typeof args.finding_id === "string" ? args.finding_id : "",
        });
        if (!resolveResult.ok) {
          const msg = resolveResult.error.message;
          const isInputError = msg.includes("finding_id is required");
          if (isInputError) {
            writeJson(res, 400, { error: "bad_request", message: msg });
          } else {
            // Non-disclosure: 403 for both not-found and not-permitted.
            writeJson(res, 403, { error: "forbidden", message: msg });
          }
          return;
        }
        writeJson(res, 200, resolveResult.value);
        return;
      }

      // Method not allowed on a known board path (e.g. POST /board)
      writeJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    if (url.pathname !== "/mcp") {
      writeJson(res, 404, { error: "not_found" });
      return;
    }

    // Ops floor, layer A — the pre-auth penalty box. CHECKED here so an
    // unauthenticated flood cannot spend CPU on constant-time token matching
    // or JWT verification; CHARGED only by a 401/403 outcome inside
    // authenticate, so a legitimate authenticated client never touches it.
    // Keyed on the socket address — never X-Forwarded-For (attacker-writable).
    const remote = remoteOf(req);
    const penalty = penaltyAllows(penaltyBox, remote, Date.now());
    if (!penalty.allowed) {
      res.setHeader("Retry-After", String(penalty.retryAfterSeconds));
      audit({ outcome: "rate-limited", remote, method: req.method ?? "", path: "/mcp" });
      writeJson(res, 429, {
        error: "rate_limited",
        message: "too many failed authentication attempts",
      });
      return;
    }

    const access = await authenticate(req, res, "/mcp");
    if (access === null) return;

    // Layer B — the per-principal bucket, keyed on the VERIFIED identity.
    let bucket = principalBuckets.get(access.user);
    if (!bucket) {
      bucket = makeBucket(limits.burst, limits.ratePerMinute, Date.now());
      principalBuckets.set(access.user, bucket);
    }
    const take = tryTake(bucket, Date.now());
    if (!take.allowed) {
      res.setHeader("Retry-After", String(take.retryAfterSeconds));
      audit({
        outcome: "rate-limited",
        principal: access.user,
        remote,
        method: req.method ?? "",
        path: "/mcp",
      });
      writeJson(res, 429, { error: "rate_limited", message: "per-principal rate limit reached" });
      return;
    }

    // The global in-flight ceiling: reject-don't-queue (a bounded HTTP queue
    // would age read snapshots and inflate stale-write rejections — the file
    // lease's own fail-fast property, one layer up).
    if (!tryAcquireSlot(slotGate)) {
      res.setHeader("Retry-After", "1");
      audit({
        outcome: "over-capacity",
        principal: access.user,
        remote,
        method: req.method ?? "",
        path: "/mcp",
      });
      writeJson(res, 503, { error: "over_capacity", message: "server is at its request ceiling" });
      return;
    }

    // Exactly one audit outcome per request: "allow" means ADMITTED to the
    // handler — a throttled or shed request logs its rejection alone.
    audit({
      outcome: "allow",
      principal: access.user,
      remote,
      method: req.method ?? "",
      path: "/mcp",
    });

    try {
      // Bound the body BEFORE the MCP adapter reads it. toWebRequest buffers
      // the whole stream unbounded, so a large or slow body would pin memory /
      // this in-flight slot. We pre-read under the byte cap + deadline and hand
      // the parsed value to the adapter as `parsedBody` — the documented
      // pass-through that makes it read nothing from `req`.
      let parsedBody: unknown;
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        const read = await readBodyBounded(req, limits.maxBodyBytes, MCP_BODY_DEADLINE_MS);
        if (read.status !== "ok") {
          // The body was never fully read, so close the connection rather than
          // try to reuse it — the unread remainder would corrupt keep-alive.
          res.setHeader("Connection", "close");
          if (read.status === "too_large") {
            writeJson(res, 413, {
              error: "payload_too_large",
              message: "request body exceeds the configured limit",
            });
          } else if (read.status === "timeout") {
            writeJson(res, 408, {
              error: "request_timeout",
              message: "request body was not received in time",
            });
          } else {
            writeJson(res, 400, { error: "bad_request", message: "could not read request body" });
          }
          return;
        }
        if (read.body.length > 0) {
          try {
            parsedBody = JSON.parse(read.body);
          } catch {
            writeJson(res, 400, {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            });
            return;
          }
        }
      }
      // toNodeHandler forwards req.auth as the handler's pass-through authInfo
      // (it performs no verification of its own — ours ran above). The bearer
      // is the credential; `_meta` client info is diagnostics, never identity.
      (req as IncomingMessage & { auth?: AuthInfo }).auth = {
        token: bearerFrom(req) ?? "",
        clientId: access.user,
        scopes: [],
        extra: { access },
      };
      await nodeHandler(req, res, parsedBody);
    } finally {
      releaseSlot(slotGate);
    }
  }

  return new Promise((resolveStart, rejectStart) => {
    httpServer.once("error", rejectStart);
    httpServer.listen(port, bind, () => {
      const address = httpServer.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      if (isLoopbackBind(bind)) loopbackGuard = makeLoopbackGuard(boundPort);
      void (async () => {
        if (opts.integrationRuntime !== undefined) {
          const started = await opts.integrationRuntime.start(httpCallbackBase(bind, boundPort));
          if (!started.ok) {
            await new Promise<void>((done) => httpServer.close(() => done()));
            rejectStart(started.error);
            return;
          }
        }
        httpServer.removeListener("error", rejectStart);
        resolveStart({
          port: boundPort,
          close: async () => {
            // Freeze network admission first so a webhook stream cannot keep
            // requesting connector reruns while shutdown drains the active
            // cycle. The callback resolves after existing HTTP exchanges end.
            const listenerClosed = new Promise<void>((done) => httpServer.close(() => done()));
            await opts.integrationRuntime?.close();
            // close() aborts in-flight exchanges and resolves once every
            // per-request instance has terminated — there is no session table
            // to drain.
            await mcpHandler.close();
            await listenerClosed;
            // Drain fire-and-forget audit appends last: no request can start a
            // new one once the listener is closed, so this settles the tail and
            // guarantees no append resurrects .daftari/ after shutdown.
            await Promise.allSettled([...pendingAudits]);
          },
        });
      })().catch(async (cause) => {
        await new Promise<void>((done) => httpServer.close(() => done()));
        rejectStart(cause);
      });
    });
  });
}

// Startup gate for periodic storage sync (#6): when the config declares a
// sync cadence, the backend must be creatable BEFORE the server binds — a
// missing SDK or bad endpoint refuses at startup instead of leaving a
// healthy-looking server that silently never syncs. ok(null) when no
// periodic sync is configured.
export async function prepareStorageSync(
  config: DaftariConfig,
): Promise<Result<StorageBackend | null, Error>> {
  const storage = config.storage;
  if (storage?.syncIntervalMinutes === undefined) return ok(null);
  return createBackend(storage);
}

// The periodic push itself (#6): overlap-guarded (a slow push skips ticks
// rather than stacking), failures logged and never fatal — the backing is a
// durability channel, not a serving dependency. The timer is unref'd so it
// never keeps a dying process alive. Returns a stopper. `syncFn` is
// injectable for tests.
export function startPeriodicSync(
  vaultRoot: string,
  backend: StorageBackend,
  intervalMinutes: number,
  syncFn: typeof syncVault = syncVault,
): () => void {
  let syncing = false;
  const timer = setInterval(
    () => {
      if (syncing) return;
      syncing = true;
      void syncFn(vaultRoot, backend)
        .then((r) => {
          if (!r.ok) {
            process.stderr.write(`daftari: warning: storage sync failed: ${r.error.message}\n`);
          }
        })
        .finally(() => {
          syncing = false;
        });
    },
    intervalMinutes * 60 * 1000,
  );
  timer.unref();
  return () => clearInterval(timer);
}

export async function runServe(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const vaultArg = parseFlag(argv, "vault");
  if (!vaultArg) {
    process.stderr.write("daftari serve: missing required --vault <path> argument\n");
    return 2;
  }
  const vaultRoot = resolve(vaultArg);
  if (!(await directoryExists(vaultRoot))) {
    process.stderr.write(`daftari serve: vault directory not found: ${vaultRoot}\n`);
    return 2;
  }
  const bind = parseFlag(argv, "bind") ?? DEFAULT_BIND;
  const legacyHttp = argv.includes("--legacy-http");
  const portRaw = parseFlag(argv, "port");
  const port = portRaw === null ? DEFAULT_PORT : Number.parseInt(portRaw, 10);
  if (Number.isNaN(port) || port < 0 || port > 65535) {
    process.stderr.write(`daftari serve: invalid --port '${portRaw}'\n`);
    return 2;
  }

  const config = loadConfig(vaultRoot);
  if (!config.ok) {
    process.stderr.write(`daftari serve: ${config.error.message}\n`);
    return 2;
  }
  const gate = validateServeStartup(config.value, bind, process.env);
  if (!gate.ok) {
    process.stderr.write(`daftari serve: ${gate.error}\n`);
    return 2;
  }

  let integrationRuntime: IntegrationRuntime | undefined;
  if (config.value.integrations !== undefined) {
    const created = createConfiguredIntegrationRuntime({
      vaultRoot,
      config: config.value.integrations,
      environment: process.env,
      ...(config.value.server.publicBaseUrl === undefined
        ? {}
        : { publicBaseUrl: config.value.server.publicBaseUrl }),
      onError: (message) => process.stderr.write(`daftari: warning: ${message}\n`),
    });
    if (!created.ok) {
      process.stderr.write(`daftari serve: ${created.error.message}\n`);
      return 2;
    }
    integrationRuntime = created.value;
  }

  // Storage backing for periodic sync (#6): created and validated BEFORE the
  // lock and the listener. A config-declared capability that cannot run must
  // refuse at startup — returning an exit code after the listener is up
  // would leave a healthy-looking server that silently never syncs.
  const syncBackend = await prepareStorageSync(config.value);
  if (!syncBackend.ok) {
    process.stderr.write(`daftari serve: ${syncBackend.error.message}\n`);
    return 2;
  }

  const lock = await acquireLock(vaultRoot, SERVER_VERSION, {
    mode: "serve",
    bind: `${bind}:${port}`,
    takeover: argv.includes("--takeover"),
  });
  if (!lock.ok) {
    process.stderr.write(`daftari serve: ${lock.error.message}\n`);
    return 2;
  }
  // Install immediately after the lock lands (the stdio path's guarantee):
  // a failure between here and the listener opening must still release the
  // lock on exit. `handle` is assigned once the listener is up.
  let handle: ServeHandle | null = null;
  installShutdownHandlers(vaultRoot, async () => {
    if (handle) await handle.close();
  });

  // Existing vaults may predate the integration-state ignore block. Upgrade
  // it only after this process owns the vault: a refused second process must
  // remain read-only.
  if (config.value.integrations !== undefined) {
    try {
      await ensureVaultGitignore(vaultRoot);
    } catch (cause) {
      releaseLock(vaultRoot);
      const reason = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`daftari serve: cannot secure local integration state: ${reason}\n`);
      return 3;
    }
  }

  try {
    setProvider(config.value.embeddingProvider);
  } catch (e) {
    process.stderr.write(`daftari serve: ${e instanceof Error ? e.message : String(e)}\n`);
    return 3;
  }
  // Retrieval tuning (`search` block): validated by loadConfig, applied once
  // per process, same lifecycle as the provider above.
  setCoverageEnabled(config.value.search.coverage);
  setVecKnnK(config.value.search.vecKnnK);
  setDefaultWeights(config.value.search.weights);
  setSuppressSuperseded(config.value.search.suppressSuperseded);
  setGraphExpandConfig(config.value.search.graphExpand);

  // Startup warnings mirror stdio's: unknown tool names in the tools block.
  for (const name of resolveToolExposure(config.value.tools).unknown) {
    process.stderr.write(
      `daftari: warning: tools.include/exclude names unknown tool '${name}' — ignored\n`,
    );
  }

  try {
    handle = await startHttpServer(vaultRoot, config.value, gate.tokens, bind, port, {
      legacyHttp,
      session: gate.session,
      ...(integrationRuntime === undefined ? {} : { integrationRuntime }),
    });
  } catch (e) {
    process.stderr.write(
      `daftari serve: failed to bind ${bind}:${port}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 3;
  }

  const authParts = [
    ...(gate.tokens.length > 0 ? [`${gate.tokens.length} token(s)`] : []),
    ...(config.value.server.oauth !== undefined ? ["oauth"] : []),
  ];
  process.stderr.write(
    `daftari: serving vault at ${vaultRoot} — http://${bind}:${handle.port}/mcp ` +
      `(${authParts.length > 0 ? authParts.join(" + ") : "no auth: guest-only"})` +
      `${legacyHttp ? " [legacy-http]" : ""}\n`,
  );

  await startVaultServices(vaultRoot, {
    warmEmbeddings: config.value.warmEmbeddings,
    watch: config.value.watch,
  });

  // Periodic push to the storage backing (#6). The backend was created and
  // validated BEFORE the listener opened (prepareStorageSync); from here on
  // sync failures are logged, never fatal — the backing is a durability
  // channel, not a serving dependency. Overlap-guarded: a slow push skips
  // ticks rather than stacking.
  const intervalMinutes = config.value.storage?.syncIntervalMinutes;
  if (syncBackend.value !== null && intervalMinutes !== undefined) {
    startPeriodicSync(vaultRoot, syncBackend.value, intervalMinutes);
    process.stderr.write(`daftari: syncing to ${syncBackend.value.id} every ${intervalMinutes}m\n`);
  }
  return 0;
}
