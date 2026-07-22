// OAuth 2.1 resource-server auth for `daftari serve` (#7, spec phase 2).
// Fully offline: an in-test HTTP server plays the IdP's JWKS endpoint, and
// test JWTs are signed with a locally generated RSA key. Drives the same
// in-process serve harness as serve.test.ts.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ServeHandle, startHttpServer, validateServeStartup } from "../../src/serve/index.js";
import { vaultReindex } from "../../src/tools/search.js";
import { type DaftariConfig, loadConfig } from "../../src/utils/config.js";

const ISSUER = "https://idp.test.example";
const AUDIENCE = "daftari-test";

// A vault whose config declares OAuth subjects (analyst = public only,
// admin = everything) plus ONE static token, to prove the schemes compose.
function buildVault(jwksUri: string): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-oauth-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  const notes = [
    { name: "s1.md", collection: "secret", body: "zephyr calibration zephyr calibration" },
    { name: "p1.md", collection: "public", body: "zephyr overview note" },
  ];
  for (const n of notes) {
    writeFileSync(
      join(dir, "notes", n.name),
      `---\ntitle: ${n.name}\ncollection: ${n.collection}\ndomain: accumulation\nstatus: canonical\nconfidence: high\ncreated: 2026-03-01\nupdated: 2026-03-01\ntags: [x]\n---\n\n${n.body}\n`,
    );
  }
  mkdirSync(join(dir, ".daftari"), { recursive: true });
  writeFileSync(
    join(dir, ".daftari", "config.yaml"),
    `version: 1
roles:
  analyst:
    read: [public]
    write: []
  admin:
    read: ["*"]
    write: ["*"]
server:
  auth:
    tokens:
      - env: DAFTARI_OAUTH_TEST_STATIC
        user: agent:etl
        role: admin
    oauth:
      issuer: ${ISSUER}
      audience: ${AUDIENCE}
      jwks_uri: ${jwksUri}
      subjects:
        "alice@example.com":
          user: human:alice
          role: analyst
`,
  );
  return dir;
}

describe("serve OAuth resource-server auth (#7)", () => {
  let vault: string;
  let handle: ServeHandle;
  let jwksServer: Server;
  let privateKey: CryptoKey;

  async function signJwt(
    sub: string,
    overrides: { issuer?: string; audience?: string; expiresIn?: string } = {},
  ): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer(overrides.issuer ?? ISSUER)
      .setAudience(overrides.audience ?? AUDIENCE)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresIn ?? "5m")
      .sign(privateKey);
  }

  async function connect(token?: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
      { requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : {} },
    );
    const client = new Client({ name: "oauth-test", version: "0.0.0" });
    await client.connect(transport);
    return client;
  }

  async function searchPaths(client: Client): Promise<string[]> {
    const res = (await client.callTool({
      name: "vault_search",
      arguments: { query: "zephyr", limit: 10, weights: { bm25: 1, vector: 0 } },
    })) as { content: { type: string; text: string }[] };
    const parsed = JSON.parse(res.content[0]?.text ?? "{}") as { hits?: { path: string }[] };
    return (parsed.hits ?? []).map((h) => h.path);
  }

  beforeAll(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey as CryptoKey;
    const jwk = await exportJWK(pair.publicKey);
    jwk.alg = "RS256";
    jwk.use = "sig";

    // The fake IdP: serves the JWKS on an ephemeral loopback port.
    const jwksPort = await new Promise<number>((resolvePort) => {
      jwksServer = createHttpServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ keys: [jwk] }));
      });
      jwksServer.listen(0, "127.0.0.1", () => {
        const addr = jwksServer.address();
        resolvePort(typeof addr === "object" && addr !== null ? addr.port : 0);
      });
    });

    process.env.DAFTARI_OAUTH_TEST_STATIC = "static-etl-secret";
    vault = buildVault(`http://127.0.0.1:${jwksPort}/jwks.json`);
    const reindexed = await vaultReindex(vault);
    if (!reindexed.ok) throw reindexed.error;
    const cfg = loadConfig(vault);
    if (!cfg.ok) throw cfg.error;
    const gate = validateServeStartup(cfg.value, "127.0.0.1", process.env);
    if (!gate.ok) throw new Error(gate.error);
    handle = await startHttpServer(vault, cfg.value, gate.tokens, "127.0.0.1", 0);
  }, 60_000);

  afterAll(async () => {
    await handle.close();
    await new Promise<void>((r) => jwksServer.close(() => r()));
    rmSync(vault, { recursive: true, force: true });
  });

  it("a valid JWT for a mapped subject opens a session with that role's vantage", async () => {
    const client = await connect(await signJwt("alice@example.com"));
    try {
      const paths = await searchPaths(client);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((p) => p === "notes/p1.md")).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);

  it("a valid JWT with an UNMAPPED subject is 403 — never guest, never a default role", async () => {
    await expect(connect(await signJwt("mallory@example.com"))).rejects.toThrow(/forbidden/);
  });

  it("wrong audience, wrong issuer, and expired tokens are 401", async () => {
    await expect(
      connect(await signJwt("alice@example.com", { audience: "someone-else" })),
    ).rejects.toThrow(/unauthorized/);
    await expect(
      connect(await signJwt("alice@example.com", { issuer: "https://evil.example" })),
    ).rejects.toThrow(/unauthorized/);
    await expect(connect(await signJwt("alice@example.com", { expiresIn: "-5m" }))).rejects.toThrow(
      /unauthorized/,
    );
  });

  it("static tokens keep working alongside OAuth (the composed deployment)", async () => {
    const client = await connect("static-etl-secret");
    try {
      const paths = await searchPaths(client);
      expect(paths).toContain("notes/s1.md");
    } finally {
      await client.close();
    }
  }, 30_000);

  it("startup refuses an OAuth subject mapped to an undeclared role or a bad URL", () => {
    const cfg = loadConfig(vault);
    if (!cfg.ok) throw cfg.error;
    const base = cfg.value;

    const badRole: DaftariConfig = {
      ...base,
      server: {
        ...base.server,
        tokens: [],
        oauth: {
          issuer: ISSUER,
          audience: AUDIENCE,
          jwksUri: "http://127.0.0.1:1/jwks.json",
          subjects: { "x@example.com": { user: "human:x", role: "ghost" } },
        },
      },
    };
    const r = validateServeStartup(badRole, "127.0.0.1", process.env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("role 'ghost'");

    const badUrl: DaftariConfig = {
      ...base,
      server: {
        ...base.server,
        tokens: [],
        oauth: {
          issuer: "not a url",
          audience: AUDIENCE,
          jwksUri: "http://127.0.0.1:1/jwks.json",
          subjects: {},
        },
      },
    };
    const r2 = validateServeStartup(badUrl, "127.0.0.1", process.env);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error).toContain("not a valid URL");

    // Plain http to a NON-loopback IdP is a MITM vector: a network-position
    // attacker could serve a forged JWKS and mint arbitrary authorized
    // sessions. Loopback http (the fake IdP above) is the sole escape hatch.
    const httpIdp: DaftariConfig = {
      ...base,
      server: {
        ...base.server,
        tokens: [],
        oauth: {
          issuer: ISSUER,
          audience: AUDIENCE,
          jwksUri: "http://idp.example/jwks.json",
          subjects: {},
        },
      },
    };
    const r3 = validateServeStartup(httpIdp, "127.0.0.1", process.env);
    expect(r3.ok).toBe(false);
    if (r3.ok) return;
    expect(r3.error).toContain("must use https");
  });

  it("oauth alone counts as auth configured: no token is 401, not guest", async () => {
    await expect(connect()).rejects.toThrow(/unauthorized/);
  });
});
