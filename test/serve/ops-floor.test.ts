// The serve ops floor over HTTP (multi-user item 6): per-principal 429s, the
// pre-auth penalty box, the global 503 ceiling, and the operator-only auth
// audit log. Servers run in-process on ephemeral loopback ports (the
// 2026-07-20 test posture); state is per-server, so each group boots its own.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authLogPath } from "../../src/serve/auth-log.js";
import { type ServeHandle, startHttpServer, validateServeStartup } from "../../src/serve/index.js";
import { makeSlotGate } from "../../src/serve/limits.js";
import { vaultReindex } from "../../src/tools/search.js";
import { type DaftariConfig, loadConfig } from "../../src/utils/config.js";

function buildVault(limitsYaml: string, auditYaml = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-opsfloor-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(
    join(dir, "notes", "p1.md"),
    "---\ntitle: p1\ncollection: public\ndomain: accumulation\nstatus: canonical\nconfidence: high\ncreated: 2026-03-01\nupdated: 2026-03-01\ntags: [t]\n---\n\nnote\n",
  );
  mkdirSync(join(dir, ".daftari"), { recursive: true });
  writeFileSync(
    join(dir, ".daftari", "config.yaml"),
    `version: 1
roles:
  admin:
    read: ["*"]
    write: ["*"]
server:
${limitsYaml}${auditYaml}  auth:
    tokens:
      - env: DAFTARI_OPSFLOOR_TOKEN_A
        user: human:alice
        role: admin
      - env: DAFTARI_OPSFLOOR_TOKEN_B
        user: human:bob
        role: admin
`,
  );
  return dir;
}

function loadedConfig(vault: string): DaftariConfig {
  const c = loadConfig(vault);
  if (!c.ok) throw c.error;
  return c.value;
}

async function boot(vault: string, opts = {}): Promise<ServeHandle> {
  const reindexed = await vaultReindex(vault);
  if (!reindexed.ok) throw reindexed.error;
  const cfg = loadedConfig(vault);
  const gate = validateServeStartup(cfg, "127.0.0.1", process.env);
  if (!gate.ok) throw new Error(gate.error);
  return startHttpServer(vault, cfg, gate.tokens, "127.0.0.1", 0, opts);
}

// A minimal valid 2026-07-28 stateless request: the revision requires the
// protocol-version and method headers plus the per-request _meta envelope.
function call(port: number, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
}

async function readAuthLog(
  vault: string,
  expectLines: number,
): Promise<Array<Record<string, unknown>>> {
  // Appends are fire-and-forget: polling for file EXISTENCE alone races the
  // later appends (seen on CI — the deny-401 line landed after the read).
  // Poll until the expected line count arrives, bounded.
  const read = (): Array<Record<string, unknown>> =>
    existsSync(authLogPath(vault))
      ? readFileSync(authLogPath(vault), "utf-8")
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l))
      : [];
  for (let i = 0; i < 80; i++) {
    if (read().length >= expectLines) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return read();
}

beforeAll(() => {
  process.env.DAFTARI_OPSFLOOR_TOKEN_A = "alice-secret";
  process.env.DAFTARI_OPSFLOOR_TOKEN_B = "bob-secret";
});

describe("per-principal rate limit (429)", () => {
  let vault: string;
  let handle: ServeHandle;
  beforeAll(async () => {
    vault = buildVault("  limits:\n    burst: 2\n    rate_per_minute: 1\n");
    handle = await boot(vault);
  }, 60_000);
  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("throttles the exhausted principal with Retry-After, leaving others untouched", async () => {
    expect((await call(handle.port, "alice-secret")).status).toBe(200);
    expect((await call(handle.port, "alice-secret")).status).toBe(200);
    const limited = await call(handle.port, "alice-secret");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    const body = (await limited.json()) as { error?: string };
    expect(body.error).toBe("rate_limited");
    // Bob's bucket is his own.
    expect((await call(handle.port, "bob-secret")).status).toBe(200);
  }, 30_000);
});

describe("pre-auth penalty box", () => {
  let vault: string;
  let handle: ServeHandle;
  beforeAll(async () => {
    vault = buildVault("  limits:\n    auth_failure_burst: 2\n    auth_failures_per_minute: 1\n");
    handle = await boot(vault);
  }, 60_000);
  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("locks the client out pre-auth after the failure burst — valid tokens included", async () => {
    expect((await call(handle.port, "wrong-1")).status).toBe(401);
    expect((await call(handle.port, "wrong-2")).status).toBe(401);
    // Third request is refused before auth runs at all…
    expect((await call(handle.port, "wrong-3")).status).toBe(429);
    // …including with a valid token: the documented shared-client collateral,
    // asserted so it stays a choice rather than an accident.
    expect((await call(handle.port, "alice-secret")).status).toBe(429);
  }, 30_000);
});

describe("in-flight ceiling (503)", () => {
  let vault: string;
  let handle: ServeHandle;
  const gate = makeSlotGate(2);
  beforeAll(async () => {
    vault = buildVault("  limits:\n    max_in_flight: 2\n");
    // Test-only injection: preload the gate to its ceiling instead of racing
    // slow requests.
    gate.inFlight = 2;
    handle = await boot(vault, { slotGate: gate });
  }, 60_000);
  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("rejects authenticated requests at the ceiling with 503 + Retry-After: 1", async () => {
    const res = await call(handle.port, "alice-secret");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("1");
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("over_capacity");
    // Free a slot: requests flow again.
    gate.inFlight = 0;
    expect((await call(handle.port, "alice-secret")).status).toBe(200);
  }, 30_000);
});

describe("auth audit log", () => {
  let vault: string;
  let handle: ServeHandle;
  beforeAll(async () => {
    vault = buildVault("  limits:\n    burst: 1\n    rate_per_minute: 1\n");
    handle = await boot(vault);
  }, 60_000);
  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("records allow, rate-limited, and deny-401 with the declared shapes — and nothing more", async () => {
    await call(handle.port, "alice-secret"); // allow (spends the burst)
    await call(handle.port, "alice-secret"); // rate-limited (principal known)
    await call(handle.port, "wrong-token"); // deny-401 (token_hint)

    const lines = await readAuthLog(vault, 3);
    const outcomes = lines.map((l) => l.outcome);
    expect(outcomes).toContain("allow");
    expect(outcomes).toContain("rate-limited");
    expect(outcomes).toContain("deny-401");
    // Exactly ONE outcome per request: "allow" means admitted to the
    // handler, so a throttled request logs rate-limited alone, never an
    // allow line followed by a rate-limited line.
    expect(lines).toHaveLength(3);

    const allow = lines.find((l) => l.outcome === "allow");
    expect(allow?.principal).toBe("human:alice");
    expect(allow?.path).toBe("/mcp");
    const limited = lines.find((l) => l.outcome === "rate-limited");
    expect(limited?.principal).toBe("human:alice");
    const denied = lines.find((l) => l.outcome === "deny-401");
    expect(denied?.token_hint).toMatch(/^[0-9a-f]{8}$/);
    expect(denied?.principal).toBeUndefined();

    // Privacy floor: no line ever carries a tool name, argument, or the
    // bearer itself.
    const raw = readFileSync(authLogPath(vault), "utf-8");
    expect(raw).not.toContain("tools/list");
    expect(raw).not.toContain("wrong-token");
    expect(raw).not.toContain("alice-secret");
  }, 30_000);
});

describe("audit opt-out", () => {
  let vault: string;
  let handle: ServeHandle;
  beforeAll(async () => {
    vault = buildVault("  limits:\n    burst: 5\n", "  audit: false\n");
    handle = await boot(vault);
  }, 60_000);
  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("writes no auth log when server.audit is false", async () => {
    await call(handle.port, "alice-secret");
    await call(handle.port, "wrong-token");
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(authLogPath(vault))).toBe(false);
  }, 30_000);
});
