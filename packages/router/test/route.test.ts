import { describe, expect, it, vi } from "vitest";
import { routeToVault } from "../src/tools/route.js";

const fake = (name: string) => ({
  name,
  listTools: vi.fn(),
  close: vi.fn(),
  callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
});

describe("routeToVault", () => {
  const a = fake("a");
  const b = fake("b");
  const pool = {
    get: (n: string) => (n === "a" ? a : n === "b" ? b : null),
    all: () => [a, b],
    close: vi.fn(),
  };

  it("dispatches when vault arg is set", async () => {
    await routeToVault(pool as never, "vault_read", { vault: "a", path: "x.md" });
    expect(a.callTool).toHaveBeenCalledWith("vault_read", { path: "x.md" });
  });

  it("parses vault from prefixed path", async () => {
    await routeToVault(pool as never, "vault_read", { path: "b:notes/x.md" });
    expect(b.callTool).toHaveBeenCalledWith("vault_read", { path: "notes/x.md" });
  });

  it("returns an error result when no vault is identifiable", async () => {
    const r = await routeToVault(pool as never, "vault_write", { path: "x.md", body: "hi" });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/requires a vault/);
  });

  it("returns an error when vault name is unknown", async () => {
    const r = await routeToVault(pool as never, "vault_read", { vault: "zzz", path: "x.md" });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/unknown vault/);
  });

  it("treats empty vault prefix (':foo') as no prefix", async () => {
    const r = await routeToVault(pool as never, "vault_read", { path: ":foo.md" });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toMatch(/requires a vault/);
  });

  it("lists known vaults when the requested vault is unknown", async () => {
    const r = await routeToVault(pool as never, "vault_read", { vault: "zzz", path: "x.md" });
    expect((r.content[0] as { text: string }).text).toMatch(/Known vaults: a, b/);
  });
});
