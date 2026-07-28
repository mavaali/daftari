// vault_consumes — the query surface over the compiled dependency graph
// (#233). Forward: the units an artifact's current compile consumed.
// Reverse: the artifacts whose current compile consumed a unit. History:
// every compile group ever minted for the anchor, superseded ones included.
//
// RBAC (#217, same rule as vault_edges): the tool gates on any-read; an edge
// names two documents, so it is listed only when the caller can read BOTH
// endpoints' collections — invisible edges are omitted entirely from the
// list and the total, never redacted and never counted. A query anchored on
// an unreadable path returns an empty listing, identical to a nonexistent
// one — no existence confirmation either way.

import { type AccessContext, hasAnyRead } from "../access/rbac.js";
import {
  CONSUMES_EDGE_TYPES,
  type ConsumesEdge,
  currentConsumesEdges,
  listConsumesEdges,
} from "../curation/consumes.js";
import { sourceReadable } from "../curation/tension-access.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { canonicalVaultRelPath } from "../storage/local.js";
import type { ToolDefinition } from "./read.js";
import { openIndexForAccessOrNull } from "./search.js";
import { SUMMARY_MAX_ROWS } from "./summary.js";

export interface ConsumesResult {
  direction: "forward" | "reverse";
  anchor: string;
  edges: ConsumesEdge[];
  total: number;
  include_history: boolean;
}

export async function vaultConsumes(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<ConsumesResult, Error>> {
  if (access && !hasAnyRead(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot use vault_consumes`));
  }

  const artifact = args.artifact;
  const unit = args.unit;
  const anchorRaw = typeof artifact === "string" ? artifact : typeof unit === "string" ? unit : "";
  if ((artifact === undefined) === (unit === undefined) || anchorRaw.trim().length === 0) {
    return err(
      new Error(
        "vault_consumes takes exactly one of 'artifact' (forward: what did it " +
          "consume) or 'unit' (reverse: who consumed it), as a non-empty string",
      ),
    );
  }
  const direction = typeof artifact === "string" ? "forward" : "reverse";

  const anchor = canonicalVaultRelPath(vaultRoot, anchorRaw);
  if (!anchor.ok) return anchor;

  let includeHistory = false;
  if (args.include_history !== undefined && args.include_history !== null) {
    if (typeof args.include_history !== "boolean") {
      return err(new Error("vault_consumes 'include_history' must be a boolean"));
    }
    includeHistory = args.include_history;
  }

  const all = await listConsumesEdges(vaultRoot);
  if (!all.ok) return all;

  const pool = includeHistory ? all.value : currentConsumesEdges(all.value);
  let edges = pool.filter((e) =>
    direction === "forward" ? e.artifact === anchor.value : e.unit === anchor.value,
  );

  // #217 decision A: plain omission, both endpoints must be readable.
  if (access) {
    const db = openIndexForAccessOrNull(vaultRoot);
    try {
      edges = edges.filter(
        (e) => sourceReadable(db, access, e.artifact) && sourceReadable(db, access, e.unit),
      );
    } finally {
      db?.close();
    }
  }

  return ok({
    direction,
    anchor: anchor.value,
    edges,
    total: edges.length,
    include_history: includeHistory,
  });
}

// One compiled edge (ConsumesEdge), exactly as the log records it.
const consumesEdgeSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    artifact: { type: "string", description: "Vault-relative path of the written document" },
    unit: {
      type: "string",
      description: "Vault-relative path of a document the run read before writing the artifact",
    },
    edge_type: {
      type: "string",
      enum: [...CONSUMES_EDGE_TYPES],
      description: "The consumption mode the producer observed",
    },
    fields: {
      type: "array",
      items: { type: "string" },
      description: "Fields consumed; ['*'] means the whole document (v1)",
    },
    run_id: { type: "string", description: "Trace/run identifier that minted the edge" },
    compile_ts: { type: "string", description: "ISO 8601 — when the write landed" },
  },
  required: ["artifact", "unit", "edge_type", "fields", "run_id", "compile_ts"],
};

// ---------------------------------------------------------------------------
// Compact `content` summary + resource links (spec 2026-07-26, Decision 3,
// PR 1 gap closure)
// ---------------------------------------------------------------------------

function summarizeConsumes(value: unknown): string {
  const r = value as ConsumesResult;
  if (r.total === 0) return `0 ${r.direction} edges for ${r.anchor}.`;
  const shown = r.edges.slice(0, SUMMARY_MAX_ROWS);
  const lines = [
    `${r.total} ${r.direction} edge(s) for ${r.anchor}` +
      (r.include_history ? " (history included):" : ":"),
    ...shown.map((e) => `  ${e.artifact} ← ${e.unit} (${e.edge_type})`),
  ];
  const rest = r.total - shown.length;
  if (rest > 0) lines.push(`  … ${rest} more in structuredContent`);
  return lines.join("\n");
}

function docLinksConsumes(value: unknown): string[] {
  const r = value as ConsumesResult;
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const e of r.edges.slice(0, SUMMARY_MAX_ROWS)) {
    for (const p of [e.artifact, e.unit]) {
      if (seen.has(p)) continue;
      seen.add(p);
      paths.push(p);
    }
  }
  return paths;
}

export const consumesTools: ToolDefinition[] = [
  {
    name: "vault_consumes",
    title: "Query the compiled dependency graph",
    oneLine: "Query the compiled consumes graph: what a document read, or what reads it.",
    annotations: { readOnlyHint: true },
    description:
      "Query the compiled consumes graph (#233): edges minted mechanically " +
      "from run correlation — a write carrying a run_id consumes every " +
      "document the same run read beforehand. Pass 'artifact' for the " +
      "forward query (what did this document's current compile consume) or " +
      "'unit' for the reverse query (which artifacts' current compiles " +
      "consumed this document — the dependents a change may break). " +
      "include_history: true returns every compile group ever minted for " +
      "the anchor, not just the current one. Compiled edges are certain " +
      "provenance (the run demonstrably read the unit), unlike declared " +
      "sources or earned derives_from edges.",
    inputSchema: {
      type: "object",
      properties: {
        artifact: {
          type: "string",
          description: "Vault-relative path — forward query: inputs of this document",
        },
        unit: {
          type: "string",
          description: "Vault-relative path — reverse query: dependents of this document",
        },
        include_history: {
          type: "boolean",
          description: "Include superseded compile groups (default false: current only)",
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["forward", "reverse"],
          description: "Which query ran: 'forward' for 'artifact', 'reverse' for 'unit'",
        },
        anchor: { type: "string", description: "Canonical vault-relative path of the anchor" },
        edges: { type: "array", items: consumesEdgeSchema },
        total: {
          type: "integer",
          description:
            "Number of listed edges. Under RBAC an edge with an unreadable " +
            "endpoint is omitted from the list AND from this count (#217 omission).",
        },
        include_history: {
          type: "boolean",
          description: "Whether superseded compile groups were included",
        },
      },
      required: ["direction", "anchor", "edges", "total", "include_history"],
    },
    summarize: summarizeConsumes,
    docLinks: docLinksConsumes,
    handler: (vaultRoot, args, access) => vaultConsumes(vaultRoot, args, access),
  },
];
