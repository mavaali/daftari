// Read-path tools: vault_read, vault_index, vault_status.
//
// Each tool exposes a pure async logic function (returns Result, never throws)
// plus an MCP ToolDefinition that wraps it. server.ts registers the
// definitions; tests call the logic functions directly.

import { type AccessContext, canRead, filterByReadPermission } from "../access/rbac.js";
import { computeDecay, type DecayState } from "../curation/decay.js";
import { type ProvenanceEntry, readProvenanceLog } from "../curation/provenance.js";
import { recordRead } from "../curation/read-log.js";
import { listStaleFiles } from "../curation/staleness.js";
import { DEFAULT_TENSION_STATUS, listTensions } from "../curation/tension.js";
import { sourceReadable, visibleTensions } from "../curation/tension-access.js";
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
import { getProvider } from "../search/vector.js";
import { countDimMismatches, openIndexDb } from "../storage/index-db.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";
import { sha256Hex } from "../utils/hash.js";
import { readRunId } from "../utils/run-id.js";
import { openIndexForAccessOrNull } from "./search.js";

// Tool-annotation hints surfaced to MCP clients. The MCP spec treats these as
// *hints* — clients must not gate behavior on them — but directory reviewers
// require every tool to declare its safety profile, so we set them
// deliberately on each definition.
export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  // Human-readable title surfaced in UIs (Claude Desktop, the connectors
  // directory). `name` stays machine-style; `title` is for humans.
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
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
  // SHA-256 (hex) of the raw file bytes, frontmatter included. A caller passes
  // this back as a write tool's `base_version` to detect a stale write.
  version: string;
}

export async function vaultRead(
  vaultRoot: string,
  path: string,
  access?: AccessContext,
  runId?: string,
): Promise<Result<VaultReadResult, Error>> {
  if (typeof path !== "string" || path.length === 0) {
    return err(new Error("vault_read requires a non-empty 'path' argument"));
  }
  const resolved = resolveVaultPath(vaultRoot, path);
  if (!resolved.ok) return resolved;

  const file = await readFile(resolved.value.absPath);
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

  // #233: a run-correlated read joins the run's input set — a later write by
  // the same run mints consumes edges from it. Recorded only AFTER the RBAC
  // gate (a denied read is never an input), under the CANONICAL relPath so
  // the write-time join matches performWrite's keying. Best-effort: the read
  // itself never fails on a logging failure.
  if (runId) {
    await recordRead(vaultRoot, {
      tool: "vault_read",
      file: resolved.value.relPath,
      run_id: runId,
      ...(access?.user != null ? { principal: access.user } : {}),
    });
  }

  return ok({
    path,
    content: parsed.value.content,
    frontmatter: parsed.value.frontmatter,
    raw: parsed.value.raw,
    validation: parsed.value.validation,
    hasFrontmatter: parsed.value.hasFrontmatter,
    decay: computeDecay(parsed.value.frontmatter),
    version: sha256Hex(file.value),
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
  // When set, keep only documents that have (true) or do not have (false)
  // open questions in `questions_raised`.
  hasUnanswered?: boolean;
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
  questionsAnswered: string[];
  questionsRaised: string[];
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
    const file = await readFile(resolved.value.absPath);
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
    if (filters.hasUnanswered !== undefined) {
      if (fm.questions_raised.length > 0 !== filters.hasUnanswered) continue;
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
      questionsAnswered: fm.questions_answered,
      questionsRaised: fm.questions_raised,
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
  // Number of embedding cache rows for the active model whose stored dim
  // does not match the current provider's dim. A non-zero value means those
  // chunks will be silently skipped in vector ranking; this field surfaces
  // the condition so the operator can investigate rather than wonder why
  // search quality is degraded.
  embeddingDimMismatches: number;
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

  // Unresolved tensions and provenance entries carry only a path (no
  // frontmatter), so RBAC on them goes through the shared source predicates
  // (canonicalized — an alias must not widen visibility). A tension shows
  // only when the role can read BOTH sources; a write entry when it can read
  // the written file. Neither leaks the existence of a doc in a denied
  // collection.
  const tensions = await listTensions(vaultRoot, DEFAULT_TENSION_STATUS);
  if (!tensions.ok) return tensions;
  const log = await readProvenanceLog(vaultRoot);
  if (!log.ok) return log;

  let tensionEntries = tensions.value;
  let visibleWrites = log.value;
  if (access) {
    const accessDb = openIndexForAccessOrNull(vaultRoot);
    try {
      tensionEntries = visibleTensions(accessDb, tensions.value, access);
      visibleWrites = log.value.filter((e) => sourceReadable(accessDb, access, e.file));
    } finally {
      accessDb?.close();
    }
  }
  const recentTensions = [...tensionEntries]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5)
    .map((t) => ({ title: t.title, date: t.date }));

  // Dim-mismatch counter. A non-zero value means some embedding cache rows
  // for the active model have the wrong dim and are being silently skipped
  // by vector ranking. We open the DB defensively — if sqlite-vec isn't
  // installed or the index hasn't been built yet, the field is 0.
  const provider = getProvider();
  let embeddingDimMismatches = 0;
  const dbResult = openIndexDb(vaultRoot, provider.dim);
  if (dbResult.ok) {
    try {
      embeddingDimMismatches = countDimMismatches(dbResult.value, provider.id, provider.dim);
    } finally {
      dbResult.value.close();
    }
  }

  return ok({
    vault: vaultRoot,
    fileCount: index.value.count,
    collections,
    invalidCount,
    generatedAt: new Date().toISOString(),
    stalenessDistribution,
    unresolvedTensions: {
      count: tensionEntries.length,
      recent: recentTensions,
    },
    recentWrites: {
      count: visibleWrites.length,
      entries: visibleWrites.slice(-10),
    },
    embeddingDimMismatches,
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
    title: "Read a vault document",
    annotations: { readOnlyHint: true },
    description:
      "Read a single vault document. Returns its markdown body, parsed " +
      "frontmatter, a validation report, a decay assessment (null when " +
      "healthy; otherwise level, reasons, and an optional banner), and a " +
      "'version' token (SHA-256 of the file) that can be passed back to a " +
      "write tool as 'base_version' for optimistic-concurrency checking. " +
      "Path is relative to the vault root.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Vault-relative path to the markdown file, e.g. competitive-intel/foo.md",
        },
        run_id: {
          type: "string",
          description:
            "Optional trace/run identifier of the calling run. Recorded in " +
            "the read log so a later write by the same run compiles this " +
            "document into its consumes edges (#233).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => {
      const runId = readRunId(args, "vault_read");
      if (!runId.ok) return Promise.resolve(runId);
      return vaultRead(vaultRoot, String(args.path ?? ""), access, runId.value);
    },
  },
  {
    name: "vault_index",
    title: "List vault documents",
    annotations: { readOnlyHint: true },
    description:
      "List vault documents with their metadata, including each document's " +
      "questions_answered / questions_raised. Optionally filter by collection, " +
      "status, domain, tags (conjunctive), or has_unanswered.",
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
        has_unanswered: {
          type: "boolean",
          description:
            "true: only documents with open questions in questions_raised; " +
            "false: only documents with none",
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
          hasUnanswered: typeof args.has_unanswered === "boolean" ? args.has_unanswered : undefined,
        },
        access,
      ),
  },
  {
    name: "vault_status",
    title: "Vault health dashboard",
    annotations: { readOnlyHint: true },
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
