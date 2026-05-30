import { describe, expect, it, vi } from "vitest";
import { withTimeout, wrapChildClient } from "../src/client.js";

describe("ChildClient", () => {
  it("forwards callTool to the underlying MCP client", async () => {
    const fakeMcp = {
      callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "hi" }] }),
      listTools: vi.fn(),
      close: vi.fn(),
    };
    const c = wrapChildClient("v1", fakeMcp as never);
    const r = await c.callTool("vault_read", { path: "a.md" });
    expect(fakeMcp.callTool).toHaveBeenCalledWith({
      name: "vault_read",
      arguments: { path: "a.md" },
    });
    expect(r.content[0]).toMatchObject({ text: "hi" });
  });

  it("forwards listTools to the underlying MCP client", async () => {
    const fakeTools = {
      tools: [{ name: "vault_read", description: "Read a file", inputSchema: {} }],
    };
    const fakeMcp = {
      callTool: vi.fn(),
      listTools: vi.fn().mockResolvedValue(fakeTools),
      close: vi.fn(),
    };
    const c = wrapChildClient("v1", fakeMcp as never);
    const r = await c.listTools();
    expect(fakeMcp.listTools).toHaveBeenCalled();
    expect(r.tools[0].name).toBe("vault_read");
  });

  it("forwards close to the underlying MCP client", async () => {
    const fakeMcp = {
      callTool: vi.fn(),
      listTools: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const c = wrapChildClient("v1", fakeMcp as never);
    await c.close();
    expect(fakeMcp.close).toHaveBeenCalled();
  });
});

describe("withTimeout", () => {
  it("rejects after the deadline and runs the cleanup hook", async () => {
    const cleanup = vi.fn();
    const start = Date.now();
    await expect(withTimeout(new Promise(() => {}), 50, cleanup, "deadline")).rejects.toThrow(
      "deadline",
    );
    expect(cleanup).toHaveBeenCalled();
    expect(Date.now() - start).toBeLessThan(500); // not hung
  });

  it("passes through resolved values when fast", async () => {
    const r = await withTimeout(Promise.resolve("ok"), 1000, () => {}, "x");
    expect(r).toBe("ok");
  });

  it("clears the timer when the promise resolves before the deadline", async () => {
    // Verifies cleanup is NOT invoked on the fast-resolve path — only the
    // finally-branch fires (to clearTimeout), not the timeout callback.
    const cleanup = vi.fn();
    await withTimeout(Promise.resolve(42), 1000, cleanup, "should not fire");
    expect(cleanup).not.toHaveBeenCalled();
  });
});
