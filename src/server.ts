// MCP server wiring. Builds a Server, registers the read-path tools, and
// bridges each tool's Result<T, Error> into the MCP tool-call response shape.
//
// Tool handlers never throw; they return Result. The CallTool request handler
// additionally guards against unexpected throws at the transport boundary so a
// bug cannot take the stdio connection down.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readTools, type ToolDefinition } from "./tools/read.js";

export const SERVER_NAME = "daftari";
export const SERVER_VERSION = "0.1.0";

export function createServer(vaultRoot: string): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const tools: ToolDefinition[] = [...readTools];
  const byName = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const tool = byName.get(name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `unknown tool: ${name}` }],
      };
    }
    try {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      const result = await tool.handler(vaultRoot, args);
      if (!result.ok) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: `Error: ${result.error.message}` },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result.value, null, 2),
          },
        ],
      };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return {
        isError: true,
        content: [
          { type: "text" as const, text: `Unexpected error in ${name}: ${reason}` },
        ],
      };
    }
  });

  return server;
}
