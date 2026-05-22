// Curation-path tools: vault_tension_log, vault_lint, vault_provenance.
//
// These are the advisory surface of the curation engine. vault_lint reports
// problems but fixes nothing; vault_tension_log records a contradiction but
// resolves nothing; vault_provenance just reads back write history. Each tool
// exposes a pure logic function (returns Result, never throws) plus an MCP
// ToolDefinition, mirroring the read- and write-path tools.

import { type AccessContext, hasAnyRead } from "../access/rbac.js";
import { LINT_CHECKS, type LintCheckName, type LintFinding, runLint } from "../curation/lint.js";
import { type ProvenanceEntry, readProvenanceLog } from "../curation/provenance.js";
import { addTension, type TensionEntry } from "../curation/tension.js";
import { ok, type Result } from "../frontmatter/types.js";
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

  return addTension(vaultRoot, {
    title: title.value,
    sourceA: sourceA.value,
    sourceB: sourceB.value,
    claimA: claimA.value,
    claimB: claimB.value,
    loggedBy: agent.value,
  });
}

// ---------------------------------------------------------------------------
// vault_lint
// ---------------------------------------------------------------------------

export interface VaultLintResult {
  generatedAt: string;
  filter: LintCheckName | null;
  checks: Partial<Record<LintCheckName, LintFinding[]>>;
  totalFindings: number;
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

  const report = await runLint(vaultRoot);
  if (!report.ok) return report;

  if (filter) {
    const findings = report.value.checks[filter];
    return ok({
      generatedAt: report.value.generatedAt,
      filter,
      checks: { [filter]: findings },
      totalFindings: findings.length,
    });
  }

  return ok({
    generatedAt: report.value.generatedAt,
    filter: null,
    checks: report.value.checks,
    totalFindings: report.value.totalFindings,
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
      "does not resolve it. Entries are logged with status 'unresolved'.",
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
      },
      required: ["title", "sourceA", "claimA", "sourceB", "claimB", "agent"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultTensionLog(vaultRoot, args, access),
  },
  {
    name: "vault_lint",
    title: "Run curation checks",
    annotations: { readOnlyHint: true },
    description:
      "Run the advisory curation checks across the vault: stale files past " +
      "TTL, orphan files with no inbound links, old drafts, stagnant " +
      "low-confidence files, deprecated files still linked from canonical " +
      "ones, and questions raised but unanswered anywhere in the vault. " +
      "Reports problems; never auto-fixes. Optionally filter to a single check.",
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
