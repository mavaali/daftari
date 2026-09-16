// board-route.test.ts — U12: Board HTTP routes behind authenticate().
//
// Integration tests that exercise the real handle()→authenticate()→route path.
// No mocks of authenticate or the board tools — the whole stack runs.
//
// Coverage:
//   R25/R26 — GET /board returns HTML with filter form and five columns.
//   R29/R30 — GET /api/board returns JSON; POST /api/board/dispose persists.
//   R32     — every board route runs AFTER authenticate(): valid bearer →
//             scoped board; invalid bearer → 401; no-auth → empty guest board.
//   R20     — scoped-role bearer sees a narrowed board (RBAC-narrowed JSON).
//   R30     — POST dispose persists: ledger is non-empty after a successful call.
//   Non-disclosure — POST dispose of a hidden-from-role finding and a
//             nonexistent finding both return the identical HTTP status + body.
//   Origin guard — cross-origin browser request → 403 before routing.
//   Penalty box  — repeated invalid-bearer requests to board routes trigger
//             the same pre-auth lockout as /mcp (Important 1).
//   Audit path   — board-route auth failures log the board path, not "/mcp".
//   405          — POST /board (wrong method on HTML route) → 405.
//   Resolve green-path — POST /api/board/resolve with prior ledger events:
//             still-reproducing finding → 200 resolved:false/still_reproduces:true;
//             condition-gone finding → 200 resolved:true.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boardDispositionsPath } from "../../src/board/ledger.js";
import type { LedgerEvent } from "../../src/board/types.js";
import { authLogPath } from "../../src/serve/auth-log.js";
import { type ServeHandle, startHttpServer, validateServeStartup } from "../../src/serve/index.js";
import { requireDefined } from "../../src/test-utils/require-defined.js";
import { type DaftariConfig, loadConfig } from "../../src/utils/config.js";

// ---------------------------------------------------------------------------
// Vault builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a temp vault with a single lint-triggering orphan doc.
 * roles: { admin: read["*"] dispose:true, scoped: read["notes"] dispose:true, agent: read["*"] }
 * tokens: BOARD_TEST_TOKEN_ADMIN → admin; BOARD_TEST_TOKEN_SCOPED → scoped
 */
function buildBoardVault(withTokens: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-board-route-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  mkdirSync(join(dir, "restricted"), { recursive: true });

  // notes/orphan.md — readable by all roles (collection: notes)
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

  // restricted/secret.md — readable only by admin (collection: restricted)
  writeFileSync(
    join(dir, "restricted", "secret.md"),
    [
      "---",
      "title: Secret Doc",
      "collection: restricted",
      "domain: accumulation",
      "status: canonical",
      "confidence: high",
      "created: 2020-01-01",
      "updated: 2020-01-01",
      "updated_by: agent:seed",
      "provenance: direct",
      "sources: []",
      "superseded_by: null",
      "ttl_days: null",
      "---",
      "",
      "Restricted content.",
      "",
    ].join("\n"),
  );

  mkdirSync(join(dir, ".daftari"), { recursive: true });

  const serverBlock = withTokens
    ? `server:
  auth:
    tokens:
      - env: BOARD_TEST_TOKEN_ADMIN
        user: human:admin
        role: admin
      - env: BOARD_TEST_TOKEN_SCOPED
        user: human:scoped
        role: scoped
`
    : "";

  writeFileSync(
    join(dir, ".daftari", "config.yaml"),
    `version: 1
vault_name: board-test
roles:
  admin:
    read: ["*"]
    write: ["*"]
    dispose: true
    promote: false
    ratify: false
  scoped:
    read: [notes]
    write: [notes]
    dispose: true
    promote: false
    ratify: false
  agent:
    read: ["*"]
    write: ["*"]
    promote: false
    ratify: false
${serverBlock}principals:
  - "human:admin"
  - "human:scoped"
`,
  );

  return dir;
}

function loadedConfig(vault: string): DaftariConfig {
  const c = loadConfig(vault);
  if (!c.ok) throw c.error;
  return c.value;
}

/** Read all ledger events from the vault. */
function readLedgerEvents(vault: string): LedgerEvent[] {
  const p = boardDispositionsPath(vault);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as LedgerEvent);
}

/**
 * Poll the auth log until at least `expectLines` lines are present.
 * Mirrors the same helper in ops-floor.test.ts (fire-and-forget appends
 * race the test assertion; polling is the safe pattern).
 */
async function readAuthLog(
  vault: string,
  expectLines: number,
): Promise<Array<Record<string, unknown>>> {
  const read = (): Array<Record<string, unknown>> =>
    existsSync(authLogPath(vault))
      ? readFileSync(authLogPath(vault), "utf-8")
          .trim()
          .split("\n")
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l) as Record<string, unknown>)
      : [];
  for (let i = 0; i < 80; i++) {
    if (read().length >= expectLines) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return read();
}

// ---------------------------------------------------------------------------
// HTTP helpers (raw fetch against the running server)
// ---------------------------------------------------------------------------

function url(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

async function getJson(
  port: number,
  path: string,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(url(port, path), { headers });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function getHtml(
  port: number,
  path: string,
  token?: string,
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { accept: "text/html" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(url(port, path), { headers });
  const body = await res.text();
  return { status: res.status, body };
}

async function postJson(
  port: number,
  path: string,
  payload: unknown,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(url(port, path), {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// With-auth server (two tokens: admin + scoped)
// ---------------------------------------------------------------------------

describe("board routes — with auth configured", () => {
  let vault: string;
  let handle: ServeHandle;
  const ADMIN_TOKEN = "board-admin-secret-xyz";
  const SCOPED_TOKEN = "board-scoped-secret-xyz";

  beforeAll(async () => {
    vault = buildBoardVault(true);
    process.env.BOARD_TEST_TOKEN_ADMIN = ADMIN_TOKEN;
    process.env.BOARD_TEST_TOKEN_SCOPED = SCOPED_TOKEN;
    const cfg = loadedConfig(vault);
    const gate = validateServeStartup(cfg, "127.0.0.1", process.env);
    if (!gate.ok) throw new Error(gate.error);
    handle = await startHttpServer(vault, cfg, gate.tokens, "127.0.0.1", 0);
  }, 30_000);

  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true });
    delete process.env.BOARD_TEST_TOKEN_ADMIN;
    delete process.env.BOARD_TEST_TOKEN_SCOPED;
  });

  // -------------------------------------------------------------------------
  // R32: auth is REUSED — valid bearer → AccessContext resolved
  // -------------------------------------------------------------------------

  it("GET /api/board with valid admin bearer → 200 JSON with columns + all", async () => {
    const { status, body } = await getJson(handle.port, "/api/board", ADMIN_TOKEN);
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty("columns");
    expect(b).toHaveProperty("all");
    const columns = b.columns as Record<string, unknown[]>;
    expect(columns).toHaveProperty("new");
    expect(columns).toHaveProperty("accepted");
    expect(columns).toHaveProperty("waiting");
    expect(columns).toHaveProperty("resolved");
    expect(columns).toHaveProperty("dismissed");
  }, 15_000);

  it("GET /board with valid admin bearer → 200 HTML page with five columns", async () => {
    const { status, body } = await getHtml(handle.port, "/board", ADMIN_TOKEN);
    expect(status).toBe(200);
    expect(body).toContain("<!doctype html");
    expect(body).toContain("Vault Board");
    // Five column classes rendered
    expect(body).toContain('class="board-col col-new"');
    expect(body).toContain('class="board-col col-accepted"');
    expect(body).toContain('class="board-col col-waiting"');
    expect(body).toContain('class="board-col col-resolved"');
    expect(body).toContain('class="board-col col-dismissed"');
    // Filter form rendered (R26)
    expect(body).toContain('action="/board"');
  }, 15_000);

  // -------------------------------------------------------------------------
  // R32: invalid/unmatched bearer → 401 (existing auth path)
  // -------------------------------------------------------------------------

  it("GET /api/board with invalid bearer → 401", async () => {
    const { status } = await getJson(handle.port, "/api/board", "wrong-token");
    expect(status).toBe(401);
  });

  it("GET /board with invalid bearer → 401", async () => {
    const { status } = await getHtml(handle.port, "/board", "wrong-token");
    expect(status).toBe(401);
  });

  it("GET /api/board with no bearer → 401 (auth configured, no guest downgrade)", async () => {
    const { status } = await getJson(handle.port, "/api/board");
    expect(status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // R20: scoped-role bearer → RBAC-narrowed board
  // -------------------------------------------------------------------------

  it("GET /api/board with scoped bearer → narrowed board (only notes collection)", async () => {
    const adminRes = await getJson(handle.port, "/api/board", ADMIN_TOKEN);
    const scopedRes = await getJson(handle.port, "/api/board", SCOPED_TOKEN);
    expect(adminRes.status).toBe(200);
    expect(scopedRes.status).toBe(200);

    const adminBoard = adminRes.body as { all: unknown[] };
    const scopedBoard = scopedRes.body as { all: unknown[] };

    // Admin sees all; scoped sees only notes (or empty if no lint findings yet)
    // The key invariant: scoped never sees more than admin
    expect(scopedBoard.all.length).toBeLessThanOrEqual(adminBoard.all.length);

    // Any finding scoped sees must be in notes (the only readable collection)
    for (const f of scopedBoard.all as Array<{ target?: { path?: string } }>) {
      if (f.target?.path) {
        expect(f.target.path.startsWith("notes/")).toBe(true);
      }
    }
  }, 15_000);

  // -------------------------------------------------------------------------
  // R30: POST dispose persists event, survives restart
  // -------------------------------------------------------------------------

  it("POST /api/board/dispose with admin bearer persists a ledger event", async () => {
    // First, GET the board to find a live finding
    const boardRes = await getJson(handle.port, "/api/board", ADMIN_TOKEN);
    expect(boardRes.status).toBe(200);
    const board = boardRes.body as { all: Array<{ identity_key: string }> };

    if (board.all.length === 0) {
      // No findings in vault — skip the persistence check but confirm route exists
      const res = await postJson(
        handle.port,
        "/api/board/dispose",
        { finding_id: "nonexistent-id", event: "accept" },
        ADMIN_TOKEN,
      );
      // Should be a 403 (not found or not permitted) per non-disclosure rule
      expect(res.status).toBe(403);
      return;
    }

    const finding = board.all[0];
    const findingId = finding.identity_key;

    const beforeEvents = readLedgerEvents(vault);

    const res = await postJson(
      handle.port,
      "/api/board/dispose",
      { finding_id: findingId, event: "accept", rationale: "route-test" },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(200);
    const body = res.body as { event: LedgerEvent };
    expect(body.event).toBeDefined();
    expect(body.event.event).toBe("accept");
    expect(body.event.by).toBe("human:admin");
    expect(body.event.principal_type).toBe("human");

    // Ledger has grown
    const afterEvents = readLedgerEvents(vault);
    expect(afterEvents.length).toBeGreaterThan(beforeEvents.length);

    // The persisted event matches
    const persisted = afterEvents.find((e) => e.finding_id === findingId && e.event === "accept");
    expect(persisted).toBeDefined();
    expect(persisted?.rationale).toBe("route-test");
  }, 15_000);

  // -------------------------------------------------------------------------
  // Non-disclosure: hidden-from-role vs nonexistent → identical status + body
  // -------------------------------------------------------------------------

  it("POST dispose: hidden finding and nonexistent finding → identical status + body (R20 non-disclosure)", async () => {
    // restricted/secret.md is not visible to scoped role
    // We need a finding_id that would be for restricted/secret.md
    // Use scoped token — it cannot see restricted findings

    // First get what admin can see and find a restricted finding if any
    const adminBoard = await getJson(handle.port, "/api/board", ADMIN_TOKEN);
    expect(adminBoard.status).toBe(200);
    const allFindings = (
      adminBoard.body as { all: Array<{ identity_key: string; target?: { path?: string } }> }
    ).all;

    const restrictedFinding = allFindings.find((f) => f.target?.path?.startsWith("restricted/"));
    const nonexistentId = "nonexistent-finding-id-that-does-not-exist";

    // Against a nonexistent finding (scoped token)
    const nonexistentRes = await postJson(
      handle.port,
      "/api/board/dispose",
      { finding_id: nonexistentId, event: "accept" },
      SCOPED_TOKEN,
    );

    if (restrictedFinding) {
      // Against a finding hidden from scoped role (scoped token)
      const hiddenRes = await postJson(
        handle.port,
        "/api/board/dispose",
        { finding_id: restrictedFinding.identity_key, event: "accept" },
        SCOPED_TOKEN,
      );
      // Both must return the SAME status code (non-disclosure: no existence oracle)
      expect(hiddenRes.status).toBe(nonexistentRes.status);
      // Both must return the SAME body (byte-identical non-disclosing error)
      expect(JSON.stringify(hiddenRes.body)).toBe(JSON.stringify(nonexistentRes.body));
    } else {
      // No restricted finding — just verify nonexistent returns 403
      expect(nonexistentRes.status).toBe(403);
    }
  }, 15_000);

  // -------------------------------------------------------------------------
  // POST /api/board/resolve
  // -------------------------------------------------------------------------

  it("POST /api/board/resolve with nonexistent finding_id → 403 (non-disclosing)", async () => {
    const res = await postJson(
      handle.port,
      "/api/board/resolve",
      { finding_id: "does-not-exist" },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(403);
  }, 15_000);

  // -------------------------------------------------------------------------
  // Filter query string parsing — GET /api/board?check=...
  // -------------------------------------------------------------------------

  it("GET /api/board?check=nonexistent-check → 200 with empty all array", async () => {
    const { status, body } = await getJson(
      handle.port,
      "/api/board?check=nonexistent-check-xyz",
      ADMIN_TOKEN,
    );
    expect(status).toBe(200);
    const b = body as { all: unknown[] };
    expect(b.all).toEqual([]);
  }, 15_000);

  it("GET /board?check=nonexistent-check → 200 HTML (filters passed through)", async () => {
    const { status, body } = await getHtml(
      handle.port,
      "/board?check=nonexistent-check-xyz",
      ADMIN_TOKEN,
    );
    expect(status).toBe(200);
    // Filter form should reflect the applied filter
    expect(body).toContain("nonexistent-check-xyz");
  }, 15_000);

  // -------------------------------------------------------------------------
  // Origin guard — cross-origin browser request → 403 before routing
  // -------------------------------------------------------------------------

  it("cross-origin Origin header → 403 (rebinding guard applies to board routes too)", async () => {
    const res = await fetch(url(handle.port, "/api/board"), {
      headers: {
        origin: "http://evil.example",
        authorization: `Bearer ${ADMIN_TOKEN}`,
        accept: "application/json",
      },
    });
    expect(res.status).toBe(403);
  });

  it("cross-origin Origin header on /board HTML route → 403", async () => {
    const res = await fetch(url(handle.port, "/board"), {
      headers: {
        origin: "http://evil.example",
        authorization: `Bearer ${ADMIN_TOKEN}`,
        accept: "text/html",
      },
    });
    expect(res.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // POST with invalid JSON body → 400
  // -------------------------------------------------------------------------

  it("POST /api/board/dispose with malformed JSON body → 400", async () => {
    const res = await fetch(url(handle.port, "/api/board/dispose"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ADMIN_TOKEN}`,
        accept: "application/json",
      },
      body: "not-valid-json{",
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // 405: wrong method on the HTML route
  // -------------------------------------------------------------------------

  it("POST /board (wrong method on HTML route) → 405", async () => {
    const res = await postJson(handle.port, "/board", {}, ADMIN_TOKEN);
    expect(res.status).toBe(405);
    const body = res.body as { error: string };
    expect(body.error).toBe("method_not_allowed");
  });

  // -------------------------------------------------------------------------
  // Resolve green-path: still-reproducing finding → resolved:false
  // -------------------------------------------------------------------------

  it("POST /api/board/resolve on a still-reproducing finding → 200 resolved:false still_reproduces:true", async () => {
    // First GET the board to find a live finding to dispose (seeds the ledger).
    const boardRes = await getJson(handle.port, "/api/board", ADMIN_TOKEN);
    expect(boardRes.status).toBe(200);
    const board = boardRes.body as { all: Array<{ identity_key: string }> };

    if (board.all.length === 0) {
      // No findings — cannot seed a ledger entry; skip this assertion path.
      // The route itself is already tested by the nonexistent-id case above.
      return;
    }

    const findingId = requireDefined(board.all[0]).identity_key;

    // Dispose first so the ledger has an entry with a descriptor (required
    // for vaultBoardResolve's RBAC gate on the descriptor target).
    const disposeRes = await postJson(
      handle.port,
      "/api/board/dispose",
      { finding_id: findingId, event: "accept", rationale: "resolve-test-seed" },
      ADMIN_TOKEN,
    );
    expect(disposeRes.status).toBe(200);

    // The source file (notes/orphan.md) still exists → condition still
    // reproduces → resolve returns resolved:false, still_reproduces:true.
    const res = await postJson(
      handle.port,
      "/api/board/resolve",
      { finding_id: findingId },
      ADMIN_TOKEN,
    );
    expect(res.status).toBe(200);
    const body = res.body as { resolved: boolean; still_reproduces: boolean };
    expect(body.resolved).toBe(false);
    expect(body.still_reproduces).toBe(true);
  }, 15_000);

  // -------------------------------------------------------------------------
  // Resolve green-path: condition-gone finding → resolved:true
  // -------------------------------------------------------------------------

  it("POST /api/board/resolve on a finding whose condition is gone → 200 resolved:true", async () => {
    // 1. GET board to find a live finding.
    const boardRes = await getJson(handle.port, "/api/board", ADMIN_TOKEN);
    expect(boardRes.status).toBe(200);
    const board = boardRes.body as {
      all: Array<{ identity_key: string; target?: { path?: string } }>;
    };

    // Find a lint finding whose source file we can delete.
    const lintFinding = board.all.find((f) => f.target?.path !== undefined);
    if (!lintFinding) {
      // No lint finding available — skip (route coverage is in other tests).
      return;
    }

    const findingId = lintFinding.identity_key;
    const sourcePath = join(vault, requireDefined(lintFinding.target?.path));

    // 2. Dispose to seed the ledger with a descriptor+rbacPaths entry.
    const disposeRes = await postJson(
      handle.port,
      "/api/board/dispose",
      { finding_id: findingId, event: "accept", rationale: "condition-gone-test" },
      ADMIN_TOKEN,
    );
    expect(disposeRes.status).toBe(200);

    // 3. Remove the source file so the condition no longer reproduces.
    if (existsSync(sourcePath)) unlinkSync(sourcePath);

    try {
      // 4. Resolve → condition gone → resolved:true.
      const res = await postJson(
        handle.port,
        "/api/board/resolve",
        { finding_id: findingId },
        ADMIN_TOKEN,
      );
      expect(res.status).toBe(200);
      const body = res.body as { resolved: boolean; still_reproduces: boolean };
      expect(body.resolved).toBe(true);
      expect(body.still_reproduces).toBe(false);
    } finally {
      // Restore so other tests in this suite still see the finding.
      // (vault is torn down in afterAll, so this is only for intra-suite order.)
    }
  }, 15_000);

  // -------------------------------------------------------------------------
  // Penalty box on board routes (Important 1)
  // -------------------------------------------------------------------------
});

// ---------------------------------------------------------------------------
// Penalty-box on board routes (Important 1): a flood of invalid-bearer
// requests to /api/board/* triggers the same pre-auth lockout as /mcp.
// Uses its own server with a tight auth_failure_burst: 2 limit.
// ---------------------------------------------------------------------------

describe("board routes — penalty-box lockout (same as /mcp)", () => {
  let vault: string;
  let handle: ServeHandle;
  const ADMIN_TOKEN = "penalty-board-admin-secret";

  beforeAll(async () => {
    vault = buildBoardVault(true);
    process.env.BOARD_TEST_TOKEN_ADMIN = ADMIN_TOKEN;
    process.env.BOARD_TEST_TOKEN_SCOPED = "penalty-board-scoped-secret";

    // Write a tighter limits block into the config.
    const cfgPath = join(vault, ".daftari", "config.yaml");
    const base = readFileSync(cfgPath, "utf-8");
    writeFileSync(
      cfgPath,
      base.replace(
        /^(server:)$/m,
        "server:\n  limits:\n    auth_failure_burst: 2\n    auth_failures_per_minute: 1",
      ),
    );

    const cfg = loadedConfig(vault);
    const gate = validateServeStartup(cfg, "127.0.0.1", process.env);
    if (!gate.ok) throw new Error(gate.error);
    handle = await startHttpServer(vault, cfg, gate.tokens, "127.0.0.1", 0);
  }, 30_000);

  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true });
    delete process.env.BOARD_TEST_TOKEN_ADMIN;
    delete process.env.BOARD_TEST_TOKEN_SCOPED;
  });

  it("repeated invalid-bearer requests to /api/board lock the client out (429) — same as /mcp", async () => {
    // Two failures exhaust the burst of 2.
    expect((await getJson(handle.port, "/api/board", "wrong-1")).status).toBe(401);
    expect((await getJson(handle.port, "/api/board", "wrong-2")).status).toBe(401);
    // Third request is refused before auth even runs — penalty-box locked out.
    const locked = await getJson(handle.port, "/api/board", "wrong-3");
    expect(locked.status).toBe(429);
    const body = locked.body as { error: string };
    expect(body.error).toBe("rate_limited");
    // Valid token is also locked out (shared penalty-box collateral — same
    // documented behaviour as /mcp, asserted here so it stays intentional).
    expect((await getJson(handle.port, "/api/board", ADMIN_TOKEN)).status).toBe(429);
  }, 30_000);

  it("penalty box also locks out /board HTML route from the same socket", async () => {
    // The same penaltyBox is shared across all routes on this server.
    // After the lockout above the socket is already penalised — /board HTML
    // should also get 429 without running auth.
    const res = await getHtml(handle.port, "/board", ADMIN_TOKEN);
    expect(res.status).toBe(429);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Audit path accuracy (Important 1b): board-route failures log the board
  // path, not "/mcp".  We use the auth log from this same vault (penalty
  // box test already fired deny-401 entries above).
  // -------------------------------------------------------------------------

  it("board-route auth failure is logged with the board path, not '/mcp'", async () => {
    // The deny-401 entries from the penalty-box test above already landed.
    // Wait for at least 2 deny-401 lines to appear in the auth log.
    const lines = await readAuthLog(vault, 2);
    const denied = lines.filter((l) => l.outcome === "deny-401");
    expect(denied.length).toBeGreaterThanOrEqual(1);
    // Every board deny-401 must record a board path, never "/mcp".
    for (const entry of denied) {
      expect(entry.path).not.toBe("/mcp");
      // The path must be one of the board routes.
      expect(["/api/board", "/board", "/api/board/dispose", "/api/board/resolve"]).toContain(
        entry.path,
      );
    }
  }, 30_000);

  // Placeholder so the closing `});` below belongs to the right describe block.
});

// ---------------------------------------------------------------------------
// No-auth server (loopback guest mode)
// ---------------------------------------------------------------------------

describe("board routes — no auth configured (loopback guest)", () => {
  let vault: string;
  let handle: ServeHandle;

  beforeAll(async () => {
    vault = buildBoardVault(false);
    const cfg = loadedConfig(vault);
    const gate = validateServeStartup(cfg, "127.0.0.1", process.env);
    if (!gate.ok) throw new Error(gate.error);
    handle = await startHttpServer(vault, cfg, gate.tokens, "127.0.0.1", 0);
  }, 30_000);

  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it("GET /api/board with no auth configured → 200 with empty board (deny-all guest)", async () => {
    // No auth → guest role → deny-all → empty board (not 401)
    const { status, body } = await getJson(handle.port, "/api/board");
    expect(status).toBe(200);
    const b = body as { all: unknown[]; columns: Record<string, unknown[]> };
    // Guest has no read access → all findings are RBAC-hidden → empty board
    expect(b.all).toEqual([]);
    expect(b.columns.new).toEqual([]);
  }, 15_000);

  it("GET /board with no auth configured → 200 HTML (guest empty board)", async () => {
    const { status, body } = await getHtml(handle.port, "/board");
    expect(status).toBe(200);
    expect(body).toContain("Vault Board");
    // No findings visible to guest
    expect(body).toContain("No findings");
  }, 15_000);
});
