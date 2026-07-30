// vault_canon — MCP tool: settled vs contested belief over a depth-bounded topic.
//
// Wraps computeCanon (src/canon/index.ts) as a single MCP tool. The tool
// traverses an ego-graph of vault documents seeded at `seed`, classifies each
// holder's documents as settled (no recorded contradiction) or contested (at
// least one tension links two docs in the candidate set), and returns a
// receipt over the cited paths.
//
// "settled means no contradiction has been RECORDED (graph_completeness:
// curated), not that none exists." The receipt and flags make this explicit.

import type { AccessContext } from "../access/rbac.js";
import type { ComputeCanonResult } from "../canon/index.js";
import { computeCanon } from "../canon/index.js";
import type { ToolDefinition } from "./read.js";

// ---------------------------------------------------------------------------
// MCP tool definition
// ---------------------------------------------------------------------------

export const canonTools: ToolDefinition[] = [
  {
    name: "vault_canon",
    title: "Compute settled vs contested belief",
    annotations: { readOnlyHint: true },
    description:
      "Compute settled vs contested belief over a depth-bounded topic graph seeded at `seed`. " +
      "Traverses an ego-graph of vault documents and tensions up to `depth` hops, then " +
      "classifies each holder's position as settled (no contradiction recorded in the graph) " +
      "or contested (at least one tension links two candidate documents). " +
      "Returns settled claims with their citations, contested trajectories ordered by " +
      "valid_from, visibility flags, and a vault_receipt over all cited paths. " +
      "IMPORTANT: settled means no contradiction has been RECORDED " +
      "(flags.graph_completeness === 'curated'), not that none exists in the world. " +
      "When flags.partial_visibility is true, some tensions involve documents outside " +
      "the caller's read scope — the settled/contested split is incomplete.",
    inputSchema: {
      type: "object",
      properties: {
        seed: {
          type: "string",
          description:
            "Vault-relative path to the starting document for the topic ego-graph, " +
            "e.g. competitive-intel/pricing.md",
        },
        holders: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional list of holder identities to restrict classification to. " +
            "When absent, all holders visible in the candidate set are considered.",
        },
        as_of: {
          type: "string",
          description: "YYYY-MM-DD date for valid-time evaluation. Defaults to today.",
        },
        depth: {
          type: "number",
          minimum: 1,
          maximum: 4,
          description:
            "Ego-graph traversal depth (1–4). Default 2. Higher values widen the " +
            "candidate set but increase latency.",
        },
      },
      required: ["seed"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        settled: {
          type: "array",
          description: "Holders with no recorded contradiction in the candidate set",
          items: {
            type: "object",
            properties: {
              holder: { type: "string" },
              citations: { type: "array", items: { type: "string" } },
            },
            required: ["holder", "citations"],
          },
        },
        contested: {
          type: "array",
          description: "Positions with at least one recorded tension between candidate docs",
          items: {
            type: "object",
            properties: {
              trajectory: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    holder: { type: "string" },
                    path: { type: "string" },
                    valid_from: { type: ["string", "null"] },
                    updated: { type: "string" },
                  },
                  required: ["holder", "path", "valid_from", "updated"],
                },
              },
              hint_ordering: { type: "string", enum: ["by_valid_from"] },
            },
            required: ["trajectory", "hint_ordering"],
          },
        },
        flags: {
          type: "object",
          properties: {
            graph_completeness: {
              type: "string",
              enum: ["curated"],
              description:
                "Always 'curated': settled means no contradiction is recorded, " +
                "not that none exists.",
            },
            partial_visibility: {
              type: "boolean",
              description:
                "True when some tensions touch documents outside the caller's read scope — " +
                "the settled/contested split may be incomplete.",
            },
            hidden_tension_count: {
              type: "number",
              description: "Number of tensions hidden due to read-scope restrictions",
            },
            unindexed: {
              type: "boolean",
              description: "True when some candidate docs appear in no tension or edge",
            },
            unindexed_paths: {
              type: "array",
              items: { type: "string" },
              description: "Vault-relative paths of unindexed candidate docs",
            },
          },
          required: [
            "graph_completeness",
            "partial_visibility",
            "hidden_tension_count",
            "unindexed",
            "unindexed_paths",
          ],
        },
        // The vault_receipt over all cited paths. Null when no paths are cited
        // (empty candidate set) or when receipt construction fails (e.g. bare
        // vault without git). Resilient — never propagates the failure.
        receipt: {
          type: ["object", "null"],
          description:
            "vault_receipt over the cited documents. Null when no paths are cited or " +
            "when receipt construction fails (e.g. vault has no commits).",
          additionalProperties: true,
        },
      },
      required: ["settled", "contested", "flags"],
      additionalProperties: true,
    },
    summarize: (value: unknown): string => {
      const v = value as ComputeCanonResult;
      const settled = v.settled?.length ?? 0;
      const contested = v.contested?.length ?? 0;
      const partial = v.flags?.partial_visibility ? " (partial visibility)" : "";
      return `canon: ${settled} settled, ${contested} contested${partial}`;
    },
    handler: (vaultRoot: string, args: Record<string, unknown>, access?: AccessContext) =>
      computeCanon(
        vaultRoot,
        {
          seed: String(args.seed),
          holders: Array.isArray(args.holders) ? (args.holders as string[]) : undefined,
          asOf: typeof args.as_of === "string" ? args.as_of : undefined,
          depth: typeof args.depth === "number" ? args.depth : undefined,
        },
        access,
      ),
  },
];
