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
import { DEFAULT_TENSION_STATUS, listTensions, TENSION_KINDS } from "../curation/tension.js";
import { sourceReadable, visibleTensions } from "../curation/tension-access.js";
import type { HiddenDownstream } from "../curation/tension-blast.js";
import { computeValidity, type ValidityReport } from "../curation/validity.js";
import { parseDocument } from "../frontmatter/parser.js";
import {
  CONFIDENCES,
  DOMAINS,
  err,
  type Frontmatter,
  ok,
  PROVENANCES,
  type Result,
  STATUSES,
  TIERS,
  type ValidationReport,
} from "../frontmatter/types.js";
import { type ContestedTension, contestedFor } from "../search/contested.js";
import { getProvider, getQuantize } from "../search/vector.js";
import { countDimMismatches, openIndexDb } from "../storage/index-db.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";
import { sha256Hex } from "../utils/hash.js";
import { readRunId } from "../utils/run-id.js";
import { openIndexForAccessOrNull } from "./search.js";
import { SUMMARY_MAX_ROWS } from "./summary.js";

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
  // JSON Schema (2020-12) for the handler's ok-value. Required: handlers
  // already return typed values, so an unschematized output is a type we
  // were too lazy to write down (spec 2026-07-26, Decision 3).
  outputSchema: Record<string, unknown>;
  // Compact model-facing summary for the `content` channel. Absent, the
  // bridge falls back to pretty-printed JSON of the full value.
  summarize?: (value: unknown) => string;
  // Vault-relative doc paths the result references; the bridge emits a
  // daftari://doc/{path} resource_link per entry. Paths must already be
  // read-gated by the handler (links inherit read-gating by construction).
  docLinks?: (value: unknown) => string[];
  // Projects the full ok-value down to what rides `structuredContent`
  // (spec 2026-07-26, Decision 3 / C11). Absent, the bridge ships the value
  // verbatim. Exists so a tool whose body-shaped payload already rides
  // `content` in full (vault_read) does not ship it a second time on
  // structuredContent — the wire's worst token offender, doubled, in the PR
  // whose purpose is cutting waste. `summarize`/`docLinks` still see the
  // FULL value; only the wire projection is narrowed.
  wireValue?: (value: unknown) => Record<string, unknown>;
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
  // Valid time: whether the document's claim holds TODAY, as opposed to
  // whether the document is fresh (that is `decay`). Null when neither
  // endpoint is authored — the same nothing-to-say contract `decay` follows.
  // Deliberately a sibling of `decay` rather than folded into it: an expired
  // interval must not promote a document to a decay level, because
  // consolidate/admit.ts treats `warn` as edge-blocking.
  validity: ValidityReport | null;
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
    // Evaluated against today. No index access and no RBAC branch — these
    // fields belong to a document the caller has already been permitted to
    // read.
    validity: computeValidity(parsed.value.frontmatter, new Date().toISOString().slice(0, 10)),
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
//
// Exported because the MCP resource layer (src/resources.ts) gates
// `resources/read` on the same predicate vault_read uses. One visibility rule,
// not two that can drift apart.
export function collectionOf(relPath: string, fm: Frontmatter): string {
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

// Adoption monitor for the valid-time axis. A READ-ONLY signal, never a
// target: valid time is authored, so driving this number up by any means
// other than someone knowing the dates would defeat the point. Follows the
// coverageEquity posture — report it, do not optimize it.
export interface ValidityCoverage {
  authored: number; // at least one endpoint set
  unknown: number; // both endpoints absent
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
  validityCoverage: ValidityCoverage;
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
  const indexEntries = { count: visibleEntries.length, entries: visibleEntries };

  const byCollection = new Map<string, number>();
  let invalidCount = 0;
  for (const entry of indexEntries.entries) {
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
  const visiblePaths = new Set(indexEntries.entries.map((e) => e.path));
  const stalenessDistribution: StalenessDistribution = {
    fresh: 0,
    aging: 0,
    stale: 0,
    total: 0,
  };
  // Same loop, same visible-set gate, same shared instant — the adoption
  // monitor must never widen the denominator past what the caller can read,
  // or the count leaks vault size.
  const validityCoverage: ValidityCoverage = { authored: 0, unknown: 0, total: 0 };
  for (const doc of scan.value) {
    if (!visiblePaths.has(doc.relPath)) continue;
    stalenessDistribution.total += 1;
    validityCoverage.total += 1;
    const hasInterval =
      (doc.frontmatter.valid_from ?? null) !== null ||
      (doc.frontmatter.valid_until ?? null) !== null;
    if (hasInterval) validityCoverage.authored += 1;
    else validityCoverage.unknown += 1;
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
  // installed or the index hasn't been built yet, the field is 0. The
  // durable cache stores NATIVE-dim vectors (C9), so the expected dim here
  // is nativeDim (falling back to dim for providers with no Matryoshka gap),
  // not the configured index dim.
  const provider = getProvider();
  let embeddingDimMismatches = 0;
  const dbResult = openIndexDb(vaultRoot, provider.dim, getQuantize());
  if (dbResult.ok) {
    try {
      embeddingDimMismatches = countDimMismatches(
        dbResult.value,
        provider.id,
        provider.nativeDim ?? provider.dim,
      );
    } finally {
      dbResult.value.close();
    }
  }

  return ok({
    vault: vaultRoot,
    fileCount: indexEntries.count,
    collections,
    invalidCount,
    generatedAt: new Date().toISOString(),
    stalenessDistribution,
    validityCoverage,
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

// Output-schema fragments (JSON Schema 2020-12). Shared shapes live here
// because several tools embed the same value: a schema that drifts between
// two tools describes the same type two different ways, which is worse than
// no schema at all.
//
// `additionalProperties: false` is used sparingly and only where a value is
// closed by construction. Frontmatter carries config-declared extension
// fields, `raw` is whatever the author's YAML said, and provenance entries
// are read back from an append-only log written by older versions — all three
// legitimately carry keys this schema does not name.

// Frontmatter as validateFrontmatter always produces it: every built-in field
// present and coerced, plus any config-declared extension fields.
export const FRONTMATTER_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: { type: "string" },
    domain: { type: "string", enum: [...DOMAINS] },
    collection: { type: "string" },
    status: { type: "string", enum: [...STATUSES] },
    confidence: { type: "string", enum: [...CONFIDENCES] },
    created: { type: "string", description: "YYYY-MM-DD (verbatim as authored)" },
    updated: { type: "string", description: "YYYY-MM-DD (verbatim as authored)" },
    updated_by: { type: "string", description: "agent:<id> | human:<username>" },
    provenance: { type: "string", enum: [...PROVENANCES] },
    // null means no write-path tier enforcement — the pre-#141 default.
    tier: { type: ["string", "null"], enum: [...TIERS, null] },
    sources: { type: "array", items: { type: "string" } },
    superseded_by: { type: ["string", "null"] },
    ttl_days: { type: ["number", "null"] },
    tags: { type: "array", items: { type: "string" } },
    describes: { type: "array", items: { type: "string" } },
    questions_answered: { type: "array", items: { type: "string" } },
    questions_raised: { type: "array", items: { type: "string" } },
  },
  required: [
    "title",
    "domain",
    "collection",
    "status",
    "confidence",
    "created",
    "updated",
    "updated_by",
    "provenance",
    "tier",
    "sources",
    "superseded_by",
    "ttl_days",
    "tags",
    "describes",
    "questions_answered",
    "questions_raised",
  ],
};

const VALIDATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    valid: { type: "boolean" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          message: { type: "string" },
        },
        required: ["field", "message"],
      },
    },
  },
  required: ["valid", "issues"],
};

// computeDecay's return: null when healthy (the silent baseline), otherwise a
// level with reasons and a banner that is null for `aging` (scarcity rule).
// Exported: vault_receipt embeds the same value per cited source.
export const DECAY_SCHEMA: Record<string, unknown> = {
  type: ["object", "null"],
  properties: {
    level: { type: "string", enum: ["deprecated", "warn", "aging"] },
    reasons: { type: "array", items: { type: "string" } },
    banner: { type: ["string", "null"] },
  },
  required: ["level", "reasons", "banner"],
};

// One classified upstream edge (#234). Only compiled edges can reach
// pending-broken; the other classes park in pending-unchecked.
const UPSTREAM_EDGE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    unit: { type: "string" },
    edge_class: { type: "string", enum: ["compiled", "declared", "earned"] },
    staleness: {
      type: "string",
      enum: ["current", "pending-unchecked", "pending-compatible", "pending-broken"],
    },
    baseline: {
      type: ["string", "null"],
      description: "ISO timestamp the classification measured from; null when none is derivable",
    },
    changed_fields: { type: "array", items: { type: "string" } },
    reason: { type: "string" },
  },
  required: ["unit", "edge_class", "staleness", "baseline", "changed_fields", "reason"],
};

// One index row / vault_index entry.
const INDEX_ENTRY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    path: { type: "string", description: "Vault-relative path" },
    title: { type: "string" },
    collection: { type: "string" },
    domain: { type: "string", enum: [...DOMAINS] },
    status: { type: "string", enum: [...STATUSES] },
    confidence: { type: "string", enum: [...CONFIDENCES] },
    updated: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
    questionsAnswered: { type: "array", items: { type: "string" } },
    questionsRaised: { type: "array", items: { type: "string" } },
    valid: { type: "boolean", description: "Whether the document's frontmatter validates" },
  },
  required: [
    "path",
    "title",
    "collection",
    "domain",
    "status",
    "confidence",
    "updated",
    "tags",
    "questionsAnswered",
    "questionsRaised",
    "valid",
  ],
};

// A curation-log line, replayed. Entries are read back from an append-only
// JSONL log — older versions wrote fewer keys, future ones may write more, so
// only the four always-present fields are required and the object stays open.
const PROVENANCE_ENTRY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    timestamp: { type: "string", description: "ISO 8601" },
    tool: { type: "string" },
    file: { type: "string", description: "Vault-relative path" },
    agent: { type: "string", description: "Caller-claimed identity, e.g. agent:claude-code" },
    action: {
      type: "string",
      description:
        "create | update | append | promote | deprecate for a write that landed; " +
        "rejected_stale for one refused by the base_version check",
    },
    principal: { type: "string", description: "Authenticated identity, when the server has one" },
    run_id: { type: "string" },
    body_changed: { type: "boolean" },
    frontmatter_diff: {
      type: "object",
      description: "Per-field before/after for every frontmatter field the write changed",
      additionalProperties: {
        type: "object",
        properties: { before: {}, after: {} },
      },
    },
    reason: { type: "string" },
  },
  required: ["timestamp", "tool", "file", "agent", "action"],
};

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------
// Compact `content` summaries + resource links (spec 2026-07-26, Decision 3,
// PR 1 gap closure)
// ---------------------------------------------------------------------------

// vault_read: header line, then every advisory banner that is non-null, then
// the contested count, then the body VERBATIM — this is the one and only
// channel the body crosses the wire on (see `wireValue` below / C11).
function summarizeRead(value: unknown): string {
  const r = value as VaultReadResult;
  const fm = r.frontmatter;
  const lines = [`${r.path} — ${fm.status} / ${fm.confidence} confidence / ${fm.collection}`];
  if (r.decay?.banner) lines.push(`decay: ${r.decay.banner}`);
  if (r.validity?.banner) lines.push(`validity: ${r.validity.banner}`);
  if (r.upstream_staleness?.banner) lines.push(`upstream: ${r.upstream_staleness.banner}`);
  if (r.structural?.banner) lines.push(`structural: ${r.structural.banner}`);
  if (r.contestedCount !== undefined && r.contestedCount > 0) {
    lines.push(`contested: ${r.contestedCount} unresolved tension(s)`);
  }
  lines.push("", r.content);
  return lines.join("\n");
}

// Every upstream unit the caller can see, plus the document itself — all
// already RBAC-filtered by vaultRead (omission, #217), so every path here is
// readable by construction.
function docLinksRead(value: unknown): string[] {
  const r = value as VaultReadResult;
  const paths = [r.path];
  for (const edge of r.upstream_staleness?.edges ?? []) paths.push(edge.unit);
  return paths;
}

// C11: the body ships once, in `content` (summarizeRead, above) — never
// doubled onto `structuredContent`. Delivered via the doc resource too
// (Decision 2), for a programmatic consumer that wants it without the
// summary text around it.
function wireValueRead(value: unknown): Record<string, unknown> {
  const { content: _content, ...rest } = value as VaultReadResult;
  return rest;
}

function summarizeIndex(value: unknown): string {
  const r = value as VaultIndexResult;
  if (r.count === 0) return "0 documents match.";
  const shown = r.entries.slice(0, SUMMARY_MAX_ROWS);
  const lines = [`${r.count} document(s):`, ...shown.map((e) => `  ${e.path} (${e.status})`)];
  const rest = r.count - shown.length;
  if (rest > 0) lines.push(`  … ${rest} more in structuredContent`);
  return lines.join("\n");
}

function summarizeStatus(value: unknown): string {
  const r = value as VaultStatusResult;
  const sd = r.stalenessDistribution;
  const vc = r.validityCoverage;
  return [
    `${r.vault}: ${r.fileCount} doc(s), ${r.invalidCount} invalid — ${r.generatedAt}`,
    `index health: ${r.embeddingDimMismatches} embedding dim mismatch(es)`,
    `staleness: ${sd.fresh} fresh / ${sd.aging} aging / ${sd.stale} stale (of ${sd.total})`,
    `validity: ${vc.authored} authored / ${vc.unknown} unknown (of ${vc.total})`,
    `tensions: ${r.unresolvedTensions.count} unresolved`,
    `recent writes: ${r.recentWrites.count}`,
  ].join("\n");
}

export const readTools: ToolDefinition[] = [
  {
    name: "vault_read",
    title: "Read a vault document",
    annotations: { readOnlyHint: true },
    description:
      "Read a single vault document. Returns its markdown body, parsed " +
      "frontmatter, a validation report, a decay assessment (null when " +
      "healthy; otherwise level, reasons, and an optional banner), a " +
      "validity report (valid time — whether the document's CLAIM was true " +
      "in the world at a given date, which is not the same as whether the " +
      "document is fresh: 'decay' answers freshness, 'validity' answers " +
      "truth-in-the-world; null when the document authors no interval, which " +
      "means unknown and never 'always true'), an " +
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
    outputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The path as requested by the caller" },
        content: {
          type: "string",
          description:
            "Markdown body, frontmatter block stripped. Delivered in the `content` " +
            "channel (verbatim, alongside the header/banners) and via the doc " +
            "resource (daftari://doc/{path}) — never duplicated onto " +
            "structuredContent, so this field is absent there (C11).",
        },
        frontmatter: FRONTMATTER_SCHEMA,
        raw: {
          type: "object",
          description: "Frontmatter exactly as parsed from YAML, before coercion",
        },
        validation: VALIDATION_SCHEMA,
        hasFrontmatter: { type: "boolean" },
        decay: DECAY_SCHEMA,
        // Null when there is nothing to say — byte-identical to a document
        // with no compiled edges at all (no existence signal either way).
        upstream_staleness: {
          type: ["object", "null"],
          properties: {
            edges: {
              type: "array",
              items: UPSTREAM_EDGE_SCHEMA,
              description: "Only upstream units the caller can read (omission, #217)",
            },
            hidden_pending: {
              type: "string",
              enum: ["none", "some", "many"],
              description:
                "Coarse bucket over pending edges to units outside the caller's " +
                "read scope — never an exact count",
            },
            pending_broken: {
              type: "integer",
              minimum: 0,
              description: "Pending-broken count among the VISIBLE edges only",
            },
            banner: { type: ["string", "null"] },
          },
          required: ["edges", "hidden_pending", "pending_broken", "banner"],
        },
        // Null when healthy — same contract as `decay`.
        structural: {
          type: ["object", "null"],
          properties: {
            orphan: {
              type: "boolean",
              description: "No document the caller can read links here",
            },
            deprecated_still_linked: {
              type: ["object", "null"],
              properties: {
                canonical_linkers: { type: "array", items: { type: "string" } },
              },
              required: ["canonical_linkers"],
            },
            banner: { type: "string" },
          },
          required: ["orphan", "deprecated_still_linked", "banner"],
        },
        // Absent (both fields) when no visible unresolved tension touches the
        // document. `contested` is capped; `contestedCount` is the true total.
        contested: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Absent only for legacy entries" },
              kind: { type: "string", enum: [...TENSION_KINDS] },
              counterpart: {
                type: "string",
                description: "Canonical vault-relative path of the other side",
              },
              claimSelf: { type: "string" },
              claimOther: { type: "string" },
              loggedAt: { type: "string", description: "Entry date, YYYY-MM-DD" },
            },
            required: ["kind", "counterpart", "claimSelf", "claimOther", "loggedAt"],
          },
        },
        contestedCount: { type: "integer", minimum: 0 },
        version: { type: "string", description: "SHA-256 (hex) of the raw file bytes" },
      },
      required: [
        "path",
        "frontmatter",
        "raw",
        "validation",
        "hasFrontmatter",
        "decay",
        "upstream_staleness",
        "structural",
        "version",
      ],
    },
    summarize: summarizeRead,
    docLinks: docLinksRead,
    wireValue: wireValueRead,
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
    outputSchema: {
      type: "object",
      properties: {
        count: {
          type: "integer",
          minimum: 0,
          description: "Number of entries returned (post-RBAC, post-filter)",
        },
        entries: { type: "array", items: INDEX_ENTRY_SCHEMA },
      },
      required: ["count", "entries"],
    },
    summarize: summarizeIndex,
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
    outputSchema: {
      type: "object",
      properties: {
        vault: { type: "string", description: "Absolute path of the vault root" },
        fileCount: {
          type: "integer",
          minimum: 0,
          description: "Documents the caller can read",
        },
        collections: {
          type: "array",
          items: {
            type: "object",
            properties: {
              collection: { type: "string" },
              count: { type: "integer", minimum: 0 },
            },
            required: ["collection", "count"],
          },
        },
        invalidCount: { type: "integer", minimum: 0 },
        generatedAt: { type: "string", description: "ISO 8601" },
        // fresh (< 0.5 of TTL elapsed), aging (>= 0.5, not expired), stale
        // (>= 1.0). `total` equals the role's visible file count.
        stalenessDistribution: {
          type: "object",
          properties: {
            fresh: { type: "integer", minimum: 0 },
            aging: { type: "integer", minimum: 0 },
            stale: { type: "integer", minimum: 0 },
            total: { type: "integer", minimum: 0 },
          },
          required: ["fresh", "aging", "stale", "total"],
        },
        unresolvedTensions: {
          type: "object",
          properties: {
            count: { type: "integer", minimum: 0 },
            recent: {
              type: "array",
              maxItems: 5,
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                  date: { type: "string", description: "YYYY-MM-DD" },
                },
                required: ["title", "date"],
              },
            },
          },
          required: ["count", "recent"],
        },
        recentWrites: {
          type: "object",
          properties: {
            count: { type: "integer", minimum: 0 },
            entries: {
              type: "array",
              maxItems: 10,
              items: PROVENANCE_ENTRY_SCHEMA,
            },
          },
          required: ["count", "entries"],
        },
        embeddingDimMismatches: {
          type: "integer",
          minimum: 0,
          description:
            "Embedding cache rows for the active model whose stored dim does not " +
            "match the provider's; non-zero means those chunks are skipped in ranking",
        },
      },
      required: [
        "vault",
        "fileCount",
        "collections",
        "invalidCount",
        "generatedAt",
        "stalenessDistribution",
        "unresolvedTensions",
        "recentWrites",
        "embeddingDimMismatches",
      ],
    },
    summarize: summarizeStatus,
    handler: (vaultRoot, _args, access) => vaultStatus(vaultRoot, access),
  },
];
