import { describe, expect, it, vi } from "vitest";
import { fanoutCall } from "../src/tools/fanout.js";

describe("fanoutCall", () => {
  it("calls the tool on every child, parses text content as JSON", async () => {
    const a = {
      name: "a",
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"count":1,"hits":[{"path":"x.md","score":0.9}]}' }],
      }),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const b = {
      name: "b",
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"count":1,"hits":[{"path":"y.md","score":0.8}]}' }],
      }),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const pool = { get: () => null, all: () => [a, b], close: vi.fn() };

    const out = await fanoutCall(pool as never, "vault_search", {
      query: "deploy",
      vault: "ignored",
    });

    // vault arg is stripped from forwarded call
    expect(a.callTool).toHaveBeenCalledWith("vault_search", { query: "deploy" });
    expect(b.callTool).toHaveBeenCalledWith("vault_search", { query: "deploy" });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ vault: "a", ok: true });
    expect(out[1]).toMatchObject({ vault: "b", ok: true });
  });

  it("surfaces per-vault thrown errors as ok: false rows", async () => {
    const a = {
      name: "a",
      callTool: vi.fn().mockRejectedValue(new Error("boom")),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const b = {
      name: "b",
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '{"count":0,"hits":[]}' }],
      }),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const pool = { get: () => null, all: () => [a, b], close: vi.fn() };

    const out = await fanoutCall(pool as never, "vault_search", { query: "x" });

    expect(out[0]).toMatchObject({ vault: "a", ok: false, error: "boom" });
    expect(out[1]).toMatchObject({ vault: "b", ok: true });
  });

  it("surfaces child-returned isError as ok: false rows", async () => {
    const a = {
      name: "a",
      callTool: vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: "text", text: "access denied" }],
      }),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const pool = { get: () => null, all: () => [a], close: vi.fn() };

    const out = await fanoutCall(pool as never, "vault_search", { query: "x" });

    expect(out[0]).toMatchObject({ vault: "a", ok: false, error: "access denied" });
  });

  it("returns empty array for empty pool", async () => {
    const pool = { get: () => null, all: () => [], close: vi.fn() };
    const out = await fanoutCall(pool as never, "vault_search", { query: "x" });
    expect(out).toEqual([]);
  });

  it("handles non-Error thrown values", async () => {
    const a = {
      name: "a",
      callTool: vi.fn().mockRejectedValue("string error"),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const pool = { get: () => null, all: () => [a], close: vi.fn() };
    const out = await fanoutCall(pool as never, "vault_search", { query: "x" });
    expect(out[0]).toMatchObject({ vault: "a", ok: false, error: "string error" });
  });

  it("uses vault name from child, not from args", async () => {
    const child = {
      name: "the-vault",
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: '"ok"' }],
      }),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const pool = { get: () => null, all: () => [child], close: vi.fn() };
    const out = await fanoutCall(pool as never, "vault_status", {});
    expect(out[0]).toMatchObject({ vault: "the-vault", ok: true, value: "ok" });
  });
});
