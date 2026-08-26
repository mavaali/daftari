// board-login.test.ts — U4-U7: browser-login shim end to end (bead 7q9).
//
// Exercises the real handle()→authenticate()→route stack with a
// server.auth.session block configured, plus a static token so the bearer
// path's CSRF-exemption and regression are covered in the same server.
//
// Coverage:
//   U6  — GET /board no cred + Accept:text/html → 302 /board/login;
//         + Accept:application/json → 401 JSON (curl path unchanged).
//   U5  — GET /board/login → HTML form; POST wrong pw → 401; POST correct pw
//         → 302 /board with HttpOnly SameSite=Strict session cookie + a
//         readable CSRF cookie (no Secure on loopback).
//   U4  — GET /board and GET /api/board WITH the session cookie → 200.
//         Tampered session cookie → not honored (redirect/401, no downgrade).
//   U7  — cookie-authed POST /api/board/dispose without X-CSRF-Token → 403;
//         with the matching token → passes CSRF (400 input error, not 403).
//         Bearer-authed dispose with no CSRF token → exempt (400, not 403).
//   U5  — POST /board/logout with CSRF → 302 + cleared cookies; without → 403.
//   Guard — /board/login 404s when no session block is configured.
//
// Run with: npx vitest run test/serve/board-login.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ServeHandle, startHttpServer, validateServeStartup } from "../../src/serve/index.js";
import { type DaftariConfig, loadConfig } from "../../src/utils/config.js";

const SIGNING_KEY = "0123456789abcdef0123456789abcdef"; // 32 bytes
const PASSWORD = "correct-horse-battery-staple";
const AGENT_TOKEN = "agent-machine-token-xyz";

function buildSessionVault(withSession: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-board-login-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  writeFileSync(
    join(dir, "notes", "orphan.md"),
    [
      "---",
      "title: Orphan Note",
      "collection: notes",
      "domain: accumulation",
      "status: canonical",
      "confidence: medium",
      "created: 2020-01-01",
      "updated: 2020-01-01",
      "updated_by: agent:seed",
      "provenance: direct",
      "sources: []",
      "superseded_by: null",
      "ttl_days: null",
      "---",
      "",
      "No one links here.",
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, ".daftari"), { recursive: true });
  const serverSection = withSession
    ? `server:
  auth:
    tokens:
      - env: BOARD_LOGIN_AGENT_TOKEN
        user: agent:machine
        role: admin
    session:
      signing_key_env: BOARD_LOGIN_SIGNING_KEY
      credential_env: BOARD_LOGIN_PASSWORD
      maps_to: { user: human:mihir, role: admin }
      lifetime_hours: 12
`
    : "";
  writeFileSync(
    join(dir, ".daftari", "config.yaml"),
    `version: 1
vault_name: board-login-test
roles:
  admin:
    read: ["*"]
    write: ["*"]
    dispose: true
    promote: false
    ratify: false
${serverSection}principals:
  - "human:mihir"
  - "agent:machine"
`,
  );
  return dir;
}

function loadedConfig(vault: string): DaftariConfig {
  const c = loadConfig(vault);
  if (!c.ok) throw c.error;
  return c.value;
}

function u(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

// Extract a cookie's value from a response's Set-Cookie list.
function cookieValue(setCookies: string[], name: string): string | undefined {
  for (const c of setCookies) {
    const m = new RegExp(`^${name}=([^;]*)`).exec(c);
    if (m) return m[1];
  }
  return undefined;
}

function cookieAttrs(setCookies: string[], name: string): string {
  return setCookies.find((c) => c.startsWith(`${name}=`)) ?? "";
}

describe("board login shim — session configured", () => {
  let vault: string;
  let handle: ServeHandle;

  beforeAll(async () => {
    vault = buildSessionVault(true);
    process.env.BOARD_LOGIN_SIGNING_KEY = SIGNING_KEY;
    process.env.BOARD_LOGIN_PASSWORD = PASSWORD;
    process.env.BOARD_LOGIN_AGENT_TOKEN = AGENT_TOKEN;
    const cfg = loadedConfig(vault);
    const gate = validateServeStartup(cfg, "127.0.0.1", process.env);
    if (!gate.ok) throw new Error(gate.error);
    handle = await startHttpServer(vault, cfg, gate.tokens, "127.0.0.1", 0, {
      session: gate.session,
    });
  }, 30_000);

  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true });
    delete process.env.BOARD_LOGIN_SIGNING_KEY;
    delete process.env.BOARD_LOGIN_PASSWORD;
    delete process.env.BOARD_LOGIN_AGENT_TOKEN;
  });

  // Log in and return the session + csrf cookie values.
  async function login(): Promise<{ session: string; csrf: string; cookieHeader: string }> {
    const res = await fetch(u(handle.port, "/board/login"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: PASSWORD }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    const setCookies = res.headers.getSetCookie();
    const session = cookieValue(setCookies, "daftari_session");
    const csrf = cookieValue(setCookies, "daftari_csrf");
    if (!session || !csrf) throw new Error("login did not set cookies");
    return {
      session,
      csrf,
      cookieHeader: `daftari_session=${session}; daftari_csrf=${csrf}`,
    };
  }

  it("U6: GET /board with no cred + Accept html → 302 to /board/login", async () => {
    const res = await fetch(u(handle.port, "/board"), {
      headers: { accept: "text/html" },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/board/login");
  });

  it("U6: GET /board with no cred + Accept json → 401 (curl path unchanged)", async () => {
    const res = await fetch(u(handle.port, "/board"), {
      headers: { accept: "application/json" },
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });

  it("U5: GET /board/login → 200 HTML with a password field", async () => {
    const res = await fetch(u(handle.port, "/board/login"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('name="password"');
    expect(body).toContain("Vault Board");
  });

  it("bdd: GET /board/login → carries a username field (configured user) for autofill", async () => {
    const res = await fetch(u(handle.port, "/board/login"));
    expect(res.status).toBe(200);
    const body = await res.text();
    // Password managers need a username field paired with the password input to
    // offer save/autofill; a lone password box is skipped. The user is fixed by
    // config (maps_to.user), so it is prefilled + readonly.
    expect(body).toContain('name="username"');
    expect(body).toContain('autocomplete="username"');
    expect(body).toContain('value="human:mihir"');
    // Must appear before the password field so the pair is recognized in order.
    expect(body.indexOf('name="username"')).toBeLessThan(body.indexOf('name="password"'));
  });

  it("bdd: wrong-password re-render also carries the username field", async () => {
    const res = await fetch(u(handle.port, "/board/login"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "nope" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain('name="username"');
    expect(body).toContain('value="human:mihir"');
  });

  it("U5: POST /board/login with wrong password → 401", async () => {
    const res = await fetch(u(handle.port, "/board/login"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "wrong" }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });

  it("U5: POST /board/login correct → 302 /board with hardened cookies", async () => {
    const res = await fetch(u(handle.port, "/board/login"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: PASSWORD }).toString(),
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/board");
    const setCookies = res.headers.getSetCookie();
    const sessionAttrs = cookieAttrs(setCookies, "daftari_session");
    expect(sessionAttrs).toContain("HttpOnly");
    expect(sessionAttrs).toContain("SameSite=Strict");
    expect(sessionAttrs).not.toContain("Secure"); // loopback → no Secure
    const csrfAttrs = cookieAttrs(setCookies, "daftari_csrf");
    expect(csrfAttrs).not.toContain("HttpOnly"); // page must read it
    expect(csrfAttrs).toContain("SameSite=Strict");
  });

  it("U4: GET /board and /api/board with the session cookie → 200", async () => {
    const { cookieHeader } = await login();
    const htmlRes = await fetch(u(handle.port, "/board"), {
      headers: { accept: "text/html", cookie: cookieHeader },
    });
    expect(htmlRes.status).toBe(200);
    expect(await htmlRes.text()).toContain("Vault Board");

    const jsonRes = await fetch(u(handle.port, "/api/board"), {
      headers: { accept: "application/json", cookie: cookieHeader },
    });
    expect(jsonRes.status).toBe(200);
    const body = (await jsonRes.json()) as Record<string, unknown>;
    expect(body).toHaveProperty("columns");
  });

  it("U4: a tampered session cookie is not honored (redirect, no downgrade)", async () => {
    const { session } = await login();
    const tampered = `${session.slice(0, -3)}xyz`;
    const res = await fetch(u(handle.port, "/board"), {
      headers: { accept: "text/html", cookie: `daftari_session=${tampered}` },
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/board/login");
  });

  it("U7: cookie-authed dispose without CSRF token → 403", async () => {
    const { cookieHeader } = await login();
    const res = await fetch(u(handle.port, "/api/board/dispose"), {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ finding_id: "whatever", event: "accept" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { message?: string };
    expect(body.message).toMatch(/CSRF/i);
  });

  it("U7: cookie-authed dispose WITH matching CSRF token passes CSRF (400 input error)", async () => {
    const { cookieHeader, csrf } = await login();
    const res = await fetch(u(handle.port, "/api/board/dispose"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader,
        "x-csrf-token": csrf,
      },
      body: JSON.stringify({ finding_id: "", event: "" }),
    });
    // CSRF passed → falls through to input validation, not a 403 CSRF reject.
    expect(res.status).toBe(400);
  });

  it("U7: bearer-authed dispose with no CSRF token is exempt (400 input error)", async () => {
    const res = await fetch(u(handle.port, "/api/board/dispose"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${AGENT_TOKEN}`,
      },
      body: JSON.stringify({ finding_id: "", event: "" }),
    });
    expect(res.status).toBe(400); // exempt from CSRF → input validation
  });

  it("U5: logout with CSRF clears cookies; without CSRF → 403", async () => {
    const { cookieHeader, csrf } = await login();
    const noCsrf = await fetch(u(handle.port, "/board/logout"), {
      method: "POST",
      headers: { cookie: cookieHeader },
      redirect: "manual",
    });
    expect(noCsrf.status).toBe(403);

    const withCsrf = await fetch(u(handle.port, "/board/logout"), {
      method: "POST",
      headers: { cookie: cookieHeader, "x-csrf-token": csrf },
      redirect: "manual",
    });
    expect(withCsrf.status).toBe(302);
    expect(withCsrf.headers.get("location")).toBe("/board/login");
    const cleared = cookieAttrs(withCsrf.headers.getSetCookie(), "daftari_session");
    expect(cleared).toContain("Max-Age=0");
  });
});

describe("board login shim — no session configured", () => {
  let vault: string;
  let handle: ServeHandle;

  beforeAll(async () => {
    vault = buildSessionVault(false);
    const cfg = loadedConfig(vault);
    const gate = validateServeStartup(cfg, "127.0.0.1", process.env);
    if (!gate.ok) throw new Error(gate.error);
    handle = await startHttpServer(vault, cfg, gate.tokens, "127.0.0.1", 0, {
      session: gate.session,
    });
  }, 30_000);

  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("GET /board/login → 404 when no session block is configured", async () => {
    const res = await fetch(u(handle.port, "/board/login"), { redirect: "manual" });
    expect(res.status).toBe(404);
  });
});
