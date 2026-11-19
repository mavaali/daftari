// OAuth 2.1 discovery for `daftari serve`: RFC 9728 protected-resource
// metadata plus the RFC 6750 `WWW-Authenticate` challenge on 401, so remote
// MCP clients (ChatGPT, claude.ai/Desktop/mobile/Cowork, Claude Code) can
// find the authorization server. Fully offline, same shape as oauth.test.ts:
// an in-test JWKS server plays the IdP and test JWTs are signed locally.
//
// The fixture deliberately uses a PREFIXED public_base_url and OMITS
// `audience`, so it also pins the two config consequences: the well-known
// path carries the prefix, `/<prefix>/mcp` reaches auth, and `aud` defaults
// to the resource URL.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { challengeHeader, discoveryEndpoints } from "../../src/serve/discovery.js";
import { type ServeHandle, startHttpServer, validateServeStartup } from "../../src/serve/index.js";
import { vaultReindex } from "../../src/tools/search.js";
import { type DaftariConfig, loadConfig } from "../../src/utils/config.js";

const ISSUER = "https://idp.test.example";
const PUBLIC_BASE = "https://vault.test.example/daftari";
const RESOURCE = `${PUBLIC_BASE}/mcp`;
const WELL_KNOWN_ROOT = "/.well-known/oauth-protected-resource";
const WELL_KNOWN_PATH = `${WELL_KNOWN_ROOT}/daftari/mcp`;
const METADATA_URL = `https://vault.test.example${WELL_KNOWN_PATH}`;

const EXPECTED_DOCUMENT = {
  resource: RESOURCE,
  authorization_servers: [ISSUER],
  bearer_methods_supported: ["header"],
};

function buildVault(jwksUri: string, extraServer = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-discovery-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(
    join(dir, "notes", "p1.md"),
    "---\ntitle: p1\ncollection: public\ndomain: accumulation\nstatus: canonical\nconfidence: high\ncreated: 2026-03-01\nupdated: 2026-03-01\ntags: [x]\n---\n\nzephyr overview note\n",
  );
  mkdirSync(join(dir, ".daftari"), { recursive: true });
  writeFileSync(
    join(dir, ".daftari", "config.yaml"),
    `version: 1
roles:
  analyst:
    read: [public]
    write: []
server:
  public_base_url: ${PUBLIC_BASE}
${extraServer}  auth:
    oauth:
      issuer: ${ISSUER}
      jwks_uri: ${jwksUri}
      subjects:
        "alice@example.com":
          user: human:alice
          role: analyst
`,
  );
  return dir;
}

// One running serve + fake IdP per describe block, so the auth-failure
// penalty box charged by one case never leaks into another.
interface Fixture {
  origin: string;
  handle: ServeHandle;
  signJwt: (sub: string, audience: string) => Promise<string>;
  close: () => Promise<void>;
}

async function startFixture(extraServer = ""): Promise<Fixture> {
  const pair = await generateKeyPair("RS256");
  const privateKey = pair.privateKey as CryptoKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.alg = "RS256";
  jwk.use = "sig";
  let jwksServer: Server | undefined;
  const jwksPort = await new Promise<number>((resolvePort) => {
    jwksServer = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    jwksServer.listen(0, "127.0.0.1", () => {
      const addr = jwksServer?.address();
      resolvePort(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
  const vault = buildVault(`http://127.0.0.1:${jwksPort}/jwks.json`, extraServer);
  const reindexed = await vaultReindex(vault);
  if (!reindexed.ok) throw reindexed.error;
  const cfg = loadConfig(vault);
  if (!cfg.ok) throw cfg.error;
  const gate = validateServeStartup(cfg.value, "127.0.0.1", process.env);
  if (!gate.ok) throw new Error(gate.error);
  const handle = await startHttpServer(vault, cfg.value, gate.tokens, "127.0.0.1", 0);
  return {
    origin: `http://127.0.0.1:${handle.port}`,
    handle,
    signJwt: (sub, audience) =>
      new SignJWT({})
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(ISSUER)
        .setAudience(audience)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey),
    close: async () => {
      await handle.close();
      await new Promise<void>((r) => jwksServer?.close(() => r()));
      rmSync(vault, { recursive: true, force: true });
    },
  };
}

describe("discoveryEndpoints (pure)", () => {
  const base = (server: Record<string, unknown>) =>
    ({ tokens: [], trustedProxies: [], ...server }) as unknown as DaftariConfig["server"];
  const oauth = { issuer: ISSUER, jwksUri: `${ISSUER}/jwks`, subjects: {} };

  it("is null without oauth, and null without a public base URL", () => {
    expect(discoveryEndpoints(base({ publicBaseUrl: PUBLIC_BASE }))).toBeNull();
    expect(discoveryEndpoints(base({ oauth }))).toBeNull();
  });

  it("derives the resource, both well-known paths, and both MCP paths from a prefixed base", () => {
    const d = discoveryEndpoints(base({ oauth, publicBaseUrl: PUBLIC_BASE }));
    expect(d).not.toBeNull();
    expect(d?.resource).toBe(RESOURCE);
    expect(d?.metadataUrl).toBe(METADATA_URL);
    expect(d?.wellKnownPaths).toEqual([WELL_KNOWN_ROOT, WELL_KNOWN_PATH]);
    expect(d?.mcpPaths).toEqual(["/mcp", "/daftari/mcp"]);
    expect(d?.document).toEqual(EXPECTED_DOCUMENT);
  });

  it("collapses to single paths at a root base URL", () => {
    const d = discoveryEndpoints(base({ oauth, publicBaseUrl: "https://vault.test.example" }));
    expect(d?.resource).toBe("https://vault.test.example/mcp");
    expect(d?.wellKnownPaths).toEqual([WELL_KNOWN_ROOT, `${WELL_KNOWN_ROOT}/mcp`]);
    expect(d?.mcpPaths).toEqual(["/mcp"]);
  });

  it("builds the RFC 6750 challenge, adding invalid_token only when a bearer was presented", () => {
    expect(challengeHeader(METADATA_URL, false)).toBe(`Bearer resource_metadata="${METADATA_URL}"`);
    expect(challengeHeader(METADATA_URL, true)).toBe(
      `Bearer resource_metadata="${METADATA_URL}", error="invalid_token"`,
    );
  });
});

describe("serve OAuth discovery (RFC 9728 + RFC 6750 challenge)", () => {
  let f: Fixture;

  async function connect(path: string, token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${f.origin}${path}`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client(
      { name: "discovery-test", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: "2026-07-28" } } },
    );
    await client.connect(transport);
    return client;
  }

  beforeAll(async () => {
    f = await startFixture();
  }, 60_000);

  afterAll(async () => {
    await f.close();
  });

  it("serves the metadata document at the path-aware well-known URL", async () => {
    const res = await fetch(`${f.origin}${WELL_KNOWN_PATH}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(EXPECTED_DOCUMENT);
  });

  it("serves the identical document at the root well-known URL (Claude's fallback probe)", async () => {
    const res = await fetch(`${f.origin}${WELL_KNOWN_ROOT}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(EXPECTED_DOCUMENT);
  });

  it("answers HEAD with headers only and other methods with 405", async () => {
    const head = await fetch(`${f.origin}${WELL_KNOWN_PATH}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-type")).toBe("application/json");
    expect(await head.text()).toBe("");
    for (const method of ["POST", "PUT", "DELETE"]) {
      const res = await fetch(`${f.origin}${WELL_KNOWN_PATH}`, { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  it("matches the well-known paths exactly — near misses are 404", async () => {
    for (const path of [
      `${WELL_KNOWN_ROOT}/other`,
      `${WELL_KNOWN_PATH}/`,
      `${WELL_KNOWN_ROOT}/daftari`,
    ]) {
      const res = await fetch(`${f.origin}${path}`);
      expect(res.status, path).toBe(404);
    }
  });

  it("a 401 on /mcp carries the resource_metadata challenge, with invalid_token when a bearer was sent", async () => {
    const bare = await fetch(`${f.origin}/mcp`, { method: "POST", body: "{}" });
    expect(bare.status).toBe(401);
    expect(bare.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA_URL}"`);

    const garbage = await fetch(`${f.origin}/mcp`, {
      method: "POST",
      body: "{}",
      headers: { Authorization: "Bearer not-a-jwt" },
    });
    expect(garbage.status).toBe(401);
    expect(garbage.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${METADATA_URL}", error="invalid_token"`,
    );
  });

  it("a 403 for an authenticated-but-unmapped subject carries NO challenge", async () => {
    const token = await f.signJwt("mallory@example.com", RESOURCE);
    const res = await fetch(`${f.origin}/mcp`, {
      method: "POST",
      body: "{}",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("the board API 401 carries the same challenge (one writer for every Bearer 401)", async () => {
    const res = await fetch(`${f.origin}/api/board`);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${METADATA_URL}"`);
  });

  it("audience defaults to the resource URL: aud=resource is accepted on both MCP paths", async () => {
    const token = await f.signJwt("alice@example.com", RESOURCE);
    for (const path of ["/mcp", "/daftari/mcp"]) {
      const client = await connect(path, token);
      const res = (await client.callTool({
        name: "vault_search",
        arguments: { query: "zephyr", limit: 10, weights: { bm25: 1, vector: 0 } },
      })) as { structuredContent?: { hits?: { path: string }[] } };
      expect(
        (res.structuredContent?.hits ?? []).map((h) => h.path),
        path,
      ).toEqual(["notes/p1.md"]);
      await client.close();
    }
  });

  it("a token minted for some other audience is 401", async () => {
    const token = await f.signJwt("alice@example.com", "daftari-test");
    const res = await fetch(`${f.origin}/mcp`, {
      method: "POST",
      body: "{}",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("discovery is outside the auth-failure penalty box", () => {
  let f: Fixture;

  beforeAll(async () => {
    // A tight burst so two bad requests trip the box.
    f = await startFixture(
      "  limits:\n    auth_failure_burst: 2\n    auth_failures_per_minute: 1\n",
    );
  }, 60_000);

  afterAll(async () => {
    await f.close();
  });

  it("stays reachable while the caller is being rate-limited for bad credentials", async () => {
    let last = 0;
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${f.origin}/mcp`, {
        method: "POST",
        body: "{}",
        headers: { Authorization: "Bearer still-not-a-jwt" },
      });
      last = res.status;
    }
    expect(last).toBe(429);
    const meta = await fetch(`${f.origin}${WELL_KNOWN_PATH}`);
    expect(meta.status).toBe(200);
    expect(await meta.json()).toEqual(EXPECTED_DOCUMENT);
  });
});

describe("startup gate: audience default needs a resource to default to", () => {
  function configWith(server: string): DaftariConfig {
    const dir = mkdtempSync(join(tmpdir(), "daftari-discovery-gate-"));
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(
      join(dir, ".daftari", "config.yaml"),
      `version: 1\nroles:\n  analyst:\n    read: [public]\n    write: []\nserver:\n${server}`,
    );
    const cfg = loadConfig(dir);
    rmSync(dir, { recursive: true, force: true });
    if (!cfg.ok) throw cfg.error;
    return cfg.value;
  }
  const oauthBlock = (audienceLine: string) =>
    `  auth:\n    oauth:\n      issuer: ${ISSUER}\n${audienceLine}      jwks_uri: ${ISSUER}/jwks.json\n      subjects:\n        "a@example.com":\n          user: human:a\n          role: analyst\n`;

  it("refuses oauth with neither audience nor public_base_url", () => {
    const gate = validateServeStartup(configWith(oauthBlock("")), "127.0.0.1", {});
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.error).toMatch(/audience/);
  });

  it("accepts an omitted audience when public_base_url supplies the resource", () => {
    const gate = validateServeStartup(
      configWith(`  public_base_url: ${PUBLIC_BASE}\n${oauthBlock("")}`),
      "127.0.0.1",
      {},
    );
    expect(gate.ok).toBe(true);
  });

  it("still accepts an explicit audience without public_base_url (today's deployments)", () => {
    const gate = validateServeStartup(
      configWith(oauthBlock("      audience: daftari\n")),
      "127.0.0.1",
      {},
    );
    expect(gate.ok).toBe(true);
  });
});
