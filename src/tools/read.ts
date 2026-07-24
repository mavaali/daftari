// Read-path tools: vault_read, vault_index, vault_status.
//
// Each tool exposes a pure async logic function (returns Result, never throws)
// plus an MCP ToolDefinition that wraps it. server.ts registers the
// definitions; tests call the logic functions directly.

import { type AccessContext, canRead, filterByReadPermission } from "../access/rbac.js";
import { computeDecay, type DecayState } from "../curation/decay.js";
import {
  compiledUpstreamStaleness,
  loadCompiledStaleContext,
  splitUpstreamVisibility,
  type UpstreamStaleness,
} from "../curation/edge-staleness.js";
import { type ProvenanceEntry, readProvenanceLog } from "../curation/provenance.js";
import { recordRead } from "../curation/read-log.js";
import { computeStaleness } from "../curation/staleness.js";
import { type StructuralDecay, structuralDecay } from "../curation/structural.js";
import { DEFAULT_TENSION_STATUS, listTensions } from "../curation/tension.js";
import { sourceReadable, visibleTensions } from "../curation/tension-access.js";
import type { HiddenDownstream } from "../curation/tension-blast.js";
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
import { type ContestedTension, contestedFor } from "../search/contested.js";
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

// Reader-facing edge-staleness surface (#234), the decay banner's sibling:
// advisory, never blocking. `edges` lists only upstream units the caller can
// read (omission, #217); pending edges to unreadable units are coarsened
// into `hidden_pending` — never an exact count. Null when there is nothing
// to say (no compiled upstream edges visible AND no hidden pending signal),
// which is also what a document with no edges at all reports — no
// existence signal either way.
export interface UpstreamReadStaleness {
  edges: UpstreamStaleness[];
  hidden_pending: HiddenDownstream;
  // Pending-broken count among the VISIBLE edges (hidden ones only ever
  // surface through the coarse bucket above).
  pending_broken: number;
  banner: string | null;
}

export interface VaultReadResult {
  path: string;
  content: string;
  frontmatter: Frontmatter;
  raw: Record<string, unknown>;
  validation: ValidationReport;
  hasFrontmatter: boolean;
  decay: DecayState | null;
  upstream_staleness: UpstreamReadStaleness | null;
  // #8: graph-shaped decay — orphanhood and deprecated-still-linked, from
  // the materialized inbound-link graph, computed from the caller's vantage.
  // Null when there is nothing to say (same contract as `decay`).
  structural: StructuralDecay | null;
  // #8: unresolved tensions involving this document, the same shape (and
  // RBAC omission rules) as search hits' contested annotations. Absent when
  // none are visible.
  contested?: ContestedTension[];
  contestedCount?: number;
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

  // #234: classify this document's compiled upstream edges as of the serve.
  // Best-effort — the read never fails on telemetry; on a log-read error the
  // serve is still recorded, just uninstrumented (broken_upstream absent).
  //
  // Cost posture (accepted for v1): classification is derived at query time
  // from the two append-only logs, so an instrumented vault pays two log
  // scans per read — the price of having no verdict store that could itself
  // go stale. An UNinstrumented vault pays almost nothing: no consumes log
  // (or an empty one) short-circuits before the provenance log is touched,
  // since with zero compiled edges every broken count is zero. If vault
  // history ever makes the scans hurt, the escalation is an index.db mirror
  // of the logs (ephemeral, rebuildable — the edges.jsonl materialization
  // precedent), not caching bolted on here.
  const staleCtx = await loadCompiledStaleContext(vaultRoot);
  const rows: UpstreamStaleness[] | null = staleCtx
    ? compiledUpstreamStaleness(resolved.value.relPath, staleCtx.consumes, staleCtx.provenance)
    : null;

  // Every served read is logged — the broken-read rate needs its denominator
  // (#234) — and a run_id additionally joins the run's input set (#233).
  // Recorded only AFTER the RBAC gate (a denied read is never an input and
  // never a serve), under the CANONICAL relPath so the write-time join
  // matches performWrite's keying. broken_upstream is the TRUE count,
  // unfiltered by the caller's role: the log is local operator telemetry,
  // not a caller-facing surface. Best-effort: the read itself never fails
  // on a logging failure.
  await recordRead(vaultRoot, {
    tool: "vault_read",
    file: resolved.value.relPath,
    ...(runId ? { run_id: runId } : {}),
    ...(access?.user != null ? { principal: access.user } : {}),
    ...(rows
      ? { broken_upstream: rows.filter((r) => r.staleness === "pending-broken").length }
      : {}),
  });

  // One index handle serves every graph-backed enrichment below: the #234
  // visible/hidden split, structural decay (#8), and the contested join.
  // Open failure degrades every one of them to silence — all advisory.
  const db = openIndexForAccessOrNull(vaultRoot);
  let upstream: UpstreamReadStaleness | null = null;
  let structural: StructuralDecay | null = null;
  let contestedResult: { contested: ContestedTension[]; contestedCount: number } | null = null;
  try {
    // Reader-facing surface: visible edges by omission, hidden pending edges
    // coarsened (#217 — an exact count over unreadable units is a small-cell
    // existence leak). Collapses to null when there is nothing to report,
    // which is byte-identical to a document with no compiled edges at all.
    if (rows && rows.length > 0) {
      const {
        visible,
        hiddenPending,
      }: { visible: UpstreamStaleness[]; hiddenPending: HiddenDownstream } = access
        ? splitUpstreamVisibility(rows, (unit) => sourceReadable(db, access, unit))
        : { visible: rows, hiddenPending: "none" };
      if (visible.length > 0 || hiddenPending !== "none") {
        const pendingBroken = visible.filter((r) => r.staleness === "pending-broken").length;
        const notes: string[] = [];
        if (pendingBroken > 0) {
          notes.push(
            `${pendingBroken} compiled upstream input${pendingBroken === 1 ? " has" : "s have"} ` +
              `changed incompatibly since this document was compiled`,
          );
        }
        if (hiddenPending !== "none") {
          notes.push(
            `${hiddenPending} upstream inputs outside your read scope have pending changes`,
          );
        }
        upstream = {
          edges: visible,
          hidden_pending: hiddenPending,
          pending_broken: pendingBroken,
          banner: notes.length > 0 ? `${notes.join("; ")} — this content may predate them.` : null,
        };
      }
    }

    // #8: structural decay from the materialized inbound-link graph (one
    // indexed query, lint's vantage rule), plus unresolved-tension parity
    // with search's contested channel.
    structural = structuralDecay({
      db,
      path: resolved.value.relPath,
      status: parsed.value.frontmatter.status,
      access,
    });
    if (db) contestedResult = contestedFor(vaultRoot, db, resolved.value.relPath, access);
  } finally {
    db?.close();
  }

  return ok({
    path,
    content: parsed.value.content,
    frontmatter: parsed.value.frontmatter,
    raw: parsed.value.raw,
    validation: parsed.value.validation,
    hasFrontmatter: parsed.value.hasFrontmatter,
    decay: computeDecay(parsed.value.frontmatter),
    upstream_staleness: upstream,
    structural,
    ...(contestedResult
      ? { contested: contestedResult.contested, contestedCount: contestedResult.contestedCount }
      : {}),
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

// One parsed document from a whole-vault scan. Shared by vaultIndex and
// vaultStatus so a status call pays for ONE read+parse sweep, not two.
interface ScannedDoc {
  relPath: string;
  frontmatter: Frontmatter;
  valid: boolean;
}

async function scanVaultDocs(vaultRoot: string): Promise<Result<ScannedDoc[], Error>> {
  const list = await listFiles(vaultRoot);
  if (!list.ok) return list;

  const docs: ScannedDoc[] = [];
  for (const relPath of list.value) {
    const resolved = resolveVaultPath(vaultRoot, relPath);
    if (!resolved.ok) continue;
    const file = await readFile(resolved.value.absPath);
    if (!file.ok) continue;
    const parsed = parseDocument(file.value);
    if (!parsed.ok) continue;
    docs.push({
      relPath,
      frontmatter: parsed.value.frontmatter,
      valid: parsed.value.validation.valid,
    });
  }
  return ok(docs);
}

function toIndexEntry(doc: ScannedDoc): VaultIndexEntry {
  const fm = doc.frontmatter;
  return {
    path: doc.relPath,
    title: fm.title,
    collection: collectionOf(doc.relPath, fm),
    domain: fm.domain,
    status: fm.status,
    confidence: fm.confidence,
    updated: fm.updated,
    tags: fm.tags,
    questionsAnswered: fm.questions_answered,
    questionsRaised: fm.questions_raised,
    valid: doc.valid,
  };
}

function matchesIndexFilters(doc: ScannedDoc, filters: VaultIndexFilters): boolean {
  const fm = doc.frontmatter;
  if (filters.collection && collectionOf(doc.relPath, fm) !== filters.collection) return false;
  if (filters.status && fm.status !== filters.status) return false;
  if (filters.domain && fm.domain !== filters.domain) return false;
  if (filters.tags && filters.tags.length > 0 && !filters.tags.every((t) => fm.tags.includes(t))) {
    return false;
  }
  if (filters.hasUnanswered !== undefined) {
    if (fm.questions_raised.length > 0 !== filters.hasUnanswered) return false;
  }
  return true;
}

export async function vaultIndex(
  vaultRoot: string,
  filters: VaultIndexFilters = {},
  access?: AccessContext,
): Promise<Result<VaultIndexResult, Error>> {
  const docs = await scanVaultDocs(vaultRoot);
  if (!docs.ok) return docs;

  const entries = docs.value.filter((d) => matchesIndexFilters(d, filters)).map(toIndexEntry);

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
  // vault_status reports only over the documents the role can read. ONE
  // whole-vault scan feeds both the index-shaped aggregates and the staleness
  // distribution — scoring from the already-parsed frontmatter instead of a
  // second read+parse sweep through listStaleFiles.
  const scan = await scanVaultDocs(vaultRoot);
  if (!scan.ok) return scan;
  const allEntries = scan.value.map(toIndexEntry);
  const visibleEntries = access ? filterByReadPermission(access.role, allEntries) : allEntries;
  const index = { value: { count: visibleEntries.length, entries: visibleEntries } };

  const byCollection = new Map<string, number>();
  let invalidCount = 0;
  for (const entry of index.value.entries) {
    byCollection.set(entry.collection, (byCollection.get(entry.collection) ?? 0) + 1);
    if (!entry.valid) invalidCount += 1;
  }

  const collections = [...byCollection.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([collection, count]) => ({ collection, count }));

  // Staleness distribution over the visible set, from the same scan. One
  // shared instant scores every document (as listStaleFiles did) so two docs
  // straddling a UTC day boundary mid-scan can't bucket inconsistently.
  const scanNow = new Date();
  const visiblePaths = new Set(index.value.entries.map((e) => e.path));
  const stalenessDistribution: StalenessDistribution = {
    fresh: 0,
    aging: 0,
    stale: 0,
    total: 0,
  };
  for (const doc of scan.value) {
    if (!visiblePaths.has(doc.relPath)) continue;
    stalenessDistribution.total += 1;
    const score = computeStaleness(
      {
        updated: doc.frontmatter.updated,
        ttl_days: doc.frontmatter.ttl_days,
      },
      scanNow,
    ).score;
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
      "healthy; otherwise level, reasons, and an optional banner), an " +
      "upstream_staleness report (#234 — per compiled input, whether it " +
      "changed since this document was compiled and what tier 1 says about " +
      "the pending change: current / pending-compatible / pending-broken; " +
      "null when there is nothing to report), a structural report (#8 — " +
      "orphan: nothing you can read links here; deprecated_still_linked: " +
      "canonical docs still lean on this deprecated one; null when healthy), " +
      "any unresolved tensions involving the document (contested, same " +
      "shape as search hits), and a 'version' token (SHA-256 of the file) " +
      "that can be passed back to a write tool as 'base_version' for " +
      "optimistic-concurrency checking. Path is relative to the vault root.",
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
