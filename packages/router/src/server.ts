// server.ts — Router MCP server wiring.
//
// Glues the catalog (T6), single-vault dispatch (T7), and fan-out + mergers
// (T8) behind a single MCP Server instance.
//
// Dual dispatch model
// -------------------
// `dispatch(name, args)` is exported alongside the SDK `Server`. It is used by:
//   1. The `CallToolRequestSchema` handler (transport path) — wraps dispatch
//      in try/catch, so any thrown error becomes an MCP error result and
//      cannot take the stdio connection down.
//   2. Tests + in-process embedders (direct path) — invoke `dispatch` without
//      the SDK transport.
//
// Error semantics in both paths:
//   - Tool-level failures (unknown tool, no merger, child returned isError,
//     fanout child threw) return `{ isError: true, content: [...] }`.
//   - The transport path additionally swallows unexpected throws and converts
//     them to an MCP error. The direct path lets those throws propagate —
//     they indicate router bugs (e.g. JSON.stringify failing on circular
//     refs in a merger output), and silently hiding them from tests would
//     mask regressions. Direct-path callers that want transport semantics
//     can wrap their dispatch call in the same try/catch.
//
// Scale / timeout model
// ---------------------
// Fan-out hits every child in `pool.all()` concurrently. The pool is sized at
// startup from `vaults.yaml` (typically a handful of vaults — Phase 1 is not
// optimized for hundreds). Per-child timeouts live inside `startChild` (T4);
// the router does not impose an additional aggregate deadline. If a vault
// child hangs longer than its own timeout, fanoutCall surfaces it as a
// per-vault error row rather than failing the whole call.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ChildPool } from "./children.js";
import { parseVaultPath } from "./path.js";
import { buildCatalog, type CatalogTool, type ChildToolDescriptor } from "./tools/catalog.js";
import { fanoutCall } from "./tools/fanout.js";
import {
  mergeIndex,
  mergeLint,
  mergeReindex,
  mergeSearch,
  mergeStatus,
  mergeThemes,
} from "./tools/merge.js";
import { routeToVault } from "./tools/route.js";

export type Result = { content: unknown[]; isError?: boolean };

// Per-tool merger for fanout dispatches. Tools not present here cannot fan
// out; a fanout call for a tool without a merger is a router bug and surfaces
// as an MCP error rather than silently swallowing results.
//
// The `as never` casts trade strict per-merger input typing for a flat
// registry — each merger's row shape differs (SearchHit vs IndexEntry vs ...)
// but they share the VaultResult<T> envelope. The dispatch site only sees
// `unknown[]` rows from fanoutCall, so a uniform Record signature is the
// honest type here.
const MERGERS: Record<string, (rows: never[]) => unknown> = {
  vault_search: mergeSearch as never,
  vault_index: mergeIndex as never,
  vault_status: mergeStatus as never,
  vault_lint: mergeLint as never,
  vault_themes: mergeThemes as never,
  vault_reindex: mergeReindex as never,
};

const err = (text: string): Result => ({
  isError: true,
  content: [{ type: "text", text }],
});

// Safely encode a merger result. JSON.stringify can throw on circular refs or
// BigInt; that indicates a router bug, not a user-input bug. We surface it as
// an MCP error in both dispatch paths so the failure mode is consistent and
// observable (rather than silently propagating in the direct path only).
function encodeMerged(merged: unknown, tool: string): Result {
  try {
    return { content: [{ type: "text", text: JSON.stringify(merged, null, 2) }] };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(`router: failed to encode '${tool}' merger result: ${reason}`);
  }
}

export type RouterServer = {
  mcp: Server;
  dispatch: (name: string, args: Record<string, unknown>) => Promise<Result>;
  catalog: CatalogTool[];
};

export function createRouterServer(
  pool: ChildPool,
  childTools: ChildToolDescriptor[],
): RouterServer {
  const catalog = buildCatalog(childTools);
  const byName = new Map(catalog.map((t) => [t.name, t]));

  const mcp = new Server(
    { name: "daftari-router", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  async function dispatch(name: string, args: Record<string, unknown>): Promise<Result> {
    // Args shape guard. The MCP CallTool schema permits a missing/null
    // arguments object; the CallToolRequestSchema handler already coalesces
    // to `{}`, but direct callers might not. Reject anything non-object up
    // front so downstream code can assume Record<string, unknown>.
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      return err(`router: '${name}' arguments must be an object`);
    }

    const tool = byName.get(name);
    if (!tool) return err(`unknown tool: ${name}`);

    if (tool.routing === "require-vault") {
      return routeToVault(pool, name, args);
    }

    // routing === "fanout"
    // For parity with routeToVault, a vault can be specified via either an
    // explicit args.vault OR a vault-prefixed args.path (e.g. "a:x.md"). Both
    // signals route to the single-vault path; only an absent/empty vault and
    // no prefix falls through to fanout.
    if (hasExplicitVault(args)) {
      return routeToVault(pool, name, args);
    }

    const merger = MERGERS[name];
    if (!merger) {
      return err(`router: no merger registered for fanout tool '${name}'`);
    }

    // Empty pool is an error rather than a silent empty merge result. An empty
    // pool at this point means startPool succeeded with zero vaults — likely a
    // config bug. Surfacing it loudly beats returning {count: 0, hits: []}
    // and letting the caller wonder why their search found nothing.
    if (pool.all().length === 0) {
      return err(`router: cannot fan out '${name}': no vaults are configured`);
    }

    const rows = await fanoutCall(pool, name, args);
    const merged = merger(rows as never);
    return encodeMerged(merged, name);
  }

  function hasExplicitVault(args: Record<string, unknown>): boolean {
    if (typeof args.vault === "string" && args.vault.length > 0) return true;
    if (typeof args.path === "string") {
      const parsed = parseVaultPath(args.path);
      if (parsed.vault && parsed.vault.length > 0) return true;
    }
    return false;
  }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    // The SDK's ListTools schema types inputSchema as a generic object; our
    // CatalogTool.inputSchema is narrower. This map is the right boundary
    // for the structural widening.
    tools: catalog.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    })),
  }));

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await dispatch(
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>,
      );
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(`router error in ${req.params.name}: ${reason}`);
    }
  });

  return { mcp, dispatch, catalog };
}
