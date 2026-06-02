// src/eval/tool-surface.ts
// In-process MCP tool surface for the answerer LLM. A thin adapter over the
// existing src/tools/* handlers — no MCP serialization, no transport, no
// stdio. The answerer calls these directly via the LlmClient tool loop.
//
// vault_tension_log is INTENTIONALLY EXCLUDED: it is a write tool, and the
// answerer is strictly read-only. Exposing a write tool to the answerer would
// let it mutate the vault mid-eval, which would corrupt the measurement.
//
// access is passed as `undefined` to every handler, which bypasses RBAC. This
// is intended: eval runs locally against a snapshot, there is no user identity.

import type { Result } from "../frontmatter/types.js";
import { vaultLint, vaultTensionBlast, vaultTensionClusters } from "../tools/curation.js";
import { vaultRead } from "../tools/read.js";
import { vaultSearch, vaultSearchRelated } from "../tools/search.js";
import { vaultThemes } from "../tools/themes.js";
import type { ToolDef } from "./llm.js";

export interface ToolSurface {
  defs: ToolDef[];
  handler: (name: string, input: unknown) => Promise<unknown>;
}

// Awaits a tool handler's Result and flattens it to either the value or a
// `{ tool_error }` envelope. Never throws — a rejected promise still surfaces
// as a tool_error so the answerer can react instead of crashing the run.
async function unwrap<T>(p: Promise<Result<T, Error>>): Promise<unknown> {
  try {
    const r = await p;
    return r.ok ? r.value : { tool_error: r.error.message };
  } catch (e) {
    return { tool_error: e instanceof Error ? e.message : String(e) };
  }
}

const TOOL_DEFS: ToolDef[] = [
  {
    name: "vault_read",
    description:
      "Read a single vault document. Returns its markdown body, parsed " +
      "frontmatter, and metadata. Path is relative to the vault root.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path to the markdown file, e.g. competitive-intel/foo.md",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_search",
    description:
      "Hybrid search across the vault: BM25 lexical ranking combined with " +
      "vector semantic similarity. Returns ranked documents with snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query" },
        limit: { type: "number", description: "Maximum results to return (default 10, max 50)" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_search_related",
    description:
      "Find documents related to a given vault document. Uses that document's " +
      "own text and embeddings as the query; the document itself is excluded. " +
      "Path is relative to the vault root.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path of the reference document" },
        limit: { type: "number", description: "Maximum results to return (default 10, max 50)" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "vault_themes",
    description:
      "Surface thematic clusters across the vault using k-means over " +
      "document-pooled embeddings. Each theme reports a label, coherence " +
      "score, representative documents, and frequent tags.",
    input_schema: {
      type: "object",
      properties: {
        k: { type: "integer", description: "Optional explicit cluster count.", minimum: 1 },
        collection: {
          type: "string",
          description: "Restrict clustering to documents in this collection.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_lint",
    description:
      "Run the advisory curation checks across the vault: stale files, " +
      "orphans, old drafts, stagnant low-confidence files, deprecated files " +
      "still linked, unanswered questions, and tension health. Reports " +
      "problems; never auto-fixes. Optionally filter to a single check.",
    input_schema: {
      type: "object",
      properties: {
        filter: { type: "string", description: "Restrict the report to a single check" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_tension_blast",
    description:
      "Compute the transitive closure of downstream documents that cite or " +
      "link a contested document — or the union over a contested cluster. " +
      "Accepts exactly one of 'document' (vault-relative path) or 'cluster_id'.",
    input_schema: {
      type: "object",
      properties: {
        document: { type: "string", description: "Vault-relative path of a contested document" },
        cluster_id: {
          type: "string",
          description: "A content-addressed cluster id from vault_tension_clusters",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "vault_tension_clusters",
    description:
      "Compute connected components of the tension graph: groups of vault " +
      "documents joined transitively by unresolved tensions. Each cluster " +
      "reports its members, in-scope tension count, tally by kind, and age " +
      "range. Read-only.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
];

export function buildToolSurface(vaultRoot: string): ToolSurface {
  // biome-ignore lint/suspicious/noExplicitAny: tool inputs are structural JSON from the LLM
  const handler = async (name: string, input: any): Promise<unknown> => {
    const inp = (input as Record<string, unknown>) ?? {};
    switch (name) {
      case "vault_read":
        return unwrap(vaultRead(vaultRoot, String(inp.path ?? ""), undefined));
      case "vault_search":
        return unwrap(vaultSearch(vaultRoot, inp, undefined));
      case "vault_search_related":
        return unwrap(vaultSearchRelated(vaultRoot, inp, undefined));
      case "vault_themes":
        return unwrap(vaultThemes(vaultRoot, inp, undefined));
      case "vault_lint":
        return unwrap(vaultLint(vaultRoot, inp, undefined));
      case "vault_tension_blast":
        return unwrap(vaultTensionBlast(vaultRoot, inp, undefined));
      case "vault_tension_clusters":
        return unwrap(vaultTensionClusters(vaultRoot, inp, undefined));
      default:
        return { tool_error: `unknown tool: ${name}` };
    }
  };

  return { defs: TOOL_DEFS, handler };
}
