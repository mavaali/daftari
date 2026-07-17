// Staged-action queue tools: vault_stage_action (producer) and vault_ratify
// (consumer). Spec §11.2 — the "always-stage" tier of the cortex loop.
//
// vault_stage_action records a proposed change for later human ratification.
// In v1 the cortex loop that would normally call it does not exist yet, so the
// tool is exposed over MCP mainly for testing and for the future loop; a human
// would not normally call it directly.
//
// vault_ratify is the human's approve/reject gate. On approve it dispatches to
// the matching write tool for the action type. Every action type now applies on
// ratify: promote → vault_promote, deprecate → vault_deprecate, supersede →
// vault_supersede, confidence-up → vault_set_confidence, merge → vault_merge
// (the §11.4 write tools). A dispatch failure (including a malformed
// proposed_diff) leaves the action pending so it can be retried.

import { type AccessContext, canRatify, canRead, canWrite } from "../access/rbac.js";
import {
  getStagedActionById,
  nowISO,
  recordDecision,
  STAGED_ACTION_TYPES,
  type StagedActionType,
  stageActionWithConflictCheck,
} from "../curation/staged-actions.js";
import { bucketHiddenDownstream } from "../curation/tension-blast.js";
import { tier0DeprecateGate, tier0PromoteGate } from "../curation/tier0.js";
import { type LoadedDoc, loadDocuments } from "../curation/vault-docs.js";
import { parseDocument } from "../frontmatter/parser.js";
import { validateFrontmatter } from "../frontmatter/schema.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { readFile, resolveVaultPath } from "../storage/local.js";
import type { ToolDefinition } from "./read.js";
import {
  vaultDeprecate,
  vaultMerge,
  vaultPromote,
  vaultSetConfidence,
  vaultSupersede,
  vaultWrite,
  type WriteResult,
} from "./write.js";

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
  // Inter-proposal conflict surface (#235): ids of other pending proposals
  // already targeting the same document, and the tension logged for them.
  // Empty / null when the proposal is uncontested.
  conflicts_with: string[];
  tension_id: string | null;
}

export async function vaultStageAction(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<StageActionResult, Error>> {
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

  let runId: string | undefined;
  if (args.run_id !== undefined && args.run_id !== null) {
    if (typeof args.run_id !== "string") {
      return err(new Error("vault_stage_action 'run_id' must be a string"));
    }
    if (args.run_id.trim().length > 0) runId = args.run_id.trim();
  }

  // A `write` proposal carries full content; validate the payload shape at
  // stage time so a malformed one never sits in the queue until ratify.
  const isWrite = actionType.value === "write";
  if (isWrite) {
    const diff = args.proposed_diff as Record<string, unknown>;
    if (
      typeof args.proposed_diff !== "object" ||
      diff.frontmatter === null ||
      typeof diff.frontmatter !== "object" ||
      typeof diff.body !== "string"
    ) {
      return err(
        new Error(
          "vault_stage_action: a 'write' action needs proposed_diff.frontmatter " +
            "(object) and proposed_diff.body (string)",
        ),
      );
    }
  }

  const resolved = resolveVaultPath(vaultRoot, targetPath.value);
  if (!resolved.ok) return resolved;
  const exists = await readFile(resolved.value.absPath);

  // RBAC (S2): staging proposes a mutation to the target document, so it
  // requires WRITE access to that document's collection — not merely any read
  // grant. vault_ratify re-checks the `ratify` grant and the inner write tools
  // re-check canWrite/canPromote on dispatch, but the producer must be gated
  // too: a read-only role must not be able to append durable mutation proposals
  // to the queue. The gate runs BEFORE the not-found branch so a role lacking
  // write cannot probe document existence (not-found vs access-denied). The
  // collection is authoritative from the document's own frontmatter when it is
  // readable; for a not-yet-existing target it falls back to the path's leading
  // segment (the same convention the write tools use).
  if (access) {
    const parsed = exists.ok ? parseDocument(exists.value) : null;
    const collection =
      (parsed?.ok ? parsed.value.frontmatter.collection : "") ||
      (targetPath.value.split("/")[0] ?? "");
    if (!canWrite(access.role, collection)) {
      return err(
        new Error(
          `access denied: role '${access.roleName}' cannot stage actions for collection '${collection}'`,
        ),
      );
    }
  }

  // Fail fast: a lifecycle action that targets a non-existent document can
  // never be ratified (the write-tool dispatch would reject "document not
  // found"). Catch it at stage time so a bad target never sits in the queue
  // for 14 days. This is reached only by callers that already hold write
  // access (checked above). `write` proposals are exempt — creating a new
  // document is their point.
  if (!exists.ok && !isWrite) {
    return err(new Error(`vault_stage_action: target document not found: ${targetPath.value}`));
  }

  let ttlDays: number | undefined;
  if (args.ttl_days !== undefined && args.ttl_days !== null) {
    if (typeof args.ttl_days !== "number" || !Number.isFinite(args.ttl_days)) {
      return err(new Error("vault_stage_action 'ttl_days' must be a number"));
    }
    ttlDays = args.ttl_days;
  }

  return stageActionWithConflictCheck(vaultRoot, {
    actionType: actionType.value as StagedActionType,
    targetPath: targetPath.value,
    proposedBy: proposedBy.value,
    rationale: rationale.value,
    proposedDiff: args.proposed_diff,
    ...(runId !== undefined ? { runId } : {}),
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
  // True when the vault runs shadow_mode (§11.5): the dispatch was computed
  // and shadow-logged but nothing was written, so the action stays pending.
  shadow?: boolean;
}

export async function vaultRatify(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<RatifyResult, Error>> {
  // Ratifying is the curation-verdict tier (§11.6): it needs the explicit
  // `ratify` grant, not merely any read grant. The inner write tools still
  // re-check their own canWrite/canPromote on dispatch.
  if (access && !canRatify(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot ratify staged actions`));
  }

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
      ...(access?.user != null ? { decidedByPrincipal: access.user } : {}),
    });
    if (!recorded.ok) return recorded;
    return ok({ action_id: id.value, decision, applied: false });
  }

  // --- approve: dispatch by action type to the matching write tool ---
  // A dispatch failure — including a malformed proposed_diff — leaves the action
  // pending so it can be retried; no decision record is written until a write
  // lands. The proposed_diff carries the per-action payload set at stage time.
  const diff =
    action.proposedDiff && typeof action.proposedDiff === "object"
      ? (action.proposedDiff as Record<string, unknown>)
      : {};

  // Tier 0 ratify gate (#232; quick win 1 of #236). Ratification is already a
  // gate, so blocking here does not violate the advisory-curation rule — the
  // direct write tools stay unblocked. A blocked approval is an error, which
  // leaves the action pending (same contract as a dispatch failure): fix the
  // underlying state and re-approve, or reject. Under RBAC the error names
  // only docs the ratifier can read; a hidden remainder is coarsened
  // (#217 B′), never reported as an exact count.
  // A `write` proposal's payload shape is needed by both the gate and the
  // dispatch — validate it once, up front. A malformed payload errors and
  // leaves the action pending, same contract as a malformed supersede diff.
  let writePayload: { frontmatter: Record<string, unknown>; body: string } | null = null;
  if (action.actionType === "write") {
    if (diff.frontmatter === null || typeof diff.frontmatter !== "object") {
      return err(
        new Error(`vault_ratify: write action ${id.value} needs proposed_diff.frontmatter`),
      );
    }
    if (typeof diff.body !== "string") {
      return err(new Error(`vault_ratify: write action ${id.value} needs proposed_diff.body`));
    }
    writePayload = { frontmatter: diff.frontmatter as Record<string, unknown>, body: diff.body };
  }

  const proposedCanonical = writePayload?.frontmatter.status === "canonical";

  if (
    action.actionType === "promote" ||
    action.actionType === "deprecate" ||
    (action.actionType === "write" && proposedCanonical)
  ) {
    const loaded = await loadDocuments(vaultRoot);
    // Fail closed: without the doc set there is no gate, so no dispatch.
    if (!loaded.ok) return loaded;
    const visible = access
      ? (d: LoadedDoc) => canRead(access.role, d.frontmatter.collection)
      : undefined;

    if (action.actionType === "write" && writePayload) {
      // A write proposal declaring `status: canonical` is a promote in one
      // step — hold it to the same tier-0 bar. Splice the PROPOSED content in
      // as a synthetic doc (replacing any existing doc at the target) so the
      // gate judges the post-state, then reuse the promote gate wholesale.
      const { frontmatter, report } = validateFrontmatter(writePayload.frontmatter);
      const synthetic: LoadedDoc = {
        path: action.targetPath,
        frontmatter,
        content: writePayload.body,
        validation: report,
      };
      const docs = [...loaded.value.filter((d) => d.path !== action.targetPath), synthetic];
      const gate = tier0PromoteGate(docs, action.targetPath, visible);
      const problems = [...gate.violations];
      if (gate.hiddenConflicts > 0) {
        problems.push(
          `non-canonical sources hidden from your role: ${bucketHiddenDownstream(gate.hiddenConflicts)}`,
        );
      }
      if (problems.length > 0) {
        return err(
          new Error(
            `vault_ratify: tier-0 gate blocked canonical write of ${action.targetPath}: ` +
              `${problems.join("; ")} — the action stays pending`,
          ),
        );
      }
    } else if (action.actionType === "promote") {
      const gate = tier0PromoteGate(loaded.value, action.targetPath, visible);
      const problems = [...gate.violations];
      if (gate.hiddenConflicts > 0) {
        problems.push(
          `non-canonical sources hidden from your role: ${bucketHiddenDownstream(gate.hiddenConflicts)}`,
        );
      }
      if (problems.length > 0) {
        return err(
          new Error(
            `vault_ratify: tier-0 gate blocked promote of ${action.targetPath}: ` +
              `${problems.join("; ")} — the action stays pending`,
          ),
        );
      }
    } else if (typeof diff.superseded_by !== "string") {
      // A deprecate carrying a superseded_by hint forwards dependents to a
      // successor (same as supersede) — only an unforwarded deprecate can
      // strand canonical dependents on a retired source.
      const gate = tier0DeprecateGate(loaded.value, action.targetPath, visible);
      const problems: string[] = [];
      if (gate.dependents.length > 0) {
        problems.push(`cited as a source by canonical: ${gate.dependents.join(", ")}`);
      }
      if (gate.hiddenDependents > 0) {
        problems.push(
          `hidden canonical dependents: ${bucketHiddenDownstream(gate.hiddenDependents)}`,
        );
      }
      if (problems.length > 0) {
        return err(
          new Error(
            `vault_ratify: tier-0 gate blocked deprecate of ${action.targetPath}: ` +
              `${problems.join("; ")} — supersede with a successor or update the ` +
              `dependents first; the action stays pending`,
          ),
        );
      }
    }
  }

  let dispatched: Result<WriteResult, Error>;
  switch (action.actionType as StagedActionType) {
    case "write": {
      // Payload validated above (writePayload is always set for this type).
      // The proposer's run_id (stamped at stage time) is carried into the
      // write so provenance correlates the landed content with the run that
      // proposed it (#235 → #233).
      if (!writePayload) {
        return err(new Error(`vault_ratify: write action ${id.value} lost its payload`));
      }
      dispatched = await vaultWrite(
        vaultRoot,
        {
          path: action.targetPath,
          frontmatter: writePayload.frontmatter,
          body: writePayload.body,
          agent: principal.value,
          ...(action.runId ? { run_id: action.runId } : {}),
        },
        access,
      );
      break;
    }
    case "promote":
      dispatched = await vaultPromote(
        vaultRoot,
        { path: action.targetPath, agent: principal.value },
        access,
      );
      break;
    case "deprecate": {
      const deprecateArgs: Record<string, unknown> = {
        path: action.targetPath,
        agent: principal.value,
        reason: action.rationale,
      };
      // Carry through a superseded_by hint from the proposed diff if present.
      if (typeof diff.superseded_by === "string") {
        deprecateArgs.superseded_by = diff.superseded_by;
      }
      dispatched = await vaultDeprecate(vaultRoot, deprecateArgs, access);
      break;
    }
    case "supersede": {
      // proposed_diff = { superseded_by: "<new_path>" }
      if (typeof diff.superseded_by !== "string" || diff.superseded_by.trim().length === 0) {
        return err(
          new Error(`vault_ratify: supersede action ${id.value} needs proposed_diff.superseded_by`),
        );
      }
      dispatched = await vaultSupersede(
        vaultRoot,
        {
          old_path: action.targetPath,
          new_path: diff.superseded_by,
          reason: action.rationale,
          agent: principal.value,
        },
        access,
      );
      break;
    }
    case "confidence-up": {
      // proposed_diff = { confidence: "<low|medium|high>" }. The enum name is
      // confidence-up; the tool that applies it is vault_set_confidence.
      if (typeof diff.confidence !== "string") {
        return err(
          new Error(
            `vault_ratify: confidence-up action ${id.value} needs proposed_diff.confidence`,
          ),
        );
      }
      dispatched = await vaultSetConfidence(
        vaultRoot,
        {
          path: action.targetPath,
          confidence: diff.confidence,
          reason: action.rationale,
          agent: principal.value,
        },
        access,
      );
      break;
    }
    case "merge": {
      // proposed_diff = { merge_from: [path_a, path_b], body, frontmatter? };
      // the staged target_path is the merge target.
      const mergeFrom = Array.isArray(diff.merge_from) ? diff.merge_from : null;
      if (
        !mergeFrom ||
        mergeFrom.length !== 2 ||
        typeof mergeFrom[0] !== "string" ||
        typeof mergeFrom[1] !== "string" ||
        typeof diff.body !== "string"
      ) {
        return err(
          new Error(
            `vault_ratify: merge action ${id.value} needs proposed_diff.merge_from ` +
              "(two paths) and proposed_diff.body",
          ),
        );
      }
      const mergeArgs: Record<string, unknown> = {
        path_a: mergeFrom[0],
        path_b: mergeFrom[1],
        target_path: action.targetPath,
        body: diff.body,
        agent: principal.value,
      };
      if (diff.frontmatter && typeof diff.frontmatter === "object") {
        mergeArgs.frontmatter = diff.frontmatter;
      }
      dispatched = await vaultMerge(vaultRoot, mergeArgs, access);
      break;
    }
    default:
      return err(new Error(`vault_ratify: no dispatch for action type '${action.actionType}'`));
  }

  if (!dispatched.ok) return dispatched;

  // Shadow mode (§11.5): the dispatch computed and shadow-logged the write but
  // applied nothing. Recording a `ratified` decision over a write that never
  // landed would be false history — leave the action pending so a live-mode
  // ratification can really apply it later.
  if (dispatched.value.shadow) {
    return ok({ action_id: id.value, decision, applied: false, shadow: true });
  }

  const recorded = await recordDecision(vaultRoot, id.value, {
    status: "ratified",
    ratifiedAt: decidedAt,
    ratifiedBy: principal.value,
    ...(reason ? { reason } : {}),
    ...(access?.user != null ? { decidedByPrincipal: access.user } : {}),
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
      "queue — normally called by the curation loop or an agent, not by a human " +
      "directly. Action types: promote, deprecate, supersede, merge, " +
      "confidence-up, write. proposed_diff carries the per-action payload " +
      "replayed on ratification: supersede → {superseded_by}, confidence-up → " +
      "{confidence}, merge → {merge_from: [path_a, path_b], body, frontmatter?}, " +
      "write → {frontmatter, body} (full content; the target may be a new " +
      "document). If other pending proposals already target the same document, " +
      "the new one still lands — both stay pending — and an inter-proposal " +
      "tension is logged; the result carries conflicts_with and tension_id.",
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
        run_id: {
          type: "string",
          description:
            "Optional trace/run identifier of the proposing run. Recorded on " +
            "the proposal and carried into provenance when a write action is " +
            "ratified.",
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
      "vault_deprecate, supersede → vault_supersede, confidence-up → " +
      "vault_set_confidence, merge → vault_merge, write → vault_write) and " +
      "auto-commits. On reject, " +
      "records the rejection and applies nothing. A dispatch failure leaves the " +
      "action pending. Approving a promote, an unforwarded deprecate, or a " +
      "write that declares status canonical runs the " +
      "tier-0 gate first (#232): if applying would create a certain structural " +
      "violation (broken source refs, canonical citing draft/deprecated/archived, " +
      "schema-invalid frontmatter, stranded canonical dependents), the approval " +
      "errors and the action stays pending — fix the state and re-approve, or " +
      "reject. Errors if the id is unknown or the action is not pending " +
      "(already decided or expired). Requires the role's 'ratify' grant. If " +
      "the vault runs shadow_mode, an approved dispatch is computed and " +
      "shadow-logged but NOT applied — the result carries shadow: true and " +
      "the action stays pending for a live ratification later.",
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
