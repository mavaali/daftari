// Position tools (Slice 1, U-4/U-5): vault_assert writes the calling
// principal's position on a claim doc; vault_positions queries by doc or by
// principal. Pure logic lives in curation/positions.ts; write plumbing is
// reused from write.ts (LD-9) — no duplicated lock/commit/provenance code.

import { type AccessContext, isProposeOnly } from "../access/rbac.js";
import { applyAssert, conflictPairs, isContested } from "../curation/positions.js";
import { stageActionWithConflictCheck } from "../curation/staged-actions.js";
import { addTension, listTensions } from "../curation/tension.js";
import {
  CONFIDENCES,
  type Confidence,
  err,
  type Frontmatter,
  ok,
  type Position,
  PROVENANCES,
  type Provenance,
  type Result,
  STANCES,
  type Stance,
} from "../frontmatter/types.js";
import type { ToolDefinition } from "./read.js";
import {
  loadTargetDocument,
  performFrontmatterWrite,
  requireIndexReady,
  requireWriteAccess,
  targetCollection,
  type WriteResult,
} from "./write.js";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function str(args: Record<string, unknown>, field: string, tool: string): Result<string, Error> {
  const v = args[field];
  if (typeof v !== "string" || v.trim().length === 0) {
    return err(new Error(`${tool} requires a non-empty '${field}' argument`));
  }
  return ok(v);
}

function optStr(
  args: Record<string, unknown>,
  field: string,
  tool: string,
): Result<string | null, Error> {
  const v = args[field];
  if (v === undefined || v === null) return ok(null);
  if (typeof v !== "string") return err(new Error(`${tool}: '${field}' must be a string`));
  return ok(v);
}

export interface AssertResult {
  path: string;
  action: "assert" | "staged";
  position: Position | null;
  superseded_position_id: string | null;
  contested: boolean;
  tension_ids: string[];
  tension_error?: string;
  commit: string | null;
  committed: boolean;
  staged_id?: string;
  expires_at?: string;
  conflicts_with?: string[];
}

export async function vaultAssert(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<AssertResult, Error>> {
  const ready = requireIndexReady();
  if (!ready.ok) return ready;
  const path = str(args, "path", "vault_assert");
  if (!path.ok) return path;
  const agent = str(args, "agent", "vault_assert");
  if (!agent.ok) return agent;

  const stanceRaw = str(args, "stance", "vault_assert");
  if (!stanceRaw.ok) return stanceRaw;
  if (!(STANCES as readonly string[]).includes(stanceRaw.value)) {
    return err(new Error(`vault_assert 'stance' must be one of: ${STANCES.join(", ")}`));
  }
  const confidenceRaw = str(args, "confidence", "vault_assert");
  if (!confidenceRaw.ok) return confidenceRaw;
  if (!(CONFIDENCES as readonly string[]).includes(confidenceRaw.value)) {
    return err(new Error(`vault_assert 'confidence' must be one of: ${CONFIDENCES.join(", ")}`));
  }
  const provenanceRaw = optStr(args, "provenance", "vault_assert");
  if (!provenanceRaw.ok) return provenanceRaw;
  const provenance = (provenanceRaw.value ?? "direct") as Provenance;
  if (!(PROVENANCES as readonly string[]).includes(provenance)) {
    return err(new Error(`vault_assert 'provenance' must be one of: ${PROVENANCES.join(", ")}`));
  }
  const statement = optStr(args, "statement", "vault_assert");
  if (!statement.ok) return statement;
  const validFrom = optStr(args, "valid_from", "vault_assert");
  if (!validFrom.ok) return validFrom;
  const runIdArg = optStr(args, "run_id", "vault_assert");
  if (!runIdArg.ok) return runIdArg;
  const sources: string[] = Array.isArray(args.sources)
    ? args.sources.filter((s): s is string => typeof s === "string")
    : [];

  // R-3: the position's principal is the AUTHENTICATED user. With access, an
  // explicit differing 'principal' argument is impersonation → reject. With
  // no access context (operator server), an explicit principal is REQUIRED
  // and recorded as unverified.
  const principalArg = optStr(args, "principal", "vault_assert");
  if (!principalArg.ok) return principalArg;
  let principal: string;
  if (access) {
    if (principalArg.value !== null && principalArg.value !== access.user) {
      return err(
        new Error(
          `vault_assert: cannot assert a position for another principal ` +
            `(authenticated as '${access.user}')`,
        ),
      );
    }
    principal = access.user;
  } else {
    if (principalArg.value === null) {
      return err(
        new Error(
          "vault_assert: no access context — an explicit 'principal' argument is " +
            "required (recorded as unverified)",
        ),
      );
    }
    principal = principalArg.value;
  }

  // RBAC before any file I/O, keyed off the physical target dir (S1 rule).
  const writeGate = requireWriteAccess(access, targetCollection(vaultRoot, path.value));
  if (!writeGate.ok) return writeGate;

  // Assert targets an EXISTING claim doc; creating the doc is vault_write's
  // job. loadTargetDocument canonicalizes (#127/#128) — one lock, one
  // position set per file, however the path is spelled.
  const target = await loadTargetDocument(vaultRoot, path.value, "vault_assert");
  if (!target.ok) return target;
  const fm = target.value.parsed.frontmatter;

  const applied = applyAssert(fm.positions, {
    principal,
    stance: stanceRaw.value as Stance,
    statement: statement.value,
    confidence: confidenceRaw.value as Confidence,
    provenance,
    valid_from: validFrom.value,
    sources,
    created: todayISO(),
  });
  const contested = isContested(applied.positions);
  const capConfidence = contested && fm.org_position == null; // R-9

  const newFrontmatter: Frontmatter = {
    ...fm,
    positions: applied.positions,
    contested, // R-8: recomputed on every assert; hand-set values overwritten
    ...(capConfidence ? { confidence: "low" as Confidence } : {}),
    updated: todayISO(),
    updated_by: agent.value,
  };

  // R-13: a propose-only role's assert lands as a staged `write` proposal —
  // no file write, no positional tension yet (it fires when the ratified
  // write lands). Contention with other pending proposals is surfaced by
  // stageActionWithConflictCheck's inter-proposal tension.
  if (access && isProposeOnly(access.role)) {
    const staged = await stageActionWithConflictCheck(vaultRoot, {
      actionType: "write",
      targetPath: target.value.relPath,
      proposedBy: agent.value,
      rationale:
        `propose-only role '${access.roleName}': position ${stanceRaw.value} by ` +
        `'${principal}' staged for ratification`,
      proposedDiff: {
        frontmatter: {
          positions: applied.positions,
          contested,
          ...(capConfidence ? { confidence: "low" } : {}),
        },
        body: target.value.parsed.content,
      },
      ...(runIdArg.value !== null ? { runId: runIdArg.value } : {}),
    });
    if (!staged.ok) return staged;
    return ok({
      path: target.value.relPath,
      action: "staged" as const,
      position: applied.newPosition,
      superseded_position_id: applied.superseded?.id ?? null,
      contested,
      tension_ids: [],
      commit: null,
      committed: false,
      staged_id: staged.value.id,
      expires_at: staged.value.expires_at,
      conflicts_with: staged.value.conflicts_with,
    });
  }

  const written = await performFrontmatterWrite({
    vaultRoot,
    target: target.value,
    agent: agent.value,
    tool: "vault_assert",
    action: "assert" as WriteResult["action"],
    newFrontmatter,
    commitMessage: `vault_assert: ${stanceRaw.value} on ${target.value.relPath} by ${principal}`,
    baseVersion: undefined,
    access,
    ...(runIdArg.value !== null ? { runId: runIdArg.value } : {}),
  });
  if (!written.ok) return written;

  // R-5 + locked R-3: one binary tension per NEW conflicting pair, skipped
  // when an OPEN positional tension already names the same two ids on this
  // doc. loggedBy = the asserting principal (DN-3) — the loop-authored
  // ratify gate (CONSOLIDATE_AGENT) never fires on these.
  const tensionIds: string[] = [];
  let tensionError: string | undefined;
  const pairs = conflictPairs(applied.newPosition, applied.positions);
  if (pairs.length > 0) {
    const existing = await listTensions(vaultRoot);
    if (!existing.ok) {
      tensionError = existing.error.message;
    } else {
      const open = existing.value.filter(
        (t) => t.kind === "positional" && !t.resolved && t.sourceA === target.value.relPath,
      );
      const covered = (a: string, b: string): boolean =>
        open.some(
          (t) =>
            (t.positionA === a && t.positionB === b) || (t.positionA === b && t.positionB === a),
        );
      const claim = (p: Position): string =>
        p.statement ?? `${fm.title} — ${p.stance} (${p.confidence})`;
      for (const pair of pairs) {
        if (covered(pair.a.id, pair.b.id)) continue;
        const minted = await addTension(vaultRoot, {
          kind: "positional",
          title: `Positional: ${pair.a.principal} vs ${pair.b.principal} on ${fm.title}`,
          sourceA: target.value.relPath,
          claimA: claim(pair.a),
          sourceB: target.value.relPath,
          claimB: claim(pair.b),
          positionA: pair.a.id,
          positionB: pair.b.id,
          loggedBy: principal,
        });
        if (minted.ok) tensionIds.push(minted.value.id as string);
        else tensionError = minted.error.message;
      }
    }
  }

  return ok({
    path: target.value.relPath,
    action: "assert" as const,
    position: applied.newPosition,
    superseded_position_id: applied.superseded?.id ?? null,
    contested,
    tension_ids: tensionIds,
    ...(tensionError !== undefined ? { tension_error: tensionError } : {}),
    commit: written.value.commit,
    committed: written.value.committed,
  });
}

// Task 5 replaces this stub with the real implementation.
export async function vaultPositions(
  _vaultRoot: string,
  _args: Record<string, unknown>,
  _access?: AccessContext,
): Promise<Result<unknown, Error>> {
  return err(new Error("not implemented"));
}

const POSITION_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    id: { type: "string" },
    principal: { type: "string" },
    stance: { type: "string", enum: [...STANCES] },
    statement: { type: ["string", "null"] },
    confidence: { type: "string", enum: [...CONFIDENCES] },
    provenance: { type: "string", enum: [...PROVENANCES] },
    valid_from: { type: ["string", "null"] },
    superseded_by: { type: ["string", "null"] },
    created: { type: "string" },
    sources: { type: "array", items: { type: "string" } },
  },
  required: [
    "id",
    "principal",
    "stance",
    "statement",
    "confidence",
    "provenance",
    "valid_from",
    "superseded_by",
    "created",
    "sources",
  ],
};

const assertToolDefinition: ToolDefinition = {
  name: "vault_assert",
  title: "Assert a position on a claim document",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  description:
    "Assert, dispute, or qualify the calling principal's position on an " +
    "existing claim document. The position's principal is the authenticated " +
    "--user; a prior live position by the same principal is superseded, never " +
    "edited. A second conflicting live stance (assert vs dispute) marks the " +
    "document contested, caps its confidence at low until an org position is " +
    "ratified (Slice 2), and auto-logs a 'positional' tension (never " +
    "caller-loggable via vault_tension_log; resolve through " +
    "vault_tension_resolve). Propose-only roles: the assert lands as a staged " +
    "'write' proposal for ratification — nothing is written and no positional " +
    "tension is logged until the ratified write lands.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Vault-relative path of the existing claim doc" },
      stance: { type: "string", enum: [...STANCES] },
      statement: { type: "string", description: "Optional refinement of the title claim" },
      confidence: { type: "string", enum: [...CONFIDENCES] },
      provenance: { type: "string", enum: [...PROVENANCES], description: "Default: direct" },
      valid_from: { type: "string", description: "YYYY-MM-DD" },
      sources: { type: "array", items: { type: "string" } },
      agent: { type: "string", description: "Free-text acting identity (advisory)" },
      principal: {
        type: "string",
        description:
          "Only honored (and required) when the server runs without an access " +
          "context; recorded as unverified. With an access context it must " +
          "match the authenticated user.",
      },
      run_id: { type: "string" },
    },
    required: ["path", "stance", "confidence", "agent"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      action: { type: "string", enum: ["assert", "staged"] },
      position: { ...POSITION_SCHEMA, type: ["object", "null"] },
      superseded_position_id: { type: ["string", "null"] },
      contested: { type: "boolean" },
      tension_ids: { type: "array", items: { type: "string" } },
      tension_error: { type: "string" },
      commit: { type: ["string", "null"] },
      committed: { type: "boolean" },
      staged_id: { type: "string" },
      expires_at: { type: "string" },
      conflicts_with: { type: "array", items: { type: "string" } },
    },
    required: [
      "path",
      "action",
      "position",
      "superseded_position_id",
      "contested",
      "tension_ids",
      "commit",
      "committed",
    ],
  },
  docLinks: (value) => [(value as AssertResult).path],
  handler: (vaultRoot, args, access) => vaultAssert(vaultRoot, args, access),
};

export const positionsTools: ToolDefinition[] = [assertToolDefinition];
