// vault_chains — MCP tool: the end of every supersede chain (#642).
//
// Wraps computeChains (src/curation/chains.ts) over the search index, so a
// chain's head agrees with the `currentSource` search attaches to a superseded
// hit. A separate tool rather than a vault_index mode: vault_index crosses
// federation mounts, and following `superseded_by` is edge traversal, which
// stays on this side of the mount boundary.

import { type AccessContext, canRead, hasAnyRead } from "../access/rbac.js";
import { CHAIN_FLAGS, type Chain, computeChains } from "../curation/chains.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { getSupersessionGraph } from "../storage/index-db.js";
import type { ToolDefinition } from "./read.js";
import { ensureIndexReady, openIndexForActiveProvider } from "./search.js";

export interface VaultChainsResult {
  count: number;
  chains: Chain[];
}

export async function vaultChains(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<VaultChainsResult, Error>> {
  if (access && !hasAnyRead(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot use vault_chains`));
  }
  if (args.flagged_only !== undefined && typeof args.flagged_only !== "boolean") {
    return err(new Error("vault_chains 'flagged_only' must be a boolean"));
  }

  const ready = await ensureIndexReady(vaultRoot);
  if (!ready.ok) return ready;
  const opened = openIndexForActiveProvider(vaultRoot);
  if (!opened.ok) return opened;

  const db = opened.value;
  try {
    const all = computeChains(
      getSupersessionGraph(db),
      (doc) => !access || canRead(access.role, doc.collection),
    );
    const chains = args.flagged_only === true ? all.filter((c) => c.flags.length > 0) : all;
    return ok({ count: chains.length, chains });
  } finally {
    db.close();
  }
}

const CHAIN_MEMBER_PROPERTIES: Record<string, unknown> = {
  path: { type: "string" },
  status: { type: "string" },
  updated: { type: "string", description: "YYYY-MM-DD (verbatim as authored)" },
};

export const chainsTools: ToolDefinition[] = [
  {
    name: "vault_chains",
    title: "List the end of every supersede chain",
    annotations: { readOnlyHint: true },
    description:
      "List the end of every supersede chain: per chain, the current entry with its status " +
      "and date, and the entries it replaced. Follows superseded_by across the whole vault " +
      "with no seed. A chain is flagged when it ends in a draft (draft), ends in a deprecated " +
      "or archived document (retired), has a superseded status with no pointer forward " +
      "(unforwarded), points at a missing document (dangling), never terminates (loop), or " +
      "continues into a document outside the caller's read scope (restricted). head is null " +
      "on loop and restricted chains. Replaced entries are flat: merge fan-in shows as " +
      "several entries at one depth. Advisory: reports, never repairs.",
    inputSchema: {
      type: "object",
      properties: {
        flagged_only: {
          type: "boolean",
          description: "true: return only chains with at least one flag",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        count: {
          type: "integer",
          minimum: 0,
          description: "Number of chains returned (post-RBAC, post-filter)",
        },
        chains: {
          type: "array",
          items: {
            type: "object",
            properties: {
              head: {
                type: ["object", "null"],
                description: "The current entry; null on loop and restricted chains",
                properties: CHAIN_MEMBER_PROPERTIES,
                required: ["path", "status", "updated"],
              },
              replaced: {
                type: "array",
                description: "Readable entries the head replaced, nearest first",
                items: {
                  type: "object",
                  properties: {
                    ...CHAIN_MEMBER_PROPERTIES,
                    depth: {
                      type: "integer",
                      minimum: 0,
                      description:
                        "Hops to the head. On a loop chain, 0 is on the loop and a tail " +
                        "counts hops to reach it",
                    },
                  },
                  required: ["path", "status", "updated", "depth"],
                },
              },
              hidden_replaced: {
                type: "string",
                enum: ["none", "some", "many"],
                description:
                  "Coarsened remainder of replaced entries outside the caller's read scope",
              },
              flags: { type: "array", items: { type: "string", enum: [...CHAIN_FLAGS] } },
            },
            required: ["head", "replaced", "hidden_replaced", "flags"],
          },
        },
      },
      required: ["count", "chains"],
    },
    docLinks: (value) => {
      const { chains } = value as VaultChainsResult;
      return chains.flatMap((c) => [
        ...(c.head ? [c.head.path] : []),
        ...c.replaced.map((r) => r.path),
      ]);
    },
    summarize: (value) => {
      const { count, chains } = value as VaultChainsResult;
      const replaced = chains.reduce((sum, c) => sum + c.replaced.length, 0);
      const flagged = chains.filter((c) => c.flags.length > 0).length;
      return `${count} chains replacing ${replaced} documents, ${flagged} flagged`;
    },
    handler: (vaultRoot, args, access) => vaultChains(vaultRoot, args, access),
  },
];
