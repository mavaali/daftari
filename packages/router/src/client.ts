import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { VaultConfig } from "./config.js";

// SDK callTool return is a union of the modern shape { content, isError } and
// the legacy compat shape { toolResult }. Daftari uses the modern MCP SDK so
// the legacy branch is never reached; the cast below is safe for our use-case.
export type CallToolResult = {
  content: unknown[];
  isError?: boolean;
};

export type ToolDescriptor = {
  name: string;
  description?: string;
  inputSchema: unknown;
};

export type ChildClient = {
  name: string;
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  listTools: () => Promise<{ tools: ToolDescriptor[] }>;
  close: () => Promise<void>;
};

export function wrapChildClient(name: string, mcp: Client): ChildClient {
  return {
    name,
    callTool: (toolName, args) =>
      mcp.callTool({ name: toolName, arguments: args }) as Promise<CallToolResult>,
    listTools: () => mcp.listTools() as Promise<{ tools: ToolDescriptor[] }>,
    close: async () => {
      await mcp.close();
    },
  };
}

export async function startChild(
  vault: VaultConfig,
  daftariBin = "daftari",
  startTimeoutMs = 10_000,
): Promise<ChildClient> {
  // args[] is passed to cross-spawn with shell:false — no shell injection risk.
  const transport = new StdioClientTransport({
    command: daftariBin,
    args: ["--vault", vault.path, "--user", vault.user, "--role", vault.role],
  });
  const mcp = new Client({ name: "daftari-router", version: "0.1.0" }, { capabilities: {} });
  try {
    await withTimeout(
      mcp.connect(transport),
      startTimeoutMs,
      () => mcp.close().catch(() => {}),
      `vault '${vault.name}' did not complete MCP handshake in ${startTimeoutMs}ms`,
    );
  } catch (err) {
    await mcp.close().catch(() => {});
    throw err;
  }
  return wrapChildClient(vault.name, mcp);
}

export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  onTimeout: () => unknown,
  msg: string,
): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        t = setTimeout(() => {
          try {
            onTimeout();
          } catch {
            // ignore cleanup errors
          }
          reject(new Error(msg));
        }, ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}
