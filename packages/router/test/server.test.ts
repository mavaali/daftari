import { describe, expect, it, vi } from "vitest";
import { createRouterServer } from "../src/server.js";

const childTools = [
  {
    name: "vault_read",
    description: "Read.",
    inputSchema: {
      type: "object" as const,
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "vault_search",
    description: "Search.",
    inputSchema: {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
];

describe("router server", () => {
  it("routes vault_read to the specified vault", async () => {
    const a = {
      name: "a",
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "BODY" }] }),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const pool = {
      get: (n: string) => (n === "a" ? a : null),
      all: () => [a],
      close: vi.fn(),
    };
    const srv = createRouterServer(pool as never, childTools);
    const out = await srv.dispatch("vault_read", { vault: "a", path: "x.md" });
    expect(a.callTool).toHaveBeenCalledWith("vault_read", { path: "x.md" });
    expect((out.content[0] as { text: string }).text).toBe("BODY");
  });

  it("fans out vault_search when vault is omitted", async () => {
    const a = {
      name: "a",
      callTool: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: '{"count":1,"hits":[{"path":"x.md","score":0.9,"collection":"c"}]}',
          },
        ],
      }),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const b = {
      name: "b",
      callTool: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: '{"count":1,"hits":[{"path":"y.md","score":0.8,"collection":"c"}]}',
          },
        ],
      }),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const pool = {
      get: (n: string) => (({ a, b }) as Record<string, typeof a>)[n] ?? null,
      all: () => [a, b],
      close: vi.fn(),
    };
    const srv = createRouterServer(pool as never, childTools);
    const out = await srv.dispatch("vault_search", { query: "deploy" });
    const payload = JSON.parse((out.content[0] as { text: string }).text);
    expect(payload.hits.map((h: { path: string }) => h.path)).toEqual(["a:x.md", "b:y.md"]);
  });

  it("returns an error for unknown tool names", async () => {
    const pool = { get: () => null, all: () => [], close: vi.fn() };
    const srv = createRouterServer(pool as never, childTools);
    const out = await srv.dispatch("nonexistent_tool", {});
    expect(out.isError).toBe(true);
  });

  it("delegates fanout with vault arg to single-vault routing", async () => {
    const a = {
      name: "a",
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "result" }] }),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const pool = {
      get: (n: string) => (n === "a" ? a : null),
      all: () => [a],
      close: vi.fn(),
    };
    const srv = createRouterServer(pool as never, childTools);
    await srv.dispatch("vault_search", { vault: "a", query: "deploy" });
    expect(a.callTool).toHaveBeenCalledWith("vault_search", { query: "deploy" });
  });

  it("treats an empty-string vault as unset (fans out, matching routeToVault parity)", async () => {
    const a = {
      name: "a",
      callTool: vi
        .fn()
        .mockResolvedValue({ content: [{ type: "text", text: '{"count":0,"hits":[]}' }] }),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const b = {
      name: "b",
      callTool: vi
        .fn()
        .mockResolvedValue({ content: [{ type: "text", text: '{"count":0,"hits":[]}' }] }),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const pool = {
      get: (n: string) => ({ a, b })[n as "a" | "b"] ?? null,
      all: () => [a, b],
      close: vi.fn(),
    };
    const srv = createRouterServer(pool as never, childTools);
    await srv.dispatch("vault_search", { vault: "", query: "deploy" });
    // Both children should have been called — empty string did not pin to one vault.
    expect(a.callTool).toHaveBeenCalledWith("vault_search", { query: "deploy" });
    expect(b.callTool).toHaveBeenCalledWith("vault_search", { query: "deploy" });
  });

  it("errors when fanning out on an empty pool", async () => {
    const pool = { get: () => null, all: () => [], close: vi.fn() };
    const srv = createRouterServer(pool as never, childTools);
    const out = await srv.dispatch("vault_search", { query: "deploy" });
    expect(out.isError).toBe(true);
    expect((out.content[0] as { text: string }).text).toMatch(/no vaults are configured/);
  });

  it("rejects non-object args at the dispatch boundary", async () => {
    const pool = { get: () => null, all: () => [], close: vi.fn() };
    const srv = createRouterServer(pool as never, childTools);
    // null
    const a = await srv.dispatch("vault_read", null as never);
    expect(a.isError).toBe(true);
    // array
    const b = await srv.dispatch("vault_read", [] as never);
    expect(b.isError).toBe(true);
    // primitive
    const c = await srv.dispatch("vault_read", "x" as never);
    expect(c.isError).toBe(true);
  });

  it("merges fanout results across many vaults (scale check)", async () => {
    // Six vaults — confirms the dispatch path doesn't accidentally cap at the
    // 1-2 vaults the other tests cover, and that merge ordering holds.
    const vaultNames = ["a", "b", "c", "d", "e", "f"];
    const children = vaultNames.map((n, i) => ({
      name: n,
      callTool: vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              count: 1,
              hits: [{ path: `${n}.md`, score: 1 - i * 0.1, collection: "c" }],
            }),
          },
        ],
      }),
      listTools: vi.fn(),
      close: vi.fn(),
    }));
    const byName = new Map(children.map((c) => [c.name, c]));
    const pool = {
      get: (n: string) => byName.get(n) ?? null,
      all: () => [...children],
      close: vi.fn(),
    };
    const srv = createRouterServer(pool as never, childTools);
    const out = await srv.dispatch("vault_search", { query: "deploy" });
    const payload = JSON.parse((out.content[0] as { text: string }).text);
    expect(payload.count).toBe(6);
    // Score-descending order: a (1.0), b (0.9), c (0.8), d (0.7), e (0.6), f (0.5).
    expect(payload.hits.map((h: { path: string }) => h.path)).toEqual([
      "a:a.md",
      "b:b.md",
      "c:c.md",
      "d:d.md",
      "e:e.md",
      "f:f.md",
    ]);
    // Every child was hit once.
    for (const c of children) {
      expect(c.callTool).toHaveBeenCalledTimes(1);
    }
  });
});
