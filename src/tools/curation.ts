// Curation-path tools: vault_tension_log, vault_tension_resolve, vault_lint,
// vault_provenance.
//
// These are the advisory surface of the curation engine. vault_lint reports
// problems but fixes nothing; vault_tension_log records a contradiction but
// resolves nothing automatically; vault_tension_resolve records a deliberate
// closure (Phase 1 of the tension graph plan); vault_provenance just reads
// back write history. Each tool exposes a pure logic function (returns
// Result, never throws) plus an MCP ToolDefinition, mirroring the read- and
// write-path tools.

import { type AccessContext, canRatify, canRead, hasAnyRead } from "../access/rbac.js";
import { CONSOLIDATE_AGENT } from "../consolidate/constants.js";
import type { CoverageEquitySummary } from "../curation/coverage.js";
import {
  clip,
  LINT_CHECKS,
  LINT_SUMMARY_DETAIL_CHARS,
  LINT_SUMMARY_TOP_FINDINGS,
  type LintCheckName,
  type LintFinding,
  runLint,
  type StagedActionLintItem,
  type TensionHealth,
  TIER0_LINT_CHECKS,
} from "../curation/lint.js";
import { renderLedgerKeeper } from "../curation/lint-voice.js";
import { type ProvenanceEntry, readProvenanceLog } from "../curation/provenance.js";
import type { ReviewThroughputSummary } from "../curation/review-throughput.js";
import type { ShadowLintSummary } from "../curation/shadow.js";
import { STAGED_ACTION_TYPES, sweepExpiredActions } from "../curation/staged-actions.js";
import {
  addTension,
  CALLER_RESOLUTION_KINDS,
  LOGGABLE_TENSION_KINDS,
  listTensions,
  RESOLUTION_KINDS,
  type ResolutionKind,
  resolveTension,
  TENSION_KINDS,
  type TensionEntry,
  type TensionResolution,
} from "../curation/tension.js";
import { canSeeTension, sourceReadable, visibleTensions } from "../curation/tension-access.js";
import {
  bucketHiddenDownstream,
  computeTensionBlast,
  type TensionBlastResult,
} from "../curation/tension-blast.js";
import { loadTensionClusters, type TensionClustersResult } from "../curation/tension-clusters.js";
import { loadTensionTriage, type TensionTriageResult } from "../curation/tension-triage.js";
import { parseDocument } from "../frontmatter/parser.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { readFile, resolveVaultPath } from "../storage/local.js";
import { loadConfig } from "../utils/config.js";
import type { ToolDefinition } from "./read.js";
import { openIndexForAccessOrNull } from "./search.js";

// Curation tools are open to any role with at least one read grant. A guest
// (or any role with no read access) is denied.
function requireReadAccess(tool: string, access?: AccessContext): Result<void, Error> {
  if (access && !hasAnyRead(access.role)) {
    return {
      ok: false,
      error: new Error(`access denied: role '${access.roleName}' cannot use ${tool}`),
    };
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// vault_tension_log
// ---------------------------------------------------------------------------

export async function vaultTensionLog(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<TensionEntry, Error>> {
  const allowed = requireReadAccess("vault_tension_log", access);
  if (!allowed.ok) return allowed;

  const str = (field: string): Result<string, Error> => {
    const v = args[field];
    if (typeof v !== "string" || v.trim().length === 0) {
      return {
        ok: false,
        error: new Error(`vault_tension_log requires a non-empty '${field}' argument`),
      };
    }
    return ok(v);
  };

  const title = str("title");
  if (!title.ok) return title;
  const sourceA = str("sourceA");
  if (!sourceA.ok) return sourceA;
  const sourceB = str("sourceB");
  if (!sourceB.ok) return sourceB;
  const claimA = str("claimA");
  if (!claimA.ok) return claimA;
  const claimB = str("claimB");
  if (!claimB.ok) return claimB;
  const agent = str("agent");
  if (!agent.ok) return agent;
  const kindRaw = str("kind");
  if (!kindRaw.ok) return kindRaw;
  if (!(LOGGABLE_TENSION_KINDS as readonly string[]).includes(kindRaw.value)) {
    return err(
      new Error(
        `vault_tension_log 'kind' must be one of: ${LOGGABLE_TENSION_KINDS.join(", ")} ` +
          `(unspecified is for legacy entries only and is never loggable)`,
      ),
    );
  }

  // #212: you cannot quote what you cannot read. The check resolves each
  // side's collection, but the denial names the caller-supplied path, never
  // the resolved collection — naming the collection would leak a
  // frontmatter-declared collection for existing docs.
  if (access) {
    const db = openIndexForAccessOrNull(vaultRoot);
    try {
      for (const side of [sourceA.value, sourceB.value]) {
        if (!sourceReadable(db, access, side)) {
          return err(
            new Error(
              `access denied: role '${access.roleName}' cannot log a tension naming '${side}'`,
            ),
          );
        }
      }
    } finally {
      db?.close();
    }
  }

  return addTension(vaultRoot, {
    title: title.value,
    sourceA: sourceA.value,
    sourceB: sourceB.value,
    claimA: claimA.value,
    claimB: claimB.value,
    loggedBy: agent.value,
    kind: kindRaw.value as (typeof LOGGABLE_TENSION_KINDS)[number],
  });
}

// ---------------------------------------------------------------------------
// vault_tension_resolve
// ---------------------------------------------------------------------------

// Records the closure of a tension. `resolved_at` is stamped from the current
// clock; `resolved_by` comes from the server's access identity (the --user
// the server was started with). Errors if the id is unknown or the tension
// is already resolved.
export async function vaultTensionResolve(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<TensionEntry, Error>> {
  const allowed = requireReadAccess("vault_tension_resolve", access);
  if (!allowed.ok) return allowed;

  const id = args.id;
  if (typeof id !== "string" || id.trim().length === 0) {
    return err(new Error("vault_tension_resolve requires a non-empty 'id' argument"));
  }
  const kindRaw = args.kind;
  if (typeof kindRaw !== "string" || kindRaw.trim().length === 0) {
    return err(new Error("vault_tension_resolve requires a non-empty 'kind' argument"));
  }
  if (!(CALLER_RESOLUTION_KINDS as readonly string[]).includes(kindRaw)) {
    return err(
      new Error(
        `vault_tension_resolve 'kind' must be one of: ${CALLER_RESOLUTION_KINDS.join(", ")}`,
      ),
    );
  }

  let rationale: string | undefined;
  if (args.rationale !== undefined && args.rationale !== null) {
    if (typeof args.rationale !== "string") {
      return err(new Error("vault_tension_resolve 'rationale' must be a string"));
    }
    const trimmed = args.rationale.trim();
    if (trimmed.length > 0) rationale = trimmed;
  }

  let references: string[] | undefined;
  if (args.references !== undefined && args.references !== null) {
    if (!Array.isArray(args.references)) {
      return err(new Error("vault_tension_resolve 'references' must be an array of strings"));
    }
    const refs: string[] = [];
    for (const r of args.references) {
      if (typeof r !== "string" || r.trim().length === 0) {
        return err(
          new Error("vault_tension_resolve 'references' must be an array of non-empty strings"),
        );
      }
      refs.push(r.trim());
    }
    if (refs.length > 0) references = refs;
  }

  // Gate: loop-authored tensions require the ratify permission to resolve.
  // Human-authored tensions remain resolvable by any-read role.
  // No-access calls (access === undefined) bypass, matching the existing
  // pattern in vault_edge_contest / vault_ratify.
  // Reads tensions.md once here to check authorship; resolveTension reads it again below.
  // The double-read is acceptable at the expected tensions.md scale (advisory log, not a hot path).
  const all = await listTensions(vaultRoot);
  if (!all.ok) return all;
  const target = all.value.find((t) => t.id === id.trim());
  // #212: an invisible tension must be indistinguishable from a nonexistent
  // one — checked BEFORE the ratify rule, whose error would otherwise
  // confirm existence to a caller who cannot see the entry.
  if (target && access) {
    const db = openIndexForAccessOrNull(vaultRoot);
    try {
      if (!canSeeTension(db, access, target.sourceA, target.sourceB)) {
        return err(new Error(`tension not found: ${id.trim()}`));
      }
    } finally {
      db?.close();
    }
  }
  if (target && target.loggedBy === CONSOLIDATE_AGENT && access && !canRatify(access.role)) {
    return err(
      new Error(`access denied: role '${access.roleName}' cannot resolve a loop-authored tension`),
    );
  }

  // [DATA] resolved_by is taken from the server's access identity (set via
  // --user at server start). When called without an access context (direct
  // in-process call from a test) we fall back to a generic marker.
  const resolvedBy = access?.user ?? "unknown";

  const resolution: TensionResolution = {
    resolved_at: new Date().toISOString(),
    resolved_by: resolvedBy,
    kind: kindRaw as ResolutionKind,
  };
  if (rationale !== undefined) resolution.rationale = rationale;
  if (references !== undefined) resolution.references = references;

  return resolveTension(vaultRoot, id.trim(), resolution);
}

// ---------------------------------------------------------------------------
// vault_tension_clusters
// ---------------------------------------------------------------------------

// Phase 2 of the tension graph plan (2026-05-31). Computes connected
// components of the live tension graph and returns content-addressed cluster
// IDs. Read-only: never edits the tension log or any document.
export async function vaultTensionClusters(
  vaultRoot: string,
  _args: Record<string, unknown> = {},
  access?: AccessContext,
): Promise<Result<TensionClustersResult, Error>> {
  const allowed = requireReadAccess("vault_tension_clusters", access);
  if (!allowed.ok) return allowed;

  const db = access ? openIndexForAccessOrNull(vaultRoot) : null;
  try {
    return await loadTensionClusters(vaultRoot, new Date(), (entries) =>
      visibleTensions(db, entries, access),
    );
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------------
// vault_tension_blast
// ---------------------------------------------------------------------------

// Phase 3 of the tension graph plan (2026-05-31). Computes the transitive
// closure of downstream documents that cite or link a contested document, or
// the union over a contested cluster. Accepts exactly one of `document` or
// `cluster_id` — both or neither is an error. Read-only: never edits the
// tension log or any document.
export async function vaultTensionBlast(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<TensionBlastResult, Error>> {
  const allowed = requireReadAccess("vault_tension_blast", access);
  if (!allowed.ok) return allowed;

  // Coerce each argument independently so we can deliver one consolidated
  // "exactly one of" error in computeTensionBlast rather than two cascading
  // type errors.
  let document: string | undefined;
  if (args.document !== undefined && args.document !== null) {
    if (typeof args.document !== "string") {
      return err(new Error("vault_tension_blast 'document' must be a string"));
    }
    const trimmed = args.document.trim();
    if (trimmed.length > 0) document = trimmed;
  }

  let cluster_id: string | undefined;
  if (args.cluster_id !== undefined && args.cluster_id !== null) {
    if (typeof args.cluster_id !== "string") {
      return err(new Error("vault_tension_blast 'cluster_id' must be a string"));
    }
    const trimmed = args.cluster_id.trim();
    if (trimmed.length > 0) cluster_id = trimmed;
  }

  const db = access ? openIndexForAccessOrNull(vaultRoot) : null;
  try {
    if (document !== undefined && access && !sourceReadable(db, access, document)) {
      return err(
        new Error(`access denied: role '${access.roleName}' cannot blast from '${document}'`),
      );
    }
    const result = await computeTensionBlast(vaultRoot, { document, cluster_id }, (entries) =>
      visibleTensions(db, entries, access),
    );
    if (!result.ok || !access) return result;

    // #217 (B′): the downstream list omits docs the role cannot read; the
    // visible counts and depth are recomputed over what remains, and the
    // hidden remainder surfaces only as a coarsened bucket — an exact delta
    // would disclose linked existence (small-cell class).
    const kept = result.value.downstream.filter((e) => sourceReadable(db, access, e.path));
    const hidden = result.value.downstream.length - kept.length;
    let primary_blast = 0;
    let advisory_blast = 0;
    let max_depth = 0;
    for (const e of kept) {
      if (e.dependency_type === "source") primary_blast += 1;
      else advisory_blast += 1;
      if (e.distance > max_depth) max_depth = e.distance;
    }
    return ok({
      ...result.value,
      downstream: kept,
      primary_blast,
      advisory_blast,
      max_depth,
      hidden_downstream: bucketHiddenDownstream(hidden),
    });
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------------
// vault_tension_triage
// ---------------------------------------------------------------------------

// The Tension Triage Card (v0): composes the LIVE tensions into a
// human-legible, cluster-grouped queue — each tension annotated with its
// blast and, per contested side, tier, confidence, and read-heat. Read-only,
// and deliberately computes NO composite severity score: ranking is the
// curator's job in v0 (legibility before automation).
//
// RBAC v0: the injected visibleTensions filter scopes which tensions appear;
// blast is the loader's count and hidden_downstream stays "none". The
// per-tension #217 kept/hidden recompute that vault_tension_blast performs is
// intentionally NOT replicated here — the triage card surfaces a coarse blast
// magnitude for legibility, not the full downstream list, so the exact-count
// disclosure the recompute guards against does not apply. (If parity is later
// wanted, filter the loaded docs to readable ones before blast.)
export async function vaultTensionTriage(
  vaultRoot: string,
  _args: Record<string, unknown> = {},
  access?: AccessContext,
): Promise<Result<TensionTriageResult, Error>> {
  const allowed = requireReadAccess("vault_tension_triage", access);
  if (!allowed.ok) return allowed;

  const db = access ? openIndexForAccessOrNull(vaultRoot) : null;
  try {
    return await loadTensionTriage(vaultRoot, new Date(), (entries) =>
      visibleTensions(db, entries, access),
    );
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------------
// vault_lint
// ---------------------------------------------------------------------------

export interface VaultLintResult {
  generatedAt: string;
  filter: LintCheckName | null;
  checks: Partial<Record<LintCheckName, LintFinding[]>>;
  totalFindings: number;
  tensionHealth: TensionHealth;
  stagedActions: StagedActionLintItem[];
  shadowActions: ShadowLintSummary;
  coverageEquity: CoverageEquitySummary;
  reviewThroughput: ReviewThroughputSummary;
}

export async function vaultLint(
  vaultRoot: string,
  args: Record<string, unknown> = {},
  access?: AccessContext,
): Promise<Result<VaultLintResult, Error>> {
  const allowed = requireReadAccess("vault_lint", access);
  if (!allowed.ok) return allowed;

  let filter: LintCheckName | null = null;
  if (args.filter !== undefined && args.filter !== null) {
    if (
      typeof args.filter !== "string" ||
      !(LINT_CHECKS as readonly string[]).includes(args.filter)
    ) {
      return {
        ok: false,
        error: new Error(`vault_lint 'filter' must be one of: ${LINT_CHECKS.join(", ")}`),
      };
    }
    filter = args.filter as LintCheckName;
  }

  // Periodic cleanup (spec §11.2): expire any staged action past its TTL before
  // reporting, so the "Staged actions" section reflects post-sweep state. The
  // sweep mutates the canonical jsonl; the sqlite index is reconciled on the
  // next reindex. A sweep failure means .daftari is unwritable — surface it
  // loudly rather than silently reporting a stale queue.
  const swept = await sweepExpiredActions(vaultRoot);
  if (!swept.ok) return swept;

  // #217: findings compute from the caller's vantage — runLint drops
  // invisible docs before any check runs (see LintOptions.pathVisible).
  // tensionHealth stays vault-global by design.
  const db = access ? openIndexForAccessOrNull(vaultRoot) : null;
  let report: Awaited<ReturnType<typeof runLint>>;
  try {
    report = await runLint(
      vaultRoot,
      access ? { pathVisible: (p) => sourceReadable(db, access, p) } : {},
    );
  } finally {
    db?.close();
  }
  if (!report.ok) return report;

  if (filter) {
    const findings = report.value.checks[filter];
    return ok({
      generatedAt: report.value.generatedAt,
      filter,
      checks: { [filter]: findings },
      totalFindings: findings.length,
      tensionHealth: report.value.tensionHealth,
      stagedActions: report.value.stagedActions,
      shadowActions: report.value.shadowActions,
      coverageEquity: report.value.coverageEquity,
      reviewThroughput: report.value.reviewThroughput,
    });
  }

  return ok({
    generatedAt: report.value.generatedAt,
    filter: null,
    checks: report.value.checks,
    totalFindings: report.value.totalFindings,
    tensionHealth: report.value.tensionHealth,
    stagedActions: report.value.stagedActions,
    shadowActions: report.value.shadowActions,
    coverageEquity: report.value.coverageEquity,
    reviewThroughput: report.value.reviewThroughput,
  });
}

// ---------------------------------------------------------------------------
// vault_provenance
// ---------------------------------------------------------------------------

export interface VaultProvenanceResult {
  path: string;
  count: number;
  history: ProvenanceEntry[];
}

// Returns the write history of a single document, oldest entry first, read
// from the .daftari/curation-log.jsonl provenance trail.
export async function vaultProvenance(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<VaultProvenanceResult, Error>> {
  const allowed = requireReadAccess("vault_provenance", access);
  if (!allowed.ok) return allowed;

  const filePath = args.filePath;
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    return {
      ok: false,
      error: new Error("vault_provenance requires a non-empty 'filePath' argument"),
    };
  }

  // RBAC (W): provenance entries carry a frontmatter_diff for every write to
  // the file, so returning them on `hasAnyRead` alone leaks the metadata of
  // documents in collections the caller cannot read. Gate on canRead for the
  // file's collection. The document may no longer exist (deprecated/deleted
  // history), so derive the collection from its current frontmatter when
  // readable, else fall back to the path's leading segment.
  if (access) {
    let collection = filePath.split("/")[0] ?? "";
    const resolved = resolveVaultPath(vaultRoot, filePath);
    if (resolved.ok) {
      const content = await readFile(resolved.value.absPath);
      if (content.ok) {
        const parsed = parseDocument(content.value);
        if (parsed.ok && parsed.value.frontmatter.collection) {
          collection = parsed.value.frontmatter.collection;
        }
      }
    }
    if (!canRead(access.role, collection)) {
      return err(
        new Error(
          `access denied: role '${access.roleName}' cannot read provenance for '${filePath}'`,
        ),
      );
    }
  }

  const log = await readProvenanceLog(vaultRoot);
  if (!log.ok) return log;

  const history = log.value.filter((e) => e.file === filePath);
  return ok({ path: filePath, count: history.length, history });
}

// ---------------------------------------------------------------------------
// Output schemas (spec 2026-07-26, Decision 3)
// ---------------------------------------------------------------------------
//
// JSON Schema 2020-12 for each handler's ok-value, derived from the return
// types above. Closed vocabularies reuse the source-of-truth constants so a
// rename there breaks this build instead of silently drifting the schema.
// Where a structure is open by construction — a free-form counts map, a
// verbatim frontmatter diff — the schema stays permissive rather than
// promising a shape the handler never guarantees.

// { key: integer } over a fixed vocabulary (byKind, byResolutionKind, ...).
function countsByKey(keys: readonly string[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const key of keys) properties[key] = { type: "integer" };
  return { type: "object", properties, required: [...keys], additionalProperties: false };
}

const tensionResolutionSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    resolved_at: { type: "string", description: "ISO 8601 instant the tension was closed" },
    resolved_by: { type: "string" },
    kind: { type: "string", enum: [...RESOLUTION_KINDS] },
    rationale: { type: "string" },
    references: { type: "array", items: { type: "string" } },
  },
  required: ["resolved_at", "resolved_by", "kind"],
  additionalProperties: false,
};

// One tension-log entry. `kinds` narrows the taxonomy to what the calling
// tool can actually return: vault_tension_log mints only loggable kinds,
// while vault_tension_resolve can close an entry of any kind (including the
// system-generated inter-proposal one and legacy unspecified entries).
function tensionEntrySchema(kinds: readonly string[]): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      id: { type: "string", description: "e.g. 'tension-007'; absent on legacy entries" },
      date: { type: "string", description: "YYYY-MM-DD" },
      title: { type: "string" },
      kind: { type: "string", enum: [...kinds] },
      sourceA: { type: "string" },
      claimA: { type: "string" },
      sourceB: { type: "string" },
      claimB: { type: "string" },
      status: { type: "string", description: "'unresolved' | 'resolved'" },
      loggedBy: { type: "string" },
      decidedByPrincipal: { type: "string" },
      resolved: { type: "boolean" },
      resolution: tensionResolutionSchema,
    },
    required: [
      "date",
      "title",
      "kind",
      "sourceA",
      "claimA",
      "sourceB",
      "claimB",
      "status",
      "loggedBy",
      "resolved",
    ],
    additionalProperties: false,
  };
}

const tensionClustersOutputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    cluster_count: { type: "integer" },
    clusters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", description: "cluster:<8 hex chars>" },
          size: { type: "integer" },
          documents: { type: "array", items: { type: "string" } },
          tension_count: { type: "integer" },
          kinds: countsByKey(TENSION_KINDS),
          oldest_tension_age_days: { type: "number" },
          newest_tension_age_days: { type: "number" },
        },
        required: [
          "id",
          "size",
          "documents",
          "tension_count",
          "kinds",
          "oldest_tension_age_days",
          "newest_tension_age_days",
        ],
        additionalProperties: false,
      },
    },
  },
  required: ["cluster_count", "clusters"],
  additionalProperties: false,
};

const tensionBlastOutputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    contested_document: { type: ["string", "null"] },
    cluster_id: { type: ["string", "null"] },
    cluster_documents: { type: "array", items: { type: "string" } },
    downstream: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string" },
          dependency_type: { type: "string", enum: ["source", "link"] },
          distance: { type: "integer" },
        },
        required: ["path", "dependency_type", "distance"],
        additionalProperties: false,
      },
    },
    primary_blast: { type: "integer", description: "docs reached via the 'sources' edge" },
    advisory_blast: { type: "integer", description: "docs reached only via markdown links" },
    max_depth: { type: "integer" },
    hidden_downstream: {
      type: "string",
      enum: ["none", "some", "many"],
      description: "Coarsened remainder of unreadable downstream docs — never an exact count",
    },
  },
  required: [
    "contested_document",
    "cluster_id",
    "cluster_documents",
    "downstream",
    "primary_blast",
    "advisory_blast",
    "max_depth",
    "hidden_downstream",
  ],
  additionalProperties: false,
};

const triageReadHeatSchema: Record<string, unknown> = {
  type: ["object", "null"],
  properties: {
    count: { type: "integer", description: "reads served within the window" },
    last_read: {
      type: ["string", "null"],
      description: "ISO timestamp of the most recent in-window read",
    },
    instrumented: {
      type: "boolean",
      description:
        "false when the doc may predate the read log — its count is not trustworthy as coldness",
    },
  },
  required: ["count", "last_read", "instrumented"],
  additionalProperties: false,
};

const triageSideSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    path: { type: "string" },
    claim: { type: "string" },
    tier: { type: ["integer", "null"], description: "null when the doc is unknown or untiered" },
    confidence: { type: ["string", "null"], enum: ["low", "medium", "high", null] },
    read_heat: triageReadHeatSchema,
    criticality: { type: ["string", "null"], enum: ["low", "medium", "high", null] },
    provenance: {
      type: ["string", "null"],
      enum: ["direct", "synthesized", "inferred", null],
    },
    updated_by: { type: ["string", "null"] },
  },
  required: ["path", "claim", "tier", "confidence", "read_heat"],
  additionalProperties: false,
};

const tensionTriageOutputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    cluster_count: { type: "integer" },
    tension_count: { type: "integer" },
    clusters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cluster_id: { type: "string", description: "cluster:<8 hex chars>" },
          documents: { type: "array", items: { type: "string" } },
          tensions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                kind: { type: "string", enum: [...TENSION_KINDS] },
                age_days: { type: "number" },
                a: triageSideSchema,
                b: triageSideSchema,
                primary_blast: { type: ["integer", "null"] },
                advisory_blast: { type: ["integer", "null"] },
                hidden_downstream: {
                  type: ["string", "null"],
                  enum: ["none", "some", "many", null],
                },
              },
              required: [
                "id",
                "title",
                "kind",
                "age_days",
                "a",
                "b",
                "primary_blast",
                "advisory_blast",
                "hidden_downstream",
              ],
              additionalProperties: false,
            },
          },
        },
        required: ["cluster_id", "documents", "tensions"],
        additionalProperties: false,
      },
    },
  },
  required: ["cluster_count", "tension_count", "clusters"],
  additionalProperties: false,
};

const lintFindingSchema: Record<string, unknown> = {
  type: "object",
  properties: { path: { type: "string" }, detail: { type: "string" } },
  required: ["path", "detail"],
  additionalProperties: false,
};

// `checks` is a Partial record — a filtered run carries exactly one key — so
// no check name is required, only known.
const lintChecksProperties: Record<string, unknown> = {};
for (const check of LINT_CHECKS) {
  lintChecksProperties[check] = { type: "array", items: lintFindingSchema };
}

const strengthGroupStatsSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    count: { type: "integer" },
    mean: { type: "number" },
    median: { type: "number" },
    p10: { type: "number" },
    p90: { type: "number" },
    variance: { type: "number" },
  },
  required: ["count", "mean", "median", "p10", "p90", "variance"],
  additionalProperties: false,
};

const shadowLintItemSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    at: { type: "string" },
    tool: { type: "string" },
    action: { type: "string" },
    targetPath: { type: "string" },
    agent: { type: "string" },
    impact: { type: "number" },
    budget: { type: "number" },
  },
  required: ["at", "tool", "action", "targetPath", "agent", "impact", "budget"],
  additionalProperties: false,
};

const reviewThroughputWindowSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    arrivals: { type: "integer" },
    decisions: { type: "integer" },
    expiries: { type: "integer" },
  },
  required: ["arrivals", "decisions", "expiries"],
  additionalProperties: false,
};

const lintOutputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    generatedAt: { type: "string" },
    filter: {
      type: ["string", "null"],
      enum: [...LINT_CHECKS, null],
      description: "The single check the report was restricted to, or null for all checks",
    },
    checks: {
      type: "object",
      properties: lintChecksProperties,
      additionalProperties: false,
    },
    totalFindings: { type: "integer" },
    // Vault-global by design (#217 decision C): counts only, no paths.
    tensionHealth: {
      type: "object",
      properties: {
        total: { type: "integer" },
        byKind: countsByKey(TENSION_KINDS),
        resolvedLifetime: { type: "integer" },
        byResolutionKind: countsByKey(RESOLUTION_KINDS),
        stableAcknowledged: { type: "integer" },
        unspecifiedLegacy: { type: "integer" },
        aging: {
          type: "object",
          properties: {
            fresh: { type: "integer" },
            aging: { type: "integer" },
            stale: { type: "integer" },
            staleByKind: countsByKey(TENSION_KINDS),
            // Kind-keyed lint copy, present only for kinds with a nonzero
            // stale count; `unspecified` never appears.
            staleMessages: { type: "object", additionalProperties: { type: "string" } },
          },
          required: ["fresh", "aging", "stale", "staleByKind", "staleMessages"],
          additionalProperties: false,
        },
        clusters: {
          type: "object",
          properties: {
            count: { type: "integer" },
            maxSize: { type: "integer" },
            large: { type: "integer" },
            aged: { type: "integer" },
          },
          required: ["count", "maxSize", "large", "aged"],
          additionalProperties: false,
        },
        blastRadiusOfStaleTensions: { type: "integer" },
      },
      required: [
        "total",
        "byKind",
        "resolvedLifetime",
        "byResolutionKind",
        "stableAcknowledged",
        "unspecifiedLegacy",
        "aging",
        "clusters",
        "blastRadiusOfStaleTensions",
      ],
      additionalProperties: false,
    },
    stagedActions: {
      type: "array",
      description: "Pending staged actions awaiting ratification, soonest-to-expire first",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          actionType: { type: "string", enum: [...STAGED_ACTION_TYPES] },
          targetPath: { type: "string" },
          ageDays: { type: "integer" },
          expiresInDays: { type: "integer" },
          rationale: { type: "string", description: "First sentence of the staged rationale" },
        },
        required: ["id", "actionType", "targetPath", "ageDays", "expiresInDays", "rationale"],
        additionalProperties: false,
      },
    },
    shadowActions: {
      type: "object",
      properties: {
        total: { type: "integer" },
        gated: { type: "integer" },
        recentGated: { type: "array", items: shadowLintItemSchema },
        gatedSurfaced: { type: "array", items: shadowLintItemSchema },
        gatedCount: { type: "integer" },
      },
      required: ["total", "gated", "recentGated", "gatedSurfaced", "gatedCount"],
      additionalProperties: false,
    },
    coverageEquity: {
      type: "object",
      properties: {
        generatedAt: { type: "string" },
        strengthDrift: {
          type: "object",
          properties: {
            core: strengthGroupStatsSchema,
            periphery: strengthGroupStatsSchema,
            // Null when either group is empty — the gap is undefined, and a
            // sentinel 0 would read as "no drift".
            coreMinusPeripheryMedian: { type: ["number", "null"] },
            belowTriggerCount: { type: "integer" },
          },
          required: ["core", "periphery", "coreMinusPeripheryMedian", "belowTriggerCount"],
          additionalProperties: false,
        },
        backstopOverdue: {
          type: "object",
          properties: {
            count: { type: "integer" },
            stalest: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  fromPath: { type: "string" },
                  toPath: { type: "string" },
                  daysOverdue: { type: "number" },
                },
                required: ["fromPath", "toPath", "daysOverdue"],
                additionalProperties: false,
              },
            },
          },
          required: ["count", "stalest"],
          additionalProperties: false,
        },
        actionMix: {
          type: "object",
          properties: {
            // Open by construction: keyed by whatever action names the edge
            // ops and staged-action log carry.
            counts: { type: "object", additionalProperties: { type: "integer" } },
            cheapLinkFraction: { type: "number" },
            total: { type: "integer" },
          },
          required: ["counts", "cheapLinkFraction", "total"],
          additionalProperties: false,
        },
        directionResolution: {
          type: "object",
          properties: {
            directed: { type: "integer" },
            symmetric: { type: "integer" },
            unresolvedFraction: { type: "number" },
          },
          required: ["directed", "symmetric", "unresolvedFraction"],
          additionalProperties: false,
        },
      },
      required: [
        "generatedAt",
        "strengthDrift",
        "backstopOverdue",
        "actionMix",
        "directionResolution",
      ],
      additionalProperties: false,
    },
    reviewThroughput: {
      type: "object",
      properties: {
        lifetime: {
          type: "object",
          properties: {
            proposals: { type: "integer" },
            ratified: { type: "integer" },
            rejected: { type: "integer" },
            expired: { type: "integer" },
            pending: { type: "integer" },
          },
          required: ["proposals", "ratified", "rejected", "expired", "pending"],
          additionalProperties: false,
        },
        last7d: reviewThroughputWindowSchema,
        last30d: reviewThroughputWindowSchema,
        timeToDecisionDays: {
          type: "object",
          properties: {
            p50: { type: ["number", "null"] },
            p90: { type: ["number", "null"] },
          },
          required: ["p50", "p90"],
          additionalProperties: false,
        },
        oldestPendingDays: { type: ["number", "null"] },
      },
      required: ["lifetime", "last7d", "last30d", "timeToDecisionDays", "oldestPendingDays"],
      additionalProperties: false,
    },
  },
  required: [
    "generatedAt",
    "filter",
    "checks",
    "totalFindings",
    "tensionHealth",
    "stagedActions",
    "shadowActions",
    "coverageEquity",
    "reviewThroughput",
  ],
  additionalProperties: false,
};

const provenanceOutputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    path: { type: "string" },
    count: { type: "integer" },
    history: {
      type: "array",
      description: "Provenance entries for this document, oldest first",
      items: {
        type: "object",
        properties: {
          timestamp: { type: "string" },
          tool: { type: "string" },
          file: { type: "string" },
          agent: { type: "string", description: "Caller-claimed acting identity" },
          action: { type: "string" },
          principal: { type: "string", description: "Authenticated server identity (§11.6)" },
          run_id: { type: "string" },
          body_changed: { type: "boolean" },
          // Per-field { before, after } over arbitrary frontmatter keys —
          // open by construction, so the value shape stays unconstrained.
          frontmatter_diff: { type: "object", additionalProperties: { type: "object" } },
          reason: { type: "string" },
        },
        required: ["timestamp", "tool", "file", "agent", "action"],
        additionalProperties: false,
      },
    },
  },
  required: ["path", "count", "history"],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// vault_lint summarizer
// ---------------------------------------------------------------------------
//
// Decision 3 names vault-wide lint output as a worst token offender: the full
// report is a wall. The `content` channel gets counts plus a handful of
// findings, one line each; the full report still rides the structured channel.

export function summarizeLint(value: unknown): string {
  const report = value as VaultLintResult;

  const perCheck: string[] = [];
  let certain = 0;
  let advisory = 0;
  const flat: Array<{ check: LintCheckName; finding: LintFinding }> = [];
  for (const check of LINT_CHECKS) {
    const findings = report.checks[check] ?? [];
    if (findings.length === 0) continue;
    perCheck.push(`${check} ${findings.length}`);
    if (TIER0_LINT_CHECKS.includes(check)) certain += findings.length;
    else advisory += findings.length;
    for (const finding of findings) flat.push({ check, finding });
  }
  // Certain (tier-0) findings first; sort is stable, so within each severity
  // the LINT_CHECKS order is preserved.
  flat.sort(
    (a, b) =>
      Number(TIER0_LINT_CHECKS.includes(b.check)) - Number(TIER0_LINT_CHECKS.includes(a.check)),
  );

  const health = report.tensionHealth;
  const lines = [
    `vault_lint [${report.filter ?? "all checks"}] ${report.totalFindings} finding(s): ` +
      `${certain} certain (tier-0), ${advisory} advisory — ${report.generatedAt}`,
    perCheck.length > 0 ? `by check: ${perCheck.join(", ")}` : "by check: clean",
    `tensions: ${health.total} logged, ${health.resolvedLifetime} resolved, ` +
      `${health.stableAcknowledged} accepted; aging ${health.aging.fresh}/${health.aging.aging}/` +
      `${health.aging.stale} fresh/aging/stale; ${health.clusters.count} cluster(s) ` +
      `(${health.clusters.large} large, ${health.clusters.aged} aged); ` +
      `stale blast ${health.blastRadiusOfStaleTensions}`,
    `staged: ${report.stagedActions.length} pending, ` +
      `${report.reviewThroughput.lifetime.expired} expired lifetime; ` +
      `shadow: ${report.shadowActions.total} logged, ${report.shadowActions.gated} would-gate; ` +
      `coverage: ${report.coverageEquity.backstopOverdue.count} backstop-overdue edge(s)`,
  ];

  const top = flat.slice(0, LINT_SUMMARY_TOP_FINDINGS);
  if (top.length > 0) {
    lines.push(`top ${top.length} of ${flat.length} finding(s):`);
    for (const { check, finding } of top) {
      lines.push(
        `  [${check}] ${finding.path} — ${clip(finding.detail, LINT_SUMMARY_DETAIL_CHARS)}`,
      );
    }
  }
  return lines.join("\n");
}

// The vault_lint `content`-channel summary, choosing the voice from the vault's
// `lint_voice` config. Default (or on any config error) is the plain summary;
// `ledger_keeper` re-renders the SAME findings in the ledger-keeper register.
// The structured channel (the VaultLintResult itself) is untouched either way.
export function lintContentSummary(value: unknown, vaultRoot: string): string {
  const config = loadConfig(vaultRoot);
  const voice = config.ok ? config.value.lintVoice : "plain";
  return voice === "ledger_keeper"
    ? renderLedgerKeeper(value as VaultLintResult)
    : summarizeLint(value);
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

export const curationTools: ToolDefinition[] = [
  {
    name: "vault_tension_log",
    title: "Log a contradiction",
    annotations: { destructiveHint: true },
    description:
      "Record a tension — a contradiction or unresolved pull between two " +
      "vault documents — to the advisory tension log. Records the tension; " +
      "does not resolve it. The 'kind' parameter classifies the disagreement " +
      "(temporal: succession; factual: one is wrong; interpretive: same facts, " +
      "different conclusions). New entries are logged with status 'unresolved'.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title summarizing the tension",
        },
        sourceA: {
          type: "string",
          description: "Vault path of the first document",
        },
        claimA: {
          type: "string",
          description: "What source A claims",
        },
        sourceB: {
          type: "string",
          description: "Vault path of the second document",
        },
        claimB: {
          type: "string",
          description: "What source B claims",
        },
        agent: {
          type: "string",
          description: "Identity logging the tension, e.g. 'agent:claude-code'",
        },
        kind: {
          type: "string",
          enum: [...LOGGABLE_TENSION_KINDS],
          description:
            "Taxonomy of the disagreement: 'temporal' (A was true, B is true now), " +
            "'factual' (one is wrong; needs investigation), or 'interpretive' " +
            "(same facts, different conclusions). 'unspecified' is reserved for " +
            "legacy entries and is not loggable.",
        },
      },
      required: ["title", "sourceA", "claimA", "sourceB", "claimB", "agent", "kind"],
      additionalProperties: false,
    },
    // The entry as logged: id assigned, status 'unresolved', no resolution.
    outputSchema: tensionEntrySchema(LOGGABLE_TENSION_KINDS),
    handler: (vaultRoot, args, access) => vaultTensionLog(vaultRoot, args, access),
  },
  {
    name: "vault_tension_resolve",
    title: "Resolve a logged tension",
    annotations: { destructiveHint: true },
    description:
      "Record the closure of a previously logged tension. The 'kind' parameter " +
      "records HOW the tension was resolved: 'superseded' (older doc deprecated), " +
      "'corrected' (one side was wrong; fixes applied), 'accepted' (both views " +
      "stand as a deliberately persistent disagreement), or 'invalid' (false " +
      "alarm). Optional 'rationale' and 'references' record the reasoning and " +
      "any supporting documents. Errors if the tension id is unknown or already " +
      "resolved. 'resolved_at' is stamped server-side; 'resolved_by' is taken " +
      "from the server's access identity.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Id of the tension to resolve, e.g. 'tension-007'",
        },
        kind: {
          type: "string",
          enum: [...CALLER_RESOLUTION_KINDS],
          description:
            "How the tension was resolved: 'superseded' | 'corrected' | " +
            "'accepted' | 'invalid'. ('consolidated' is system-only, recorded " +
            "by vault_consolidate's batch resolve.)",
        },
        rationale: {
          type: "string",
          description:
            "Optional but strongly recommended: the audit trail explaining the decision.",
        },
        references: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of vault-relative paths central to the resolution.",
        },
      },
      required: ["id", "kind"],
      additionalProperties: false,
    },
    // The updated entry: status 'resolved' with the resolution block attached.
    outputSchema: tensionEntrySchema(TENSION_KINDS),
    handler: (vaultRoot, args, access) => vaultTensionResolve(vaultRoot, args, access),
  },
  {
    name: "vault_tension_clusters",
    title: "Compute tension clusters",
    annotations: { readOnlyHint: true },
    description:
      "Compute connected components of the tension graph: groups of vault " +
      "documents joined transitively by unresolved tensions. The scope is " +
      "live contested regions only — resolved tensions and stable-acknowledged " +
      "disagreements (resolution.kind: accepted) do not form edges. Cluster " +
      "IDs are content-addressed (cluster:<8 hex chars>), stable across runs " +
      "for unchanged membership and different when membership changes. Each " +
      "cluster reports its members, in-scope tension count, tally by kind, " +
      "and the age range of its tensions in days. Read-only; never edits.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: tensionClustersOutputSchema,
    handler: (vaultRoot, args, access) => vaultTensionClusters(vaultRoot, args, access),
  },
  {
    name: "vault_tension_blast",
    title: "Compute tension blast radius",
    annotations: { readOnlyHint: true },
    description:
      "Compute the transitive closure of downstream documents that cite or " +
      "link a contested document — or the union over a contested cluster. " +
      "Accepts exactly one of 'document' (vault-relative path) or " +
      "'cluster_id' (a content-addressed id from vault_tension_clusters); " +
      "both or neither is an error. Two confidence channels: 'primary_blast' " +
      "counts docs reached via the frontmatter 'sources' edge (authoritative " +
      "provenance), 'advisory_blast' counts docs reached only via in-vault " +
      "markdown links (suggestive). A doc reachable via both edge types " +
      "counts as primary. 'superseded_by' is not a blast edge: the doc that " +
      "supersedes a contested doc is the replacement, not an inheritor. The " +
      "response identifies the containing cluster (if any) so the agent sees " +
      "the broader region without a second call. Under RBAC the downstream " +
      "list and counts cover only documents the role can read; " +
      "'hidden_downstream' (none | some | many) coarsely signals unreadable " +
      "downstream docs — treat 'some' or 'many' as 'the real blast exceeds " +
      "what you can see' when weighing a resolution. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        document: {
          type: "string",
          description: "Vault-relative path of a contested document",
        },
        cluster_id: {
          type: "string",
          description:
            "A content-addressed cluster id from vault_tension_clusters " +
            "(format: 'cluster:<8 hex chars>')",
        },
      },
      additionalProperties: false,
    },
    outputSchema: tensionBlastOutputSchema,
    handler: (vaultRoot, args, access) => vaultTensionBlast(vaultRoot, args, access),
  },
  {
    name: "vault_tension_triage",
    title: "Tension triage card",
    annotations: { readOnlyHint: true },
    description:
      "Compose the vault's LIVE tensions into a human-legible triage card: " +
      "every unresolved, non-accepted tension grouped by cluster and " +
      "annotated for a curator deciding what to resolve. Each tension carries " +
      "its kind, age in days, and blast (primary_blast via 'sources' edges, " +
      "advisory_blast via markdown links); each contested side carries its " +
      "tier, confidence, and read-heat (in-window read count + recency, with " +
      "an 'instrumented' flag that distinguishes a genuinely cold doc from one " +
      "that predates the read log). Clusters are ordered by size descending, " +
      "tensions within a cluster by age descending. There is deliberately NO " +
      "composite severity score or ranking — legibility is the point; ranking " +
      "the queue is the human's call. Null tier/confidence/read-heat means the " +
      "doc is unknown; null blast means none was computed for that tension. " +
      "Read-only; never edits the tension log or any document.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: tensionTriageOutputSchema,
    handler: (vaultRoot, args, access) => vaultTensionTriage(vaultRoot, args, access),
  },
  {
    name: "vault_lint",
    // Not read-only: the staged-action sweep (§11.2) expires actions past
    // their TTL, appending expiry records to .daftari/staged-actions.jsonl.
    // It never edits vault content — only the staging queue's own lifecycle.
    annotations: { readOnlyHint: false },
    description:
      "Run the advisory curation checks across the vault: stale files past " +
      "TTL, orphan files with no inbound links, old drafts, stagnant " +
      "low-confidence files, deprecated files still linked from canonical " +
      "ones, and questions raised but unanswered anywhere in the vault. " +
      "Under RBAC, findings compute from the caller's vantage: documents in " +
      "unreadable collections are neither named nor counted as linkers. " +
      "Also reports tension health (counts by kind and resolution kind, " +
      "stable acknowledged persistent disagreements, and legacy unspecified " +
      "entries) — tension-health counts are deliberately VAULT-GLOBAL, not " +
      "RBAC-filtered: counts only, no paths, so vault health reads the same " +
      "for every role. Lists pending staged actions awaiting ratification, and — " +
      "when the vault has run shadow_mode — summarizes shadow-logged writes " +
      "with the ones the trust budget would have gated. " +
      "Never auto-fixes vault content; it does, as housekeeping, expire " +
      "staged actions past their TTL. Optionally filter to a single check.",
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: [...LINT_CHECKS],
          description: "Restrict the report to a single check",
        },
      },
      additionalProperties: false,
    },
    outputSchema: lintOutputSchema,
    summarize: lintContentSummary,
    handler: (vaultRoot, args, access) => vaultLint(vaultRoot, args, access),
  },
  {
    name: "vault_provenance",
    title: "View document write history",
    annotations: { readOnlyHint: true },
    description:
      "Return the write history of a single document from the provenance " +
      "log: every create, update, append, promote, and deprecate recorded " +
      "for it, oldest first.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "Vault-relative path of the document to query",
        },
      },
      required: ["filePath"],
      additionalProperties: false,
    },
    outputSchema: provenanceOutputSchema,
    handler: (vaultRoot, args, access) => vaultProvenance(vaultRoot, args, access),
  },
];
