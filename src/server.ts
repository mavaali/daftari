// MCP server wiring. Builds a Server, registers the read-path tools, and
// bridges each tool's Result<T, Error> into the MCP tool-call response shape.
//
// Tool handlers never throw; they return Result. The CallTool request handler
// additionally guards against unexpected throws at the transport boundary so a
// bug cannot take the stdio connection down.

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type AccessContext, guestAccess } from "./access/rbac.js";
import { curationTools } from "./tools/curation.js";
import { edgeTools } from "./tools/edges.js";
import { readTools, type ToolDefinition } from "./tools/read.js";
import { searchTools } from "./tools/search.js";
import { stagedActionTools } from "./tools/staged-actions.js";
import { themesTools } from "./tools/themes.js";
import { writeTools } from "./tools/write.js";

export const SERVER_NAME = "daftari";

// The version is read from the package manifest so it never drifts from the
// published version. src/server.ts and dist/server.js both sit one level under
// the package root, so this relative path resolves the same in dev and build.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
  version: string;
};
export const SERVER_VERSION = manifest.version;

// The server runs as one access identity for its whole lifetime — the
// --user / --role it was started with. Every tool call is enforced against it.
// Absent an explicit context the server falls back to the deny-all guest.
export function createServer(vaultRoot: string, access: AccessContext = guestAccess()): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const tools: ToolDefinition[] = [
    ...readTools,
    ...searchTools,
    ...themesTools,
    ...writeTools,
    ...curationTools,
    ...stagedActionTools,
    ...edgeTools,
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      ...(t.title ? { title: t.title } : {}),
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
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
      const result = await tool.handler(vaultRoot, args, access);
      if (!result.ok) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error: ${result.error.message}` }],
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
        content: [{ type: "text" as const, text: `Unexpected error in ${name}: ${reason}` }],
      };
    }
  });

  return server;
}
