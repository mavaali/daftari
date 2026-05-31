import { describe, expect, it, vi } from "vitest";
import { createPool, startPool } from "../src/children.js";
import type { RouterConfig } from "../src/config.js";

const makeFake = (name: string) => ({
  name,
  callTool: vi.fn(),
  listTools: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
});

describe("ChildPool", () => {
  it("exposes children by name", async () => {
    const a = makeFake("a");
    const b = makeFake("b");
    const pool = createPool([a, b]);
    expect(pool.get("a")).toBe(a);
    expect(pool.get("missing")).toBeNull();
    expect(pool.all().map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("close fans out to every child", async () => {
    const a = makeFake("a");
    const b = makeFake("b");
    const pool = createPool([a, b]);
    await pool.close();
    expect(a.close).toHaveBeenCalled();
    expect(b.close).toHaveBeenCalled();
  });

  it("close swallows individual child errors", async () => {
    const a = makeFake("a");
    const b = makeFake("b");
    a.close.mockRejectedValue(new Error("close failed"));
    const pool = createPool([a, b]);
    // Should not throw even though a.close() rejects
    await expect(pool.close()).resolves.toBeUndefined();
    expect(b.close).toHaveBeenCalled();
  });
});

describe("startPool", () => {
  it("rolls back successfully-started children when a later vault fails", async () => {
    const a = makeFake("a");
    const b = makeFake("b");
    const config: RouterConfig = {
      transport: "stdio",
      vaults: [
        { name: "a", path: "/tmp/a", user: "u", role: "admin", description: "d" },
        { name: "b", path: "/tmp/b", user: "u", role: "admin", description: "d" },
        { name: "c", path: "/tmp/c", user: "u", role: "admin", description: "d" },
      ],
      defaults: { searchLimit: 10 },
    };
    let n = 0;
    const spawner = vi.fn(async () => {
      if (n === 0) {
        n++;
        return a;
      }
      if (n === 1) {
        n++;
        return b;
      }
      throw new Error("spawn failed for vault c");
    });
    await expect(startPool(config, "daftari", spawner)).rejects.toThrow("spawn failed for vault c");
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).toHaveBeenCalledTimes(1);
  });

  it("returns a pool with all children when all vaults start successfully", async () => {
    const a = makeFake("a");
    const b = makeFake("b");
    const config: RouterConfig = {
      transport: "stdio",
      vaults: [
        { name: "a", path: "/tmp/a", user: "u", role: "admin", description: "d" },
        { name: "b", path: "/tmp/b", user: "u", role: "admin", description: "d" },
      ],
      defaults: { searchLimit: 10 },
    };
    let n = 0;
    const spawner = vi.fn(async () => {
      if (n === 0) {
        n++;
        return a;
      }
      return b;
    });
    const pool = await startPool(config, "daftari", spawner);
    expect(pool.get("a")).toBe(a);
    expect(pool.get("b")).toBe(b);
    expect(pool.all()).toHaveLength(2);
  });
});
