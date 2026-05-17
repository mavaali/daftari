// Read-path tools: vault_read, vault_index, vault_status.
//
// Each tool exposes a pure async logic function (returns Result, never throws)
// plus an MCP ToolDefinition that wraps it. server.ts registers the
// definitions; tests call the logic functions directly.

import { type AccessContext, canRead, filterByReadPermission } from "../access/rbac.js";
import { computeDecay, type DecayState } from "../curation/decay.js";
import { type ProvenanceEntry, readProvenanceLog } from "../curation/provenance.js";
import { listStaleFiles } from "../curation/staleness.js";
import { DEFAULT_TENSION_STATUS, listTensions } from "../curation/tension.js";
import { parseDocument } from "../frontmatter/parser.js";
import {
  DOMAINS,
  err,
  type Frontmatter,
  ok,
  type Result,
  STATUSES,
  type ValidationReport,
} from "../frontmatter/types.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // `access` is supplied by the server transport on every call. When omitted
  // (a direct in-process call, e.g. from a test) RBAC is not enforced.
  handler: (
    vaultRoot: string,
    args: Record<string, unknown>,
    access?: AccessContext,
  ) => Promise<Result<unknown, Error>>;
}

// ---------------------------------------------------------------------------
// vault_read
// ---------------------------------------------------------------------------

export interface VaultReadResult {
  path: string;
  content: string;
  frontmatter: Frontmatter;
  raw: Record<string, unknown>;
  validation: ValidationReport;
  hasFrontmatter: boolean;
  decay: DecayState | null;
}

export async function vaultRead(
  vaultRoot: string,
  path: string,
  access?: AccessContext,
): Promise<Result<VaultReadResult, Error>> {
  if (typeof path !== "string" || path.length === 0) {
    return err(new Error("vault_read requires a non-empty 'path' argument"));
  }
  const resolved = resolveVaultPath(vaultRoot, path);
  if (!resolved.ok) return resolved;

  const file = await readFile(resolved.value);
  if (!file.ok) return file;

  const parsed = parseDocument(file.value);
  if (!parsed.ok) return parsed;

  if (access) {
    const collection = collectionOf(path, parsed.value.frontmatter);
    if (!canRead(access.role, collection)) {
      return err(
        new Error(
          `access denied: role '${access.roleName}' cannot read ` + `collection '${collection}'`,
        ),
      );
    }
  }

  return ok({
    path,
    content: parsed.value.content,
    frontmatter: parsed.value.frontmatter,
    raw: parsed.value.raw,
    validation: parsed.value.validation,
    hasFrontmatter: parsed.value.hasFrontmatter,
    decay: computeDecay(parsed.value.frontmatter),
  });
}

// ---------------------------------------------------------------------------
// vault_index
// ---------------------------------------------------------------------------

export interface VaultIndexFilters {
  collection?: string;
  status?: string;
  domain?: string;
  tags?: string[];
}

export interface VaultIndexEntry {
  path: string;
  title: string;
  collection: string;
  domain: string;
  status: string;
  confidence: string;
  updated: string;
  tags: string[];
  valid: boolean;
}

export interface VaultIndexResult {
  count: number;
  entries: VaultIndexEntry[];
}

// A document's collection is its frontmatter `collection`, falling back to the
// top-level directory of its vault-relative path.
function collectionOf(relPath: string, fm: Frontmatter): string {
  if (fm.collection) return fm.collection;
  const top = relPath.split("/")[0];
  return top ?? "";
}

export async function vaultIndex(
  vaultRoot: string,
  filters: VaultIndexFilters = {},
  access?: AccessContext,
): Promise<Result<VaultIndexResult, Error>> {
  const list = await listFiles(vaultRoot);
  if (!list.ok) return list;

  const entries: VaultIndexEntry[] = [];
  for (const relPath of list.value) {
    const resolved = resolveVaultPath(vaultRoot, relPath);
    if (!resolved.ok) continue;
    const file = await readFile(resolved.value);
    if (!file.ok) continue;
    const parsed = parseDocument(file.value);
    if (!parsed.ok) continue;

    const fm = parsed.value.frontmatter;
    const collection = collectionOf(relPath, fm);

    if (filters.collection && collection !== filters.collection) continue;
    if (filters.status && fm.status !== filters.status) continue;
    if (filters.domain && fm.domain !== filters.domain) continue;
    if (filters.tags && filters.tags.length > 0) {
      const hasAll = filters.tags.every((t) => fm.tags.includes(t));
      if (!hasAll) continue;
    }

    entries.push({
      path: relPath,
      title: fm.title,
      collection,
      domain: fm.domain,
      status: fm.status,
      confidence: fm.confidence,
      updated: fm.updated,
      tags: fm.tags,
      valid: parsed.value.validation.valid,
    });
  }

  // RBAC: drop documents in collections the role cannot read.
  const visible = access ? filterByReadPermission(access.role, entries) : entries;
  return ok({ count: visible.length, entries: visible });
}

// ---------------------------------------------------------------------------
// vault_status
// ---------------------------------------------------------------------------

// Vault files bucketed by decay score: fresh (< 0.5 of TTL elapsed), aging
// (>= 0.5, not yet expired), stale (>= 1.0 — at or past TTL). `total` is the
// number of files scored, which equals the role's visible file count.
export interface StalenessDistribution {
  fresh: number;
  aging: number;
  stale: number;
  total: number;
}

export interface TensionSummary {
  title: string;
  date: string;
}

export interface UnresolvedTensions {
  count: number;
  recent: TensionSummary[];
}

export interface RecentWrites {
  count: number;
  entries: ProvenanceEntry[];
}

export interface VaultStatusResult {
  vault: string;
  fileCount: number;
  collections: { collection: string; count: number }[];
  invalidCount: number;
  generatedAt: string;
  stalenessDistribution: StalenessDistribution;
  unresolvedTensions: UnresolvedTensions;
  recentWrites: RecentWrites;
}

// The collection a bare vault-relative path belongs to: its top-level
// directory. tension/provenance records carry only a path (no frontmatter),
// so RBAC on those falls back to this path-based collection.
function topCollection(relPath: string): string {
  return relPath.split("/")[0] ?? "";
}

export async function vaultStatus(
  vaultRoot: string,
  access?: AccessContext,
): Promise<Result<VaultStatusResult, Error>> {
  // vault_status reports only over the documents the role can read.
  const index = await vaultIndex(vaultRoot, {}, access);
  if (!index.ok) return index;

  const byCollection = new Map<string, number>();
  let invalidCount = 0;
  for (const entry of index.value.entries) {
    byCollection.set(entry.collection, (byCollection.get(entry.collection) ?? 0) + 1);
    if (!entry.valid) invalidCount += 1;
  }

  const collections = [...byCollection.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([collection, count]) => ({ collection, count }));

  // Staleness: score every file, then keep only those the index already
  // deemed visible, so the distribution honours RBAC. Threshold 0 makes
  // listStaleFiles return every document with its decay score.
  const visiblePaths = new Set(index.value.entries.map((e) => e.path));
  const staleScan = await listStaleFiles(vaultRoot, 0);
  if (!staleScan.ok) return staleScan;

  const stalenessDistribution: StalenessDistribution = {
    fresh: 0,
    aging: 0,
    stale: 0,
    total: 0,
  };
  for (const file of staleScan.value) {
    if (!visiblePaths.has(file.path)) continue;
    stalenessDistribution.total += 1;
    const score = file.staleness.score;
    if (score >= 1) stalenessDistribution.stale += 1;
    else if (score >= 0.5) stalenessDistribution.aging += 1;
    else stalenessDistribution.fresh += 1;
  }

  // Unresolved tensions. A tension links two files; with an access context we
  // show it only when the role can read the collections of BOTH sources, so
  // the dashboard never leaks the existence of a doc in a denied collection.
  const tensions = await listTensions(vaultRoot, DEFAULT_TENSION_STATUS);
  if (!tensions.ok) return tensions;
  const visibleTensions = access
    ? tensions.value.filter(
        (t) =>
          canRead(access.role, topCollection(t.sourceA)) &&
          canRead(access.role, topCollection(t.sourceB)),
      )
    : tensions.value;
  const recentTensions = [...visibleTensions]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5)
    .map((t) => ({ title: t.title, date: t.date }));

  // Recent writes from the provenance log (oldest first in the file). Each
  // entry is gated by the role's read access to the written file's collection.
  const log = await readProvenanceLog(vaultRoot);
  if (!log.ok) return log;
  const visibleWrites = access
    ? log.value.filter((e) => canRead(access.role, topCollection(e.file)))
    : log.value;

  return ok({
    vault: vaultRoot,
    fileCount: index.value.count,
    collections,
    invalidCount,
    generatedAt: new Date().toISOString(),
    stalenessDistribution,
    unresolvedTensions: {
      count: visibleTensions.length,
      recent: recentTensions,
    },
    recentWrites: {
      count: visibleWrites.length,
      entries: visibleWrites.slice(-10),
    },
  });
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

export const readTools: ToolDefinition[] = [
  {
    name: "vault_read",
    description:
      "Read a single vault document. Returns its markdown body, parsed " +
      "frontmatter, a validation report, and a decay assessment (null when " +
      "healthy; otherwise level, reasons, and an optional banner). Path is " +
      "relative to the vault root.",
    inputSchema: {
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
    handler: (vaultRoot, args, access) => vaultRead(vaultRoot, String(args.path ?? ""), access),
  },
  {
    name: "vault_index",
    description:
      "List vault documents with their metadata. Optionally filter by " +
      "collection, status, domain, or tags (tags match is conjunctive).",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Filter by collection name" },
        status: {
          type: "string",
          enum: [...STATUSES],
          description: "Filter by document status",
        },
        domain: {
          type: "string",
          enum: [...DOMAINS],
          description: "Filter by domain",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter to documents that have all of these tags",
        },
      },
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) =>
      vaultIndex(
        vaultRoot,
        {
          collection: asString(args.collection),
          status: asString(args.status),
          domain: asString(args.domain),
          tags: asStringArray(args.tags),
        },
        access,
      ),
  },
  {
    name: "vault_status",
    description:
      "Vault health dashboard: total file count, per-collection counts, " +
      "count of documents with invalid frontmatter, a staleness distribution " +
      "(fresh/aging/stale), unresolved tensions, and recent write history.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: (vaultRoot, _args, access) => vaultStatus(vaultRoot, access),
  },
];
