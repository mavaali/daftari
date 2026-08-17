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

import { timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { type AuthInfo, createMcpHandler } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { type AccessContext, GUEST_ROLE, resolveAccess } from "../access/rbac.js";
import { loadAttestKey } from "../attest/sign.js";
import { ok, type Result } from "../frontmatter/types.js";
import { installShutdownHandlers, parseFlag, startVaultServices } from "../index.js";
import { acquireLock } from "../lifecycle/lock.js";
import { setCoverageEnabled } from "../search/coverage.js";
import { setVecKnnK } from "../search/hybrid.js";
import { setSuppressSuperseded } from "../search/suppression.js";
import { setProvider } from "../search/vector.js";
import { createServer, resolveToolExposure, SERVER_VERSION } from "../server.js";
import { createBackend, type StorageBackend } from "../storage/backend.js";
import { directoryExists } from "../storage/local.js";
import { syncVault } from "../storage/sync.js";
import { type DaftariConfig, loadConfig } from "../utils/config.js";
import { type AuthEvent, appendAuthEvent, tokenHint } from "./auth-log.js";
import {
  type Bucket,
  chargePenalty,
  makeBucket,
  makePenaltyBox,
  makeSlotGate,
  penaltyAllows,
  releaseSlot,
  type SlotGate,
  tryAcquireSlot,
  tryTake,
} from "./limits.js";

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

const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);

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
): { ok: true; tokens: ResolvedToken[] } | { ok: false; error: string } {
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
  const authConfigured = config.server.tokens.length > 0 || config.server.oauth !== undefined;
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
  return { ok: true, tokens };
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

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
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
  const authConfigured = tokens.length > 0 || oauth !== undefined;

  // The ops floor (multi-user item 6). Process-local in-memory state is
  // correct by construction: one serve process per vault is the invariant
  // (.daftari/process.lock), the principal set is config-declared and
  // finite, and a restart re-arms the floor immediately.
  const limits = config.server.limits;
  const penaltyBox = makePenaltyBox(limits.authFailureBurst, limits.authFailuresPerMinute);
  const principalBuckets = new Map<string, Bucket>();
  const slotGate = opts.slotGate ?? makeSlotGate(limits.maxInFlight);
  // Fire-and-forget: an audit write must never add latency or failure to a
  // response. Errors surface once per failure on stderr.
  const audit = (entry: Omit<AuthEvent, "ts">): void => {
    if (!config.server.audit) return;
    void appendAuthEvent(vaultRoot, entry).then((r) => {
      if (!r.ok)
        process.stderr.write(`daftari serve: auth-log append failed: ${r.error.message}\n`);
    });
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
  const authenticate = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<AccessContext | null> => {
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
              path: "/mcp",
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
    chargePenalty(penaltyBox, remoteOf(req), Date.now());
    audit({
      outcome: "deny-401",
      // 8 hex of sha256(presented) — correlates repeated bad tokens, useless
      // for reconstruction; successful bearers are never hashed in.
      ...(bearerFrom(req) !== null ? { token_hint: tokenHint(bearerFrom(req) as string) } : {}),
      remote: remoteOf(req),
      method: req.method ?? "",
      path: "/mcp",
    });
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

    const access = await authenticate(req, res);
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
      // toNodeHandler forwards req.auth as the handler's pass-through authInfo
      // (it performs no verification of its own — ours ran above). The bearer
      // is the credential; `_meta` client info is diagnostics, never identity.
      (req as IncomingMessage & { auth?: AuthInfo }).auth = {
        token: bearerFrom(req) ?? "",
        clientId: access.user,
        scopes: [],
        extra: { access },
      };
      await nodeHandler(req, res);
    } finally {
      releaseSlot(slotGate);
    }
  }

  return new Promise((resolveStart, rejectStart) => {
    httpServer.once("error", rejectStart);
    httpServer.listen(port, bind, () => {
      httpServer.removeListener("error", rejectStart);
      const address = httpServer.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      if (isLoopbackBind(bind)) loopbackGuard = makeLoopbackGuard(boundPort);
      resolveStart({
        port: boundPort,
        close: async () => {
          // close() aborts in-flight exchanges and resolves once every
          // per-request instance has terminated — there is no session table
          // to drain.
          await mcpHandler.close();
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
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
  installShutdownHandlers(vaultRoot, () => {
    if (handle) void handle.close();
  });

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
  setSuppressSuperseded(config.value.search.suppressSuperseded);

  // Startup warnings mirror stdio's: unknown tool names in the tools block.
  for (const name of resolveToolExposure(config.value.tools).unknown) {
    process.stderr.write(
      `daftari: warning: tools.include/exclude names unknown tool '${name}' — ignored\n`,
    );
  }

  try {
    handle = await startHttpServer(vaultRoot, config.value, gate.tokens, bind, port, {
      legacyHttp,
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
