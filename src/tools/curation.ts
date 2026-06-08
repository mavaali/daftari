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

import { type AccessContext, hasAnyRead } from "../access/rbac.js";
import {
  LINT_CHECKS,
  type LintCheckName,
  type LintFinding,
  runLint,
  type StagedActionLintItem,
  type TensionHealth,
} from "../curation/lint.js";
import { type ProvenanceEntry, readProvenanceLog } from "../curation/provenance.js";
import { sweepExpiredActions } from "../curation/staged-actions.js";
import {
  addTension,
  LOGGABLE_TENSION_KINDS,
  RESOLUTION_KINDS,
  type ResolutionKind,
  resolveTension,
  type TensionEntry,
  type TensionResolution,
} from "../curation/tension.js";
import { computeTensionBlast, type TensionBlastResult } from "../curation/tension-blast.js";
import { loadTensionClusters, type TensionClustersResult } from "../curation/tension-clusters.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { ToolDefinition } from "./read.js";

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
  if (!(RESOLUTION_KINDS as readonly string[]).includes(kindRaw)) {
    return err(
      new Error(`vault_tension_resolve 'kind' must be one of: ${RESOLUTION_KINDS.join(", ")}`),
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
  return loadTensionClusters(vaultRoot);
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

  return computeTensionBlast(vaultRoot, { document, cluster_id });
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

  const report = await runLint(vaultRoot);
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
    });
  }

  return ok({
    generatedAt: report.value.generatedAt,
    filter: null,
    checks: report.value.checks,
    totalFindings: report.value.totalFindings,
    tensionHealth: report.value.tensionHealth,
    stagedActions: report.value.stagedActions,
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

  const log = await readProvenanceLog(vaultRoot);
  if (!log.ok) return log;

  const history = log.value.filter((e) => e.file === filePath);
  return ok({ path: filePath, count: history.length, history });
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
          enum: [...RESOLUTION_KINDS],
          description:
            "How the tension was resolved: 'superseded' | 'corrected' | " +
            "'accepted' | 'invalid'.",
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
      "the broader region without a second call. Read-only.",
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
    handler: (vaultRoot, args, access) => vaultTensionBlast(vaultRoot, args, access),
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
      "Also reports tension health (counts by kind and resolution kind, " +
      "stable acknowledged persistent disagreements, and legacy unspecified " +
      "entries) and lists pending staged actions awaiting ratification. " +
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
    handler: (vaultRoot, args, access) => vaultProvenance(vaultRoot, args, access),
  },
];
