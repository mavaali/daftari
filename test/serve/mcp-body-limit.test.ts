// F3: the /mcp body must be bounded BEFORE the MCP adapter reads it. The
// adapter (toWebRequest) buffers the whole stream with `for await (const chunk
// of req)` and no ceiling, so a large or slow body pins memory / an in-flight
// slot. readBodyBounded enforces a byte cap (declared Content-Length AND the
// streamed total) plus an absolute deadline; the caller passes the parsed value
// to the adapter as `parsedBody`, the documented pass-through that reads nothing
// from `req`. Unit tests cover the reader's branches; one HTTP test proves the
// 413 end-to-end and that a normal request still round-trips through parsedBody.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readBodyBounded,
  type ServeHandle,
  startHttpServer,
  validateServeStartup,
} from "../../src/serve/index.js";
import { vaultReindex } from "../../src/tools/search.js";
import { type DaftariConfig, loadConfig } from "../../src/utils/config.js";

function fakeReq(headers: Record<string, string>, chunks: Buffer[] | null): IncomingMessage {
  const stream = chunks === null ? new Readable({ read() {} }) : Readable.from(chunks);
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  return stream as unknown as IncomingMessage;
}

describe("readBodyBounded", () => {
  it("refuses an oversized declared Content-Length without reading the body", async () => {
    const req = fakeReq({ "content-length": "5000" }, [Buffer.from("x".repeat(5000))]);
    const r = await readBodyBounded(req, 1024, 1000);
    expect(r.status).toBe("too_large");
  });

  it("trips the streamed byte cap when no Content-Length is declared", async () => {
    const chunks = [Buffer.from("x".repeat(600)), Buffer.from("y".repeat(600))];
    const req = fakeReq({}, chunks); // 1200 bytes streamed, cap 1024
    const r = await readBodyBounded(req, 1024, 1000);
    expect(r.status).toBe("too_large");
  });

  it("abandons a body that does not complete within the deadline", async () => {
    const req = fakeReq({}, null); // never ends
    const r = await readBodyBounded(req, 1024, 20);
    expect(r.status).toBe("timeout");
  });

  it("returns the body intact when under the cap", async () => {
    const req = fakeReq({}, [Buffer.from("hello ")]);
    const r = await readBodyBounded(req, 1024, 1000);
    expect(r).toEqual({ status: "ok", body: "hello " });
  });
});

// ---- HTTP end-to-end: a real server rejects an oversized /mcp POST with 413,
// and a normal request still succeeds through the parsedBody pass-through. ----

function buildVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-bodylimit-"));
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
  limits:
    max_body_bytes: 2048
  auth:
    tokens:
      - env: DAFTARI_BODYLIMIT_TOKEN
        user: human:alice
        role: admin
`,
  );
  return dir;
}

function mcpFetch(port: number, body: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer alice-secret",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    },
    body,
  });
}

const NORMAL_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
});

describe("/mcp body limit (HTTP)", () => {
  let vault: string;
  let handle: ServeHandle;
  beforeAll(async () => {
    process.env.DAFTARI_BODYLIMIT_TOKEN = "alice-secret";
    vault = buildVault();
    const reindexed = await vaultReindex(vault);
    if (!reindexed.ok) throw reindexed.error;
    const c = loadConfig(vault);
    if (!c.ok) throw c.error;
    const cfg: DaftariConfig = c.value;
    const gate = validateServeStartup(cfg, "127.0.0.1", process.env);
    if (!gate.ok) throw new Error(gate.error);
    handle = await startHttpServer(vault, cfg, gate.tokens, "127.0.0.1", 0);
  }, 60_000);
  afterAll(async () => {
    await handle.close();
    rmSync(vault, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("rejects a body over max_body_bytes with 413", async () => {
    const oversized = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { pad: "x".repeat(4096) },
    });
    const res = await mcpFetch(handle.port, oversized);
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("payload_too_large");
  }, 30_000);

  it("still serves a normal request through parsedBody", async () => {
    const res = await mcpFetch(handle.port, NORMAL_BODY);
    expect(res.status).toBe(200);
  }, 30_000);
});
