// Search-path tools: vault_search, vault_search_related, vault_reindex.
//
// Like the read-path tools, each exposes a pure logic function (returns
// Result, never throws) plus an MCP ToolDefinition. The logic functions own
// the index-db lifecycle: they open the SQLite index, run the query, and close
// it. If the index is empty (first run after a fresh clone) they trigger a
// reindex first, so search works without an explicit setup step.

import { ok, type Result } from "../frontmatter/types.js";
import { documentCount, openIndexDb } from "../storage/index-db.js";
import {
  DEFAULT_WEIGHTS,
  hybridSearch,
  relatedSearch,
  type HybridSearchResult,
  type HybridWeights,
  type RelatedSearchResult,
} from "../search/hybrid.js";
import { reindexVault, type ReindexResult } from "../search/reindex.js";
import { canRead, type AccessContext } from "../access/rbac.js";
import type { ToolDefinition } from "./read.js";

// Builds the index if it has never been built. A populated index is left as-is
// — callers wanting a refresh use vault_reindex explicitly.
async function ensureIndexed(vaultRoot: string): Promise<Result<void, Error>> {
  const dbResult = openIndexDb(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const empty = documentCount(dbResult.value) === 0;
  dbResult.value.close();
  if (empty) {
    const reindexed = await reindexVault(vaultRoot);
    if (!reindexed.ok) return reindexed;
  }
  return ok(undefined);
}

function parseWeights(raw: unknown): HybridWeights {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const bm25 = obj.bm25;
    const vector = obj.vector;
    if (
      typeof bm25 === "number" &&
      typeof vector === "number" &&
      bm25 >= 0 &&
      vector >= 0 &&
      bm25 + vector > 0
    ) {
      return { bm25, vector };
    }
  }
  return DEFAULT_WEIGHTS;
}

function parseLimit(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.floor(raw), 50);
  }
  return 10;
}

// ---------------------------------------------------------------------------
// vault_search
// ---------------------------------------------------------------------------

export async function vaultSearch(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<HybridSearchResult, Error>> {
  const query = args.query;
  if (typeof query !== "string" || query.trim().length === 0) {
    return {
      ok: false,
      error: new Error("vault_search requires a non-empty 'query' argument"),
    };
  }

  const ready = await ensureIndexed(vaultRoot);
  if (!ready.ok) return ready;

  const dbResult = openIndexDb(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;
  try {
    const result = await hybridSearch(db, query, {
      weights: parseWeights(args.weights),
      limit: parseLimit(args.limit),
    });
    if (!result.ok || !access) return result;
    // RBAC: drop hits in collections the role cannot read.
    const hits = result.value.hits.filter((h) =>
      canRead(access.role, h.collection),
    );
    return ok({ ...result.value, count: hits.length, hits });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// vault_search_related
// ---------------------------------------------------------------------------

export async function vaultSearchRelated(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<RelatedSearchResult, Error>> {
  const path = args.path;
  if (typeof path !== "string" || path.trim().length === 0) {
    return {
      ok: false,
      error: new Error(
        "vault_search_related requires a non-empty 'path' argument",
      ),
    };
  }

  const ready = await ensureIndexed(vaultRoot);
  if (!ready.ok) return ready;

  const dbResult = openIndexDb(vaultRoot);
  if (!dbResult.ok) return dbResult;
  const db = dbResult.value;
  try {
    const result = relatedSearch(db, path, {
      weights: parseWeights(args.weights),
      limit: parseLimit(args.limit),
    });
    if (!result.ok || !access) return result;
    // RBAC: drop related hits in collections the role cannot read.
    const hits = result.value.hits.filter((h) =>
      canRead(access.role, h.collection),
    );
    return ok({ ...result.value, count: hits.length, hits });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// vault_reindex
// ---------------------------------------------------------------------------

export interface VaultReindexResult extends ReindexResult {
  vault: string;
}

export async function vaultReindex(
  vaultRoot: string,
): Promise<Result<VaultReindexResult, Error>> {
  const result = await reindexVault(vaultRoot);
  if (!result.ok) return result;
  return ok({ ...result.value, vault: vaultRoot });
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

const weightsSchema = {
  type: "object",
  description:
    "Optional ranking weights. Defaults to an even bm25/vector split.",
  properties: {
    bm25: { type: "number", description: "Lexical (BM25) weight, >= 0" },
    vector: { type: "number", description: "Semantic (vector) weight, >= 0" },
  },
  additionalProperties: false,
};

export const searchTools: ToolDefinition[] = [
  {
    name: "vault_search",
    description:
      "Hybrid search across the vault: BM25 lexical ranking combined with " +
      "vector semantic similarity. Returns ranked documents with snippets. " +
      "Falls back to lexical-only ranking if embeddings are unavailable.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query" },
        limit: {
          type: "number",
          description: "Maximum results to return (default 10, max 50)",
        },
        weights: weightsSchema,
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultSearch(vaultRoot, args, access),
  },
  {
    name: "vault_search_related",
    description:
      "Find documents related to a given vault document. Uses that " +
      "document's own text and embeddings as the query; the document itself " +
      "is excluded from results. Path is relative to the vault root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path of the reference document",
        },
        limit: {
          type: "number",
          description: "Maximum results to return (default 10, max 50)",
        },
        weights: weightsSchema,
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) =>
      vaultSearchRelated(vaultRoot, args, access),
  },
  {
    name: "vault_reindex",
    description:
      "Rebuild the search index from the markdown files on disk. The index " +
      "is a derived cache; this clears and rebuilds it, re-embedding all " +
      "document chunks. Run after bulk edits made outside Daftari.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: (vaultRoot) => vaultReindex(vaultRoot),
  },
];
