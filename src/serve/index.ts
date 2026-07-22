// `daftari serve` (#5, spec 2026-07-20) — server mode over Streamable HTTP.
//
// One always-on instance, many MCP clients. The mechanical core: createServer
// already parameterizes the access context, so each MCP session gets its own
// Server bound to the identity resolved when the session opened — no tool
// handler changes, and every RBAC/existence-disclosure invariant applies
// per session, transport-independently.
//
// Fail-loud rules (all from the spec, all startup or session-open errors,
// never silent downgrades):
//   - non-loopback bind requires auth configured AND
//     server.transport_security: external declared;
//   - a token entry whose env var is unset, or whose role is not declared,
//     refuses to start;
//   - once auth is configured, a missing/unmatched bearer token is rejected
//     at session open (401) on every bind — never downgraded to guest;
//   - the deny-all guest exists only in the no-auth loopback configuration.

import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { type AccessContext, GUEST_ROLE, resolveAccess } from "../access/rbac.js";
import { installShutdownHandlers, startVaultServices } from "../index.js";
import { acquireLock } from "../lifecycle/lock.js";
import { setProvider } from "../search/vector.js";
import { createServer, resolveToolExposure, SERVER_VERSION } from "../server.js";
import { directoryExists } from "../storage/local.js";
import { type DaftariConfig, loadConfig } from "../utils/config.js";

export const DEFAULT_PORT = 8787;
export const DEFAULT_BIND = "127.0.0.1";

const HELP = `daftari serve — server mode over Streamable HTTP (spec 2026-07-20).

Usage:
  daftari serve --vault <path> [--port <n>] [--bind <addr>] [--takeover]

Defaults:
  --port ${DEFAULT_PORT}
  --bind ${DEFAULT_BIND}   (loopback; non-loopback binds require auth AND
                    server.transport_security: external in config)

  --takeover      deliberately replace a LIVE daftari holding this vault
                  (a plain serve refuses against any live holder)

Endpoint: http://<bind>:<port>/mcp   (MCP Streamable HTTP)

Auth (config server.auth.tokens): clients send "Authorization: Bearer <token>".
Token values come from the env vars named in config — never from config
itself. With auth configured, a missing/unmatched token is a 401 at session
open; with no auth (loopback only), sessions run as the deny-all guest.

Exit codes: 2 config/usage error, 3 runtime error.
`;

// A resolved phase-1 credential: the secret bytes and the identity a match
// binds the session to.
interface ResolvedToken {
  secret: Buffer;
  user: string;
  roleName: string;
}

const LOOPBACK_BINDS = new Set(["127.0.0.1", "::1", "localhost"]);

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
  const authConfigured = config.server.tokens.length > 0;
  if (!isLoopbackBind(bind)) {
    if (!authConfigured) {
      return {
        ok: false,
        error:
          `refusing to bind ${bind} with no authentication configured — ` +
          `declare server.auth.tokens in .daftari/config.yaml`,
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

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (raw.length === 0) {
        resolveBody(undefined);
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch (e) {
        rejectBody(e);
      }
    });
    req.on("error", rejectBody);
  });
}

interface LiveSession {
  transport: StreamableHTTPServerTransport;
  // Identity bound at session open. Later requests must present a credential
  // resolving to the SAME user — a session id is not a bearer credential.
  user: string;
}

export interface ServeHandle {
  port: number;
  close: () => Promise<void>;
}

// Starts the HTTP listener and session router. Exported separately from
// runServe so tests can drive a live server in-process on an ephemeral port
// without argv parsing, lock acquisition, or process-global side effects.
export function startHttpServer(
  vaultRoot: string,
  config: DaftariConfig,
  tokens: ResolvedToken[],
  bind: string,
  port: number,
): Promise<ServeHandle> {
  const sessions = new Map<string, LiveSession>();
  const authConfigured = tokens.length > 0;

  // Resolves the request's identity under the spec's session rules, or
  // writes the rejection and returns null. With auth configured a
  // missing/unmatched token is 401 on every bind — never guest. With no
  // auth (startup gating guarantees loopback) every session is the
  // deny-all guest.
  const authenticate = (req: IncomingMessage, res: ServerResponse): AccessContext | null => {
    if (!authConfigured) {
      return resolveAccess(config, "guest", GUEST_ROLE);
    }
    const presented = bearerFrom(req);
    const matched = presented === null ? null : matchToken(presented, tokens);
    if (matched === null) {
      writeJson(res, 401, {
        error: "unauthorized",
        message: "a valid bearer token is required",
      });
      return null;
    }
    return resolveAccess(config, matched.user, matched.roleName);
  };

  const httpServer = createHttpServer((req, res) => {
    void handle(req, res).catch((e) => {
      const reason = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) {
        writeJson(res, 500, { error: "internal", message: reason });
      } else {
        res.end();
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== "/mcp") {
      writeJson(res, 404, { error: "not_found" });
      return;
    }

    const access = authenticate(req, res);
    if (access === null) return;

    const sessionId = req.headers["mcp-session-id"];
    const existing = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;

    if (existing) {
      // A session id is routing state, not a credential: the request's own
      // bearer must resolve to the identity the session was opened with.
      if (existing.user !== access.user) {
        writeJson(res, 401, {
          error: "unauthorized",
          message: "credential does not match the session's identity",
        });
        return;
      }
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await existing.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method !== "POST") {
      writeJson(res, 400, { error: "bad_request", message: "unknown or missing session" });
      return;
    }
    const body = await readBody(req);
    if (!isInitializeRequest(body)) {
      writeJson(res, 400, {
        error: "bad_request",
        message: "expected an initialize request to open a session",
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, user: access.user });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    transport.onclose = () => {
      const id = transport.sessionId;
      if (id) sessions.delete(id);
    };

    // One Server per session, bound to the session's identity — the whole
    // point of Decision 2.
    const server = createServer(vaultRoot, access, config.tools);
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return new Promise((resolveStart, rejectStart) => {
    httpServer.once("error", rejectStart);
    httpServer.listen(port, bind, () => {
      httpServer.removeListener("error", rejectStart);
      const address = httpServer.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolveStart({
        port: boundPort,
        close: async () => {
          for (const [, s] of sessions) {
            await s.transport.close().catch(() => {});
          }
          sessions.clear();
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });
  });
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

export async function runServe(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  const vaultArg = flag(argv, "vault");
  if (!vaultArg) {
    process.stderr.write("daftari serve: missing required --vault <path> argument\n");
    return 2;
  }
  const vaultRoot = resolve(vaultArg);
  if (!(await directoryExists(vaultRoot))) {
    process.stderr.write(`daftari serve: vault directory not found: ${vaultRoot}\n`);
    return 2;
  }
  const bind = flag(argv, "bind") ?? DEFAULT_BIND;
  const portRaw = flag(argv, "port");
  const port = portRaw === undefined ? DEFAULT_PORT : Number.parseInt(portRaw, 10);
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

  const lock = await acquireLock(vaultRoot, SERVER_VERSION, {
    mode: "serve",
    bind: `${bind}:${port}`,
    takeover: argv.includes("--takeover"),
  });
  if (!lock.ok) {
    process.stderr.write(`daftari serve: ${lock.error.message}\n`);
    return 2;
  }

  try {
    setProvider(config.value.embeddingProvider);
  } catch (e) {
    process.stderr.write(`daftari serve: ${e instanceof Error ? e.message : String(e)}\n`);
    return 3;
  }

  // Startup warnings mirror stdio's: unknown tool names in the tools block.
  for (const name of resolveToolExposure(config.value.tools).unknown) {
    process.stderr.write(
      `daftari: warning: tools.include/exclude names unknown tool '${name}' — ignored\n`,
    );
  }

  let handle: ServeHandle;
  try {
    handle = await startHttpServer(vaultRoot, config.value, gate.tokens, bind, port);
  } catch (e) {
    process.stderr.write(
      `daftari serve: failed to bind ${bind}:${port}: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    return 3;
  }
  installShutdownHandlers(vaultRoot, () => {
    void handle.close();
  });

  process.stderr.write(
    `daftari: serving vault at ${vaultRoot} — http://${bind}:${handle.port}/mcp ` +
      `(${gate.tokens.length > 0 ? `${gate.tokens.length} token(s)` : "no auth: guest-only"})\n`,
  );

  await startVaultServices(vaultRoot, {
    warmEmbeddings: config.value.warmEmbeddings,
    watch: config.value.watch,
  });
  return 0;
}
