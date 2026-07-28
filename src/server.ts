// MCP server wiring. Builds a Server, registers the read-path tools, and
// bridges each tool's Result<T, Error> into the MCP tool-call response shape.
//
// Tool handlers never throw; they return Result. The CallTool request handler
// additionally guards against unexpected throws at the transport boundary so a
// bug cannot take the stdio connection down.

import { readFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type AccessContext, guestAccess } from "./access/rbac.js";
import { docUri, listResources, readResource, resourceTemplates } from "./resources.js";
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

// The full ToolDefinition registry, for tests that need more than the name
// (output-schema compilation, summarize/docLinks presence checks). Not used
// by createServer itself — that closes over the module-local `allTools`
// directly — this exists purely as a read-only test seam.
export function allRegisteredTools(): ToolDefinition[] {
  return allTools;
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

// MCP content block shapes this module emits. Kept local (not imported from
// the SDK) so this file's return types stay self-describing; the SDK
// accepts a wider shape, this is the subset we ever construct.
interface TextBlock {
  type: "text";
  text: string;
}
interface ResourceLinkBlock {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType: string;
}

// The CallTool bridge's presentation step (spec 2026-07-26, Decision 3),
// pulled out of the request handler as its own pure-ish function so it can
// be unit-tested directly against ANY ToolDefinition — including a
// hand-built stub with no `summarize`, or one that throws — without needing
// a live Server/transport (test/server.test.ts, C5). Takes the tool's
// already-successful ok-value; the caller (createServer's CallTool handler)
// owns the RBAC/dispatch/error-branch decisions around it.
//
// Three channels:
//   content           — a compact, model-facing summary, plus resource_link
//                       entries for the docs the result references;
//   structuredContent — the full typed result, matching outputSchema (or a
//                       tool-projected subset — see wireValue).
//
// A tool with no `summarize` falls back to the pretty-printed value, so this
// is backward compatible for any tool that has not opted in.
//
// Presentation hardening (C5): `summarize`/`docLinks` are pure functions
// over an already-successful result, but a summarizer bug must never turn a
// correct tool call into an error response — that would be worse than the
// JSON.stringify fallback it was meant to improve on. Each runs in its own
// try/catch with the same fallback the tool would get by not opting in.
export function formatSuccessResult(
  tool: ToolDefinition,
  value: unknown,
): { content: (TextBlock | ResourceLinkBlock)[]; structuredContent: Record<string, unknown> } {
  let summary: string;
  try {
    summary = tool.summarize ? tool.summarize(value) : JSON.stringify(value, null, 2);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`daftari: warning: summarize threw for ${tool.name}: ${reason}\n`);
    summary = JSON.stringify(value, null, 2);
  }
  let links: string[] = [];
  try {
    links = tool.docLinks ? tool.docLinks(value) : [];
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    process.stderr.write(`daftari: warning: docLinks threw for ${tool.name}: ${reason}\n`);
    links = [];
  }
  const wireValue = tool.wireValue ? tool.wireValue(value) : (value as Record<string, unknown>);
  return {
    content: [
      { type: "text", text: summary },
      // Links inherit read-gating: a handler only ever names docs the caller
      // may read, so every link emitted here is readable by construction
      // (Decision 3). Filtered to non-empty strings so a summarizer bug (or
      // a legitimate empty-string edge case) never mints a resource_link
      // with no uri.
      ...links
        .filter((path) => typeof path === "string" && path.length > 0)
        .map(
          (path): ResourceLinkBlock => ({
            type: "resource_link",
            uri: docUri(path),
            name: path,
            mimeType: "text/markdown",
          }),
        ),
    ],
    structuredContent: wireValue,
  };
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
    { capabilities: { tools: {}, resources: {} } },
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
      outputSchema: t.outputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  }));

  // Resources (spec 2026-07-26, Decision 2). Every listing and read resolves
  // against this server's access context, exactly as tools do — a resource is
  // not a back door around RBAC. src/resources.ts holds the disclosure rules.
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: resourceTemplates(),
  }));

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const result = await listResources(vaultRoot, access);
    // A listing failure yields an empty list rather than an error: a doc list
    // that fails loudly for some callers and not others is itself a signal.
    return { resources: result.ok ? result.value : [] };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const result = await readResource(vaultRoot, uri, access);
    if (!result.ok) throw new Error(result.error.message);
    return { contents: [result.value] };
  });

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
      // Presentation (spec 2026-07-26, Decision 3) is a pure function of the
      // tool and its ok-value — see formatSuccessResult above.
      return formatSuccessResult(tool, result.value);
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
