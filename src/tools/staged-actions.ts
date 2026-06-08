// Staged-action queue tools: vault_stage_action (producer) and vault_ratify
// (consumer). Spec §11.2 — the "always-stage" tier of the cortex loop.
//
// vault_stage_action records a proposed change for later human ratification.
// In v1 the cortex loop that would normally call it does not exist yet, so the
// tool is exposed over MCP mainly for testing and for the future loop; a human
// would not normally call it directly.
//
// vault_ratify is the human's approve/reject gate. On approve it dispatches to
// the existing write tool for the action type. The dispatch table is
// hand-written for v1: promote and deprecate dispatch to real tools; supersede,
// merge, and confidence-up are STAGED ONLY (their write tools are deferred to
// §11.4) and approving one records a `ratified-pending-tool` status that
// applies nothing.

import { type AccessContext, hasAnyRead } from "../access/rbac.js";
import {
  DEFERRED_ACTION_TYPES,
  getStagedActionById,
  nowISO,
  recordDecision,
  STAGED_ACTION_TYPES,
  type StagedActionType,
  stageAction,
} from "../curation/staged-actions.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { readFile, resolveVaultPath } from "../storage/local.js";
import type { ToolDefinition } from "./read.js";
import { vaultDeprecate, vaultPromote, type WriteResult } from "./write.js";

function requireReadAccess(tool: string, access?: AccessContext): Result<void, Error> {
  if (access && !hasAnyRead(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot use ${tool}`));
  }
  return ok(undefined);
}

function requireString(
  args: Record<string, unknown>,
  field: string,
  tool: string,
): Result<string, Error> {
  const v = args[field];
  if (typeof v !== "string" || v.trim().length === 0) {
    return err(new Error(`${tool} requires a non-empty '${field}' argument`));
  }
  return ok(v);
}

// ---------------------------------------------------------------------------
// vault_stage_action
// ---------------------------------------------------------------------------

export interface StageActionResult {
  id: string;
  expires_at: string;
}

export async function vaultStageAction(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<StageActionResult, Error>> {
  const allowed = requireReadAccess("vault_stage_action", access);
  if (!allowed.ok) return allowed;

  const actionType = requireString(args, "action_type", "vault_stage_action");
  if (!actionType.ok) return actionType;
  if (!(STAGED_ACTION_TYPES as readonly string[]).includes(actionType.value)) {
    return err(
      new Error(
        `vault_stage_action 'action_type' must be one of: ${STAGED_ACTION_TYPES.join(", ")}`,
      ),
    );
  }
  const targetPath = requireString(args, "target_path", "vault_stage_action");
  if (!targetPath.ok) return targetPath;
  const proposedBy = requireString(args, "proposed_by", "vault_stage_action");
  if (!proposedBy.ok) return proposedBy;
  const rationale = requireString(args, "rationale", "vault_stage_action");
  if (!rationale.ok) return rationale;

  if (args.proposed_diff === undefined || args.proposed_diff === null) {
    return err(new Error("vault_stage_action requires a 'proposed_diff' object argument"));
  }

  // Fail fast: an action that targets a non-existent document can never be
  // ratified (the write-tool dispatch would reject "document not found"). Catch
  // it at stage time so a bad target never sits in the queue for 14 days.
  const resolved = resolveVaultPath(vaultRoot, targetPath.value);
  if (!resolved.ok) return resolved;
  const exists = await readFile(resolved.value);
  if (!exists.ok) {
    return err(new Error(`vault_stage_action: target document not found: ${targetPath.value}`));
  }

  let ttlDays: number | undefined;
  if (args.ttl_days !== undefined && args.ttl_days !== null) {
    if (typeof args.ttl_days !== "number" || !Number.isFinite(args.ttl_days)) {
      return err(new Error("vault_stage_action 'ttl_days' must be a number"));
    }
    ttlDays = args.ttl_days;
  }

  return stageAction(vaultRoot, {
    actionType: actionType.value as StagedActionType,
    targetPath: targetPath.value,
    proposedBy: proposedBy.value,
    rationale: rationale.value,
    proposedDiff: args.proposed_diff,
    ...(ttlDays !== undefined ? { ttlDays } : {}),
  });
}

// ---------------------------------------------------------------------------
// vault_ratify
// ---------------------------------------------------------------------------

export interface RatifyResult {
  action_id: string;
  decision: "approve" | "reject";
  applied: boolean;
  commit?: string;
  deferred_to?: string;
}

export async function vaultRatify(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<RatifyResult, Error>> {
  const allowed = requireReadAccess("vault_ratify", access);
  if (!allowed.ok) return allowed;

  const id = requireString(args, "id", "vault_ratify");
  if (!id.ok) return id;
  const decisionRaw = requireString(args, "decision", "vault_ratify");
  if (!decisionRaw.ok) return decisionRaw;
  if (decisionRaw.value !== "approve" && decisionRaw.value !== "reject") {
    return err(new Error("vault_ratify 'decision' must be 'approve' or 'reject'"));
  }
  const decision = decisionRaw.value;
  const principal = requireString(args, "principal", "vault_ratify");
  if (!principal.ok) return principal;

  let reason: string | undefined;
  if (args.reason !== undefined && args.reason !== null) {
    if (typeof args.reason !== "string") {
      return err(new Error("vault_ratify 'reason' must be a string"));
    }
    const trimmed = args.reason.trim();
    if (trimmed.length > 0) reason = trimmed;
  }

  // Validate the action exists and is still open.
  const found = await getStagedActionById(vaultRoot, id.value);
  if (!found.ok) return found;
  const action = found.value;
  if (!action) return err(new Error(`vault_ratify: unknown staged action: ${id.value}`));
  if (action.status !== "pending") {
    return err(
      new Error(
        `vault_ratify: staged action ${id.value} is '${action.status}', not 'pending' — ` +
          "it cannot be ratified",
      ),
    );
  }

  const decidedAt = nowISO();

  // --- reject: record and apply nothing ---
  if (decision === "reject") {
    const recorded = await recordDecision(vaultRoot, id.value, {
      status: "rejected",
      ratifiedAt: decidedAt,
      ratifiedBy: principal.value,
      ...(reason ? { reason } : {}),
    });
    if (!recorded.ok) return recorded;
    return ok({ action_id: id.value, decision, applied: false });
  }

  // --- approve: dispatch by action type ---
  // Deferred types (§11.4) have no write tool yet: record the approval as
  // ratified-pending-tool and apply nothing.
  if (DEFERRED_ACTION_TYPES.includes(action.actionType as StagedActionType)) {
    const recorded = await recordDecision(vaultRoot, id.value, {
      status: "ratified-pending-tool",
      ratifiedAt: decidedAt,
      ratifiedBy: principal.value,
      ...(reason ? { reason } : {}),
    });
    if (!recorded.ok) return recorded;
    return ok({ action_id: id.value, decision, applied: false, deferred_to: "§11.4" });
  }

  // promote / deprecate dispatch to real write tools. A dispatch failure leaves
  // the action pending so it can be retried — no decision record is written.
  let dispatched: Result<WriteResult, Error>;
  if (action.actionType === "promote") {
    dispatched = await vaultPromote(
      vaultRoot,
      { path: action.targetPath, agent: principal.value },
      access,
    );
  } else if (action.actionType === "deprecate") {
    const deprecateArgs: Record<string, unknown> = {
      path: action.targetPath,
      agent: principal.value,
      reason: action.rationale,
    };
    // Carry through a superseded_by hint from the proposed diff if present.
    const diff = action.proposedDiff;
    if (
      diff &&
      typeof diff === "object" &&
      typeof (diff as Record<string, unknown>).superseded_by === "string"
    ) {
      deprecateArgs.superseded_by = (diff as Record<string, unknown>).superseded_by;
    }
    dispatched = await vaultDeprecate(vaultRoot, deprecateArgs, access);
  } else {
    return err(new Error(`vault_ratify: no dispatch for action type '${action.actionType}'`));
  }

  if (!dispatched.ok) return dispatched;

  const recorded = await recordDecision(vaultRoot, id.value, {
    status: "ratified",
    ratifiedAt: decidedAt,
    ratifiedBy: principal.value,
    ...(reason ? { reason } : {}),
  });
  if (!recorded.ok) return recorded;

  return ok({
    action_id: id.value,
    decision,
    applied: true,
    ...(dispatched.value.commit ? { commit: dispatched.value.commit } : {}),
  });
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

export const stagedActionTools: ToolDefinition[] = [
  {
    name: "vault_stage_action",
    title: "Stage an action for ratification",
    annotations: { destructiveHint: false },
    description:
      "Record a proposed change to the vault for later human ratification via " +
      "vault_ratify. The action waits in a pending queue and auto-expires after " +
      "ttl_days (default 14). This is the producer side of the staged-action " +
      "queue — normally called by the curation loop, not by a human directly. " +
      "Action types: promote, deprecate, supersede, merge, confidence-up " +
      "(supersede/merge/confidence-up are staged only in v1; their apply step " +
      "is deferred to §11.4).",
    inputSchema: {
      type: "object",
      properties: {
        action_type: {
          type: "string",
          enum: [...STAGED_ACTION_TYPES],
          description: "The kind of change being proposed",
        },
        target_path: {
          type: "string",
          description: "Vault-relative path of the document the action targets",
        },
        proposed_by: {
          type: "string",
          description: "Principal proposing the action, e.g. 'agent:curation-loop'",
        },
        rationale: {
          type: "string",
          description: "One-sentence explanation of why this action is proposed",
        },
        proposed_diff: {
          type: "object",
          description:
            "The proposed frontmatter delta or write payload, shape depending " +
            "on action_type. Stored verbatim and replayed on ratification.",
          additionalProperties: true,
        },
        ttl_days: {
          type: "number",
          description: "Days until the action auto-expires if not ratified (default 14)",
        },
      },
      required: ["action_type", "target_path", "proposed_by", "rationale", "proposed_diff"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultStageAction(vaultRoot, args, access),
  },
  {
    name: "vault_ratify",
    title: "Approve or reject a staged action",
    annotations: { destructiveHint: true },
    description:
      "Approve or reject a single pending staged action. On approve, dispatches " +
      "to the matching write tool (promote → vault_promote, deprecate → " +
      "vault_deprecate) and auto-commits; supersede/merge/confidence-up are " +
      "staged only in v1 and approving one returns applied=false with " +
      "deferred_to='§11.4'. On reject, records the rejection and applies " +
      "nothing. Errors if the id is unknown or the action is not pending " +
      "(already decided or expired).",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Id of the staged action to decide, e.g. 'stage-042'",
        },
        decision: {
          type: "string",
          enum: ["approve", "reject"],
          description: "Whether to approve (apply) or reject the action",
        },
        principal: {
          type: "string",
          description: "Who is deciding, e.g. 'human:mihir'. Recorded and used as the write agent.",
        },
        reason: {
          type: "string",
          description: "Optional free-text reason recorded with the decision",
        },
      },
      required: ["id", "decision", "principal"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultRatify(vaultRoot, args, access),
  },
];
