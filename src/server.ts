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
import { consumesTools } from "./tools/consumes.js";
import { curationTools } from "./tools/curation.js";
import { edgeStalenessTools } from "./tools/edge-staleness.js";
import { edgeTools } from "./tools/edges.js";
import { readTools, type ToolDefinition } from "./tools/read.js";
import { receiptTools } from "./tools/receipt.js";
import { searchTools } from "./tools/search.js";
import { stagedActionTools } from "./tools/staged-actions.js";
import { themesTools } from "./tools/themes.js";
import { tier1Tools } from "./tools/tier1.js";
import { tier2Tools } from "./tools/tier2.js";
import { witnessTools } from "./tools/witness.js";
import { writeTools } from "./tools/write.js";
import type { ToolsConfig } from "./utils/config.js";

export const SERVER_NAME = "daftari";

// The version is read from the package manifest so it never drifts from the
// published version. src/server.ts and dist/server.js both sit one level under
// the package root, so this relative path resolves the same in dev and build.
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
  version: string;
};
export const SERVER_VERSION = manifest.version;

// The full registry. Static — assembled once at module load, shared by every
// server instance and by the tier-exposure helpers below.
const allTools: ToolDefinition[] = [
  ...readTools,
  ...receiptTools,
  ...witnessTools,
  ...searchTools,
  ...themesTools,
  ...writeTools,
  ...curationTools,
  ...stagedActionTools,
  ...edgeTools,
  ...consumesTools,
  ...tier1Tools,
  ...tier2Tools,
  ...edgeStalenessTools,
];

export function registeredToolNames(): string[] {
  return allTools.map((t) => t.name);
}

// Tool-exposure tiers (#103). Tiers are additive: standard = core + its own
// list; full = the whole registry (never enumerated, so a new tool is
// full-tier by default and only joins a leaner tier deliberately).
//
// core is the search-before-derive loop end to end; standard adds the full
// document lifecycle — including propose/ratify, which IS the write path for
// RBAC vaults with propose-only roles — plus index diagnostics. Everything
// else (tensions, themes, witness/receipt epistemics, the edge graph,
// tier-1/tier-2 dispatch, staleness) is specialist curation surface: full.
export const CORE_TOOLS: readonly string[] = [
  "vault_search",
  "vault_read",
  "vault_write",
  "vault_index",
  "vault_lint",
  "vault_status",
];

export const STANDARD_TOOLS: readonly string[] = [
  ...CORE_TOOLS,
  "vault_append",
  "vault_promote",
  "vault_deprecate",
  "vault_supersede",
  "vault_merge",
  "vault_set_confidence",
  "vault_set_tier",
  "vault_stage_action",
  "vault_ratify",
  "vault_search_related",
  "vault_provenance",
  "vault_reindex",
];

export interface ToolExposure {
  exposed: Set<string>;
  // include/exclude entries naming no registered tool — the caller's warning.
  // Deliberately not an error: a config written for a future daftari must
  // keep loading on today's build (#104).
  unknown: string[];
}

// Resolves which tool names ListTools advertises: tier set, plus include,
// minus exclude — exclude always wins (#104). Pure; exported for tests and
// for the startup warning in index.ts.
export function resolveToolExposure(tools: ToolsConfig): ToolExposure {
  const registered = new Set(registeredToolNames());
  const exposed =
    tools.tier === "full"
      ? new Set(registered)
      : new Set(
          (tools.tier === "core" ? CORE_TOOLS : STANDARD_TOOLS).filter((n) => registered.has(n)),
        );
  // A Set, not an array: the same unknown name in BOTH lists must warn once,
  // not twice.
  const unknown = new Set<string>();
  for (const name of tools.include) {
    if (registered.has(name)) exposed.add(name);
    else unknown.add(name);
  }
  for (const name of tools.exclude) {
    if (registered.has(name)) exposed.delete(name);
    else unknown.add(name);
  }
  return { exposed, unknown: [...unknown] };
}

// The server runs as one access identity for its whole lifetime — the
// --user / --role it was started with. Every tool call is enforced against it.
// Absent an explicit context the server falls back to the deny-all guest.
// `toolsConfig` (#103/#104) narrows what ListTools ADVERTISES; CallTool still
// accepts every registered name, so an agent holding a cached tool name from
// a prior session keeps working across a tier change.
export function createServer(
  vaultRoot: string,
  access: AccessContext = guestAccess(),
  toolsConfig?: ToolsConfig,
): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const byName = new Map(allTools.map((t) => [t.name, t]));
  const exposedNames = toolsConfig ? resolveToolExposure(toolsConfig).exposed : null;
  const exposed = exposedNames ? allTools.filter((t) => exposedNames.has(t.name)) : allTools;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: exposed.map((t) => ({
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
