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
//
// 2026-07-26 risk-triaged-ratification spec (Decisions 2 + 3) extended
// vault_ratify with: a batch `ids` alternative to `id` (Decision 2); a
// required-on-reject `reason_category` and an optional `amended_diff` that
// dispatches an edit-then-approve instead of the staged diff (Decision 3);
// and — per Mihir's 2026-07-27 decision resolving the spec's Decision-1 /
// kill-condition-#1 contradiction — a non-authoritative `risk_at_decision`
// snapshot on every decision record. The single-action approve/reject path is
// extracted into approveOneAction/rejectOneAction so the batch path and the
// single-`id` path share one implementation; a batch is N independent verdicts
// processed sequentially, never a transactional compound one.

import { type AccessContext, canRatify, canRead, canWrite, isProposeOnly } from "../access/rbac.js";
import { BATCH_RATIFY_MAX, rankPendingActions } from "../curation/risk.js";
import {
  DECISION_KINDS,
  type DecisionKind,
  getStagedActionById,
  listStagedActions,
  nowISO,
  REASON_CATEGORIES,
  type ReasonCategory,
  recordDecision,
  STAGED_ACTION_TYPES,
  type StagedAction,
  type StagedActionType,
  stageActionWithConflictCheck,
} from "../curation/staged-actions.js";
import { listTensions } from "../curation/tension.js";
import { bucketHiddenDownstream } from "../curation/tension-blast.js";
import { tier0DeprecateGate, tier0PromoteGate } from "../curation/tier0.js";
import { type LoadedDoc, loadDocuments } from "../curation/vault-docs.js";
import { parseDocument } from "../frontmatter/parser.js";
import { validateFrontmatter } from "../frontmatter/schema.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { readFile, resolveVaultPath } from "../storage/local.js";
import { loadConfig } from "../utils/config.js";
import { log as gitLog } from "../utils/git.js";
import { readRunId } from "../utils/run-id.js";
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
  // Present when the proposal staged but the inter-proposal tension could not
  // be written (see StageOutcome.tension_error) — the conflict is still in
  // conflicts_with; this names why the tension log entry is missing.
  tension_error?: string;
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

  const runId = readRunId(args, "vault_stage_action");
  if (!runId.ok) return runId;

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
  // readable; for a not-yet-existing target it falls back to the leading
  // segment of the NORMALIZED path (resolved.relPath), never the raw caller
  // string — `pricing/../competitive-intel/x.md` splits to "pricing" raw but
  // resolves to competitive-intel, and with `write` targets allowed to not
  // exist, gating on the raw string would let a pricing-only role queue
  // proposals into collections it cannot write (same S1 rule as write.ts's
  // targetCollection).
  if (access) {
    const parsed = exists.ok ? parseDocument(exists.value) : null;
    const collection =
      (parsed?.ok ? parsed.value.frontmatter.collection : "") ||
      (resolved.value.relPath.split("/")[0] ?? "");
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

  // Stage the CANONICAL relPath, not the raw caller string, so aliased
  // spellings of one target contend in conflict detection and the queued
  // target matches what dispatch will actually write (#127/#128 rule).
  return stageActionWithConflictCheck(vaultRoot, {
    actionType: actionType.value as StagedActionType,
    targetPath: resolved.value.relPath,
    proposedBy: proposedBy.value,
    rationale: rationale.value,
    proposedDiff: args.proposed_diff,
    ...(runId.value !== undefined ? { runId: runId.value } : {}),
    ...(ttlDays !== undefined ? { ttlDays } : {}),
    // C4 disposition (risk-triaged-ratification spec): the authenticated
    // identity, when present, is the tally key the witness and the risk
    // scorer's W term read — `proposed_by` remains claimed-agent display
    // metadata only. Absent under operator context (no AccessContext).
    ...(access?.user != null ? { stagedByPrincipal: access.user } : {}),
  });
}

// ---------------------------------------------------------------------------
// vault_ratify
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// vault_ratify form-mode elicitation (spec 2026-07-26, Decision 5)
// ---------------------------------------------------------------------------

// What one elicitation round needs: the form prompt, the action it decides,
// and the vault HEAD at proposal time — the payload server.ts seals into the
// signed opaque request state. The MCP wiring (inputRequired, the state
// codec) stays in server.ts; this function is the tool layer's share: the
// same gates vaultRatify runs, so a role that could not ratify never sees a
// form, and an unknown/decided action errors before any round-trip starts.
// Single-id only — server.ts only enters this path when the call has no
// `ids` (see createServer's CallTool handler).
export interface RatifyElicitationSpec {
  actionId: string;
  message: string;
  head: string | null;
}

export async function describeRatifyElicitation(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<RatifyElicitationSpec, Error>> {
  if (access && !canRatify(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot ratify staged actions`));
  }
  if (access && isProposeOnly(access.role)) {
    return err(
      new Error(
        `access denied: role '${access.roleName}' is propose-only — it cannot ` +
          `ratify staged actions`,
      ),
    );
  }
  const id = requireString(args, "id", "vault_ratify");
  if (!id.ok) return id;
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
  // HEAD at proposal time rides the signed state for the audit trail; the
  // dispatch path re-validates pending/conflict-free on resubmit regardless,
  // so a missing HEAD (no git yet) degrades to null rather than blocking.
  const head = await gitLog(vaultRoot, { limit: 1 });
  return ok({
    actionId: id.value,
    message:
      `Ratify staged action ${id.value}: ${action.actionType} ${action.targetPath}?` +
      (action.rationale ? ` Rationale: ${action.rationale}` : ""),
    head: head.ok ? (head.value[0]?.hash ?? null) : null,
  });
}

export interface RatifyResult {
  action_id: string;
  decision: "approve" | "reject";
  applied: boolean;
  commit?: string;
  // True when the vault runs shadow_mode (§11.5): the dispatch was computed
  // and shadow-logged but nothing was written, so the action stays pending.
  shadow?: boolean;
  // Derived server-side, never an input: 'reject' on reject; 'approve' for a
  // plain approval; 'edit-then-approve' when the caller supplied amended_diff.
  // Absent on a shadow-mode approve (no decision was recorded).
  decision_kind?: DecisionKind;
}

// One id's outcome within a batch `ids` call. `ok` is false for anything that
// kept the action pending: unknown id, not-pending, a blocked tier-0 gate, or
// a dispatch failure — the same per-id failure modes the single-id path
// returns as an err, just captured instead of short-circuiting the batch.
export interface BatchRatifyOutcome {
  action_id: string;
  ok: boolean;
  applied: boolean;
  shadow?: boolean;
  commit?: string;
  decision_kind?: DecisionKind;
  error?: string;
}

export interface BatchRatifyResult {
  decision: "approve" | "reject";
  results: BatchRatifyOutcome[];
  succeeded: number;
  failed: number;
}

// The two tier-0 gate problem assemblies, shared by the four ratify gate
// sites (direct promote/deprecate and their synthetic-write mirrors). Hidden
// counts are coarsened (#217) — never exact. Null when the gate passes.
function promoteGateProblems(gate: ReturnType<typeof tier0PromoteGate>): string | null {
  const problems = [...gate.violations];
  if (gate.hiddenConflicts > 0) {
    problems.push(
      `non-canonical sources hidden from your role: ${bucketHiddenDownstream(gate.hiddenConflicts)}`,
    );
  }
  return problems.length > 0 ? problems.join("; ") : null;
}

function deprecateGateProblems(gate: ReturnType<typeof tier0DeprecateGate>): string | null {
  const problems: string[] = [];
  if (gate.dependents.length > 0) {
    problems.push(`cited as a source by canonical: ${gate.dependents.join(", ")}`);
  }
  if (gate.hiddenDependents > 0) {
    problems.push(`hidden canonical dependents: ${bucketHiddenDownstream(gate.hiddenDependents)}`);
  }
  return problems.length > 0 ? problems.join("; ") : null;
}

// Approves ONE action: validates the (possibly amended) payload shape, runs
// the tier-0 gates against it, and dispatches to the matching write tool. No
// decision record is written here — the caller (vaultRatify) records the
// decision only after a live (non-shadow) dispatch succeeds, exactly the
// original single-action contract. `docs` is the caller's already-loaded doc
// set — batch callers pass a hoisted, invalidate-on-write snapshot (2026-07-26
// spec, C2 disposition); the single-id path (docs === undefined) loads fresh,
// matching pre-refactor behavior exactly.
async function approveOneAction(
  vaultRoot: string,
  action: StagedAction,
  diffRaw: unknown,
  principal: string,
  access: AccessContext | undefined,
  docs: LoadedDoc[] | undefined,
): Promise<Result<WriteResult, Error>> {
  const diff = diffRaw && typeof diffRaw === "object" ? (diffRaw as Record<string, unknown>) : {};

  let writePayload: { frontmatter: Record<string, unknown>; body: string } | null = null;
  if (action.actionType === "write") {
    if (diff.frontmatter === null || typeof diff.frontmatter !== "object") {
      return err(
        new Error(`vault_ratify: write action ${action.id} needs proposed_diff.frontmatter`),
      );
    }
    if (typeof diff.body !== "string") {
      return err(new Error(`vault_ratify: write action ${action.id} needs proposed_diff.body`));
    }
    writePayload = { frontmatter: diff.frontmatter as Record<string, unknown>, body: diff.body };
  }

  if (
    action.actionType === "promote" ||
    action.actionType === "deprecate" ||
    action.actionType === "write"
  ) {
    let loadedDocs: LoadedDoc[];
    if (docs) {
      loadedDocs = docs;
    } else {
      const loaded = await loadDocuments(vaultRoot);
      // Fail closed: without the doc set there is no gate, so no dispatch.
      if (!loaded.ok) return loaded;
      loadedDocs = loaded.value;
    }
    const visible = access
      ? (d: LoadedDoc) => canRead(access.role, d.frontmatter.collection)
      : undefined;

    if (action.actionType === "write" && writePayload) {
      // A write proposal whose POST-state is canonical is a promote in one
      // step — hold it to the same tier-0 bar. The post-state is NOT the
      // payload as submitted: vaultWrite's update path merges the payload
      // UNDER the existing frontmatter (#113 — omitted keys are inherited,
      // explicit nulls delete), so gate the same merge. Judging the payload
      // alone has two bypasses: omitted `sources` inherit the on-disk value
      // unseen, and an omitted `status` on an already-canonical doc keeps it
      // canonical while dodging a payload-declared-status check.
      const existing = loadedDocs.find((d) => d.path === action.targetPath);
      const mergedRaw: Record<string, unknown> = existing
        ? { ...(existing.frontmatter as Record<string, unknown>) }
        : {};
      for (const [key, value] of Object.entries(writePayload.frontmatter)) {
        if (value === null) delete mergedRaw[key];
        else mergedRaw[key] = value;
      }
      // Validate with the vault's schema extensions, same as the dispatch —
      // without them a required extension field missing from a canonical
      // write proposal would slip past the tier-0 schema check and only fail
      // later with the generic invalid-frontmatter error.
      const gateConfig = loadConfig(vaultRoot);
      if (!gateConfig.ok) return gateConfig;
      const { frontmatter, report } = validateFrontmatter(
        mergedRaw,
        gateConfig.value.schemaExtensions,
      );
      if (frontmatter.status === "canonical") {
        // Splice the merged post-state in as a synthetic doc (replacing any
        // existing doc at the target) and reuse the promote gate wholesale.
        const synthetic: LoadedDoc = {
          path: action.targetPath,
          frontmatter,
          content: writePayload.body,
          validation: report,
        };
        const spliced = [...loadedDocs.filter((d) => d.path !== action.targetPath), synthetic];
        const problems = promoteGateProblems(tier0PromoteGate(spliced, action.targetPath, visible));
        if (problems !== null) {
          return err(
            new Error(
              `vault_ratify: tier-0 gate blocked canonical write of ${action.targetPath}: ` +
                `${problems} — the action stays pending`,
            ),
          );
        }
      } else if (
        existing?.frontmatter.status === "canonical" &&
        !(typeof frontmatter.superseded_by === "string" && frontmatter.superseded_by.length > 0)
      ) {
        // The mirror case: a write whose merged post-state moves an
        // already-canonical doc AWAY from canonical is a deprecate in one
        // step — without a superseded_by forward it strands canonical
        // dependents exactly like an unforwarded staged deprecate, so it
        // gets the same gate. A merged superseded_by provides the
        // resolution path and passes, same as a forwarded deprecate.
        const problems = deprecateGateProblems(
          tier0DeprecateGate(loadedDocs, action.targetPath, visible),
        );
        if (problems !== null) {
          return err(
            new Error(
              `vault_ratify: tier-0 gate blocked demoting write of ${action.targetPath} ` +
                `(canonical → ${frontmatter.status}): ${problems} — supersede ` +
                `with a successor or update the dependents first; the action stays pending`,
            ),
          );
        }
      }
    } else if (action.actionType === "promote") {
      const problems = promoteGateProblems(
        tier0PromoteGate(loadedDocs, action.targetPath, visible),
      );
      if (problems !== null) {
        return err(
          new Error(
            `vault_ratify: tier-0 gate blocked promote of ${action.targetPath}: ` +
              `${problems} — the action stays pending`,
          ),
        );
      }
    } else if (typeof diff.superseded_by !== "string") {
      // A deprecate carrying a superseded_by hint forwards dependents to a
      // successor (same as supersede) — only an unforwarded deprecate can
      // strand canonical dependents on a retired source.
      const problems = deprecateGateProblems(
        tier0DeprecateGate(loadedDocs, action.targetPath, visible),
      );
      if (problems !== null) {
        return err(
          new Error(
            `vault_ratify: tier-0 gate blocked deprecate of ${action.targetPath}: ` +
              `${problems} — supersede with a successor or update the ` +
              `dependents first; the action stays pending`,
          ),
        );
      }
    }
  }

  switch (action.actionType as StagedActionType) {
    case "write": {
      // Payload validated above (writePayload is always set for this type).
      // The proposer's run_id (stamped at stage time) is carried into the
      // write so provenance correlates the landed content with the run that
      // proposed it (#235 → #233).
      if (!writePayload) {
        return err(new Error(`vault_ratify: write action ${action.id} lost its payload`));
      }
      return vaultWrite(
        vaultRoot,
        {
          path: action.targetPath,
          frontmatter: writePayload.frontmatter,
          body: writePayload.body,
          agent: principal,
          ...(action.runId ? { run_id: action.runId } : {}),
        },
        access,
      );
    }
    case "promote":
      return vaultPromote(vaultRoot, { path: action.targetPath, agent: principal }, access);
    case "deprecate": {
      const deprecateArgs: Record<string, unknown> = {
        path: action.targetPath,
        agent: principal,
        reason: action.rationale,
      };
      // Carry through a superseded_by hint from the proposed diff if present.
      if (typeof diff.superseded_by === "string") {
        deprecateArgs.superseded_by = diff.superseded_by;
      }
      return vaultDeprecate(vaultRoot, deprecateArgs, access);
    }
    case "supersede": {
      // proposed_diff = { superseded_by: "<new_path>" }
      if (typeof diff.superseded_by !== "string" || diff.superseded_by.trim().length === 0) {
        return err(
          new Error(
            `vault_ratify: supersede action ${action.id} needs proposed_diff.superseded_by`,
          ),
        );
      }
      return vaultSupersede(
        vaultRoot,
        {
          old_path: action.targetPath,
          new_path: diff.superseded_by,
          reason: action.rationale,
          agent: principal,
        },
        access,
      );
    }
    case "confidence-up": {
      // proposed_diff = { confidence: "<low|medium|high>" }. The enum name is
      // confidence-up; the tool that applies it is vault_set_confidence.
      if (typeof diff.confidence !== "string") {
        return err(
          new Error(
            `vault_ratify: confidence-up action ${action.id} needs proposed_diff.confidence`,
          ),
        );
      }
      return vaultSetConfidence(
        vaultRoot,
        {
          path: action.targetPath,
          confidence: diff.confidence,
          reason: action.rationale,
          agent: principal,
        },
        access,
      );
    }
    case "merge": {
      // proposed_diff = { merge_from: [path_a, path_b], body, frontmatter? };
      // the staged target_path is the merge target.
      const mergeFrom = Array.isArray(diff.merge_from) ? diff.merge_from : null;
      if (
        mergeFrom?.length !== 2 ||
        typeof mergeFrom[0] !== "string" ||
        typeof mergeFrom[1] !== "string" ||
        typeof diff.body !== "string"
      ) {
        return err(
          new Error(
            `vault_ratify: merge action ${action.id} needs proposed_diff.merge_from ` +
              "(two paths) and proposed_diff.body",
          ),
        );
      }
      const mergeArgs: Record<string, unknown> = {
        path_a: mergeFrom[0],
        path_b: mergeFrom[1],
        target_path: action.targetPath,
        body: diff.body,
        agent: principal,
      };
      if (diff.frontmatter && typeof diff.frontmatter === "object") {
        mergeArgs.frontmatter = diff.frontmatter;
      }
      return vaultMerge(vaultRoot, mergeArgs, access);
    }
    default:
      return err(new Error(`vault_ratify: no dispatch for action type '${action.actionType}'`));
  }
}

// Rejects ONE action: records the decision, applies nothing. Thin wrapper
// kept separate from approveOneAction per the plan's refactor (C2) — the
// reject path has no gate/dispatch, only bookkeeping.
async function rejectOneAction(
  vaultRoot: string,
  actionId: string,
  principal: string,
  reason: string | undefined,
  reasonCategory: ReasonCategory | undefined,
  riskAtDecision: number | null,
  decidedAt: string,
  access: AccessContext | undefined,
): Promise<Result<StagedAction, Error>> {
  return recordDecision(vaultRoot, actionId, {
    status: "rejected",
    ratifiedAt: decidedAt,
    ratifiedBy: principal,
    decisionKind: "reject",
    ...(reason ? { reason } : {}),
    ...(reasonCategory ? { reasonCategory } : {}),
    ...(riskAtDecision !== null ? { riskAtDecision } : {}),
    ...(access?.user != null ? { decidedByPrincipal: access.user } : {}),
  });
}

export async function vaultRatify(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<RatifyResult | BatchRatifyResult, Error>> {
  // Ratifying is the curation-verdict tier (§11.6): it needs the explicit
  // `ratify` grant, not merely any read grant. The inner write tools still
  // re-check their own canWrite/canPromote on dispatch.
  if (access && !canRatify(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot ratify staged actions`));
  }
  // A propose-only role must never ratify, even if a hand-built role grants
  // both (config load rejects the combination, but AccessContexts constructed
  // in code bypass that). Without this, approving a `write` action would be
  // coerced by vaultWrite's propose-only path into staging a NEW proposal
  // while the original got marked ratified/applied — a silent no-op.
  if (access && isProposeOnly(access.role)) {
    return err(
      new Error(
        `access denied: role '${access.roleName}' is propose-only — it cannot ` +
          `ratify staged actions`,
      ),
    );
  }

  // --- id / ids: exactly one, batch shape validated up front (Decision 2) ---
  const hasId = typeof args.id === "string" && args.id.trim().length > 0;
  const hasIds = args.ids !== undefined && args.ids !== null;
  if (hasId && hasIds) {
    return err(new Error("vault_ratify accepts exactly one of 'id' or 'ids', not both"));
  }
  if (!hasId && !hasIds) {
    return err(new Error("vault_ratify requires exactly one of 'id' or 'ids'"));
  }

  let ids: string[];
  if (hasIds) {
    if (!Array.isArray(args.ids)) {
      return err(new Error("vault_ratify 'ids' must be an array of strings"));
    }
    if (args.ids.length === 0) {
      return err(new Error("vault_ratify 'ids' must not be empty"));
    }
    if (args.ids.length > BATCH_RATIFY_MAX) {
      return err(
        new Error(`vault_ratify 'ids' must not exceed ${BATCH_RATIFY_MAX} — the batch cap`),
      );
    }
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const raw of args.ids) {
      if (typeof raw !== "string" || raw.trim().length === 0) {
        return err(new Error("vault_ratify 'ids' must be an array of non-empty strings"));
      }
      const v = raw.trim();
      if (seen.has(v)) {
        return err(new Error(`vault_ratify 'ids' contains a duplicate id: ${v}`));
      }
      seen.add(v);
      cleaned.push(v);
    }
    ids = cleaned;
  } else {
    ids = [(args.id as string).trim()];
  }

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

  // --- reason_category (Decision 3 / C6): required on reject, optional on
  // plain approve, required alongside amended_diff. No silent default — an
  // un-chosen 'other' would gut the calibration signal the category exists
  // to collect. ---
  let reasonCategory: ReasonCategory | undefined;
  if (args.reason_category !== undefined && args.reason_category !== null) {
    if (
      typeof args.reason_category !== "string" ||
      !(REASON_CATEGORIES as readonly string[]).includes(args.reason_category)
    ) {
      return err(
        new Error(`vault_ratify 'reason_category' must be one of: ${REASON_CATEGORIES.join(", ")}`),
      );
    }
    reasonCategory = args.reason_category as ReasonCategory;
  }

  // --- amended_diff (Decision 3): single-id, approve-only ---
  const hasAmendedDiff = args.amended_diff !== undefined && args.amended_diff !== null;
  let amendedDiff: unknown;
  if (hasAmendedDiff) {
    if (hasIds) {
      return err(
        new Error(
          "vault_ratify 'amended_diff' is single-id only — an amendment is per-action " +
            "deliberation, incompatible with 'ids'",
        ),
      );
    }
    if (decision !== "approve") {
      return err(new Error("vault_ratify 'amended_diff' is only valid with decision 'approve'"));
    }
    if (typeof args.amended_diff !== "object") {
      return err(new Error("vault_ratify 'amended_diff' must be an object"));
    }
    amendedDiff = args.amended_diff;
  }

  // This is an INTENTIONAL, spec-mandated contract break for reject callers
  // (C6 disposition): the `decision` enum and every approve-path caller are
  // untouched; reject now requires reason_category. The error enumerates the
  // categories so an agent caller self-corrects in one round trip.
  if (decision === "reject" && reasonCategory === undefined) {
    return err(
      new Error(
        `vault_ratify: 'reason_category' is required on reject — one of: ` +
          `${REASON_CATEGORIES.join(", ")}`,
      ),
    );
  }
  if (hasAmendedDiff && reasonCategory === undefined) {
    return err(
      new Error(
        `vault_ratify: 'reason_category' is required with 'amended_diff' — one of: ` +
          `${REASON_CATEGORIES.join(", ")}`,
      ),
    );
  }

  // Shadow mode + amended_diff (C7): silently discarding an operator-authored
  // amendment is the one option this must never do. Shadow mode records no
  // decisions of any kind today (that recording surface belongs to the
  // shadow-mode graduation story, out of scope here per the spec's own
  // boundaries) — so an amendment under shadow is an explicit error instead.
  if (hasAmendedDiff) {
    const shadowConfig = loadConfig(vaultRoot);
    if (!shadowConfig.ok) return shadowConfig;
    if (shadowConfig.value.shadowMode) {
      return err(
        new Error(
          "vault_ratify: shadow mode is active for this action type; the amendment would be " +
            "discarded — re-issue without amended_diff, or ratify after shadow mode is lifted",
        ),
      );
    }
  }

  // --- hoist: collapse the log once, load tensions and docs once (C2) ---
  const actionsRes = await listStagedActions(vaultRoot);
  if (!actionsRes.ok) return actionsRes;
  const tensionsRes = await listTensions(vaultRoot);
  if (!tensionsRes.ok) return tensionsRes;
  const docsRes = await loadDocuments(vaultRoot);
  if (!docsRes.ok) return docsRes;
  let docs = docsRes.value;

  const actionsById = new Map(actionsRes.value.map((a) => [a.id, a] as const));
  const now = new Date();

  // The non-authoritative risk_at_decision snapshot (Mihir's 2026-07-27
  // decision): computed ONCE from this hoisted, pre-decision snapshot and
  // reused for every id in the call (single or batch) — consistent with the
  // batch's cost discipline and with the field's own "frozen observation,
  // never re-read for ordering" framing. Full-graph (no pathVisible).
  const { items: rankedAtStart } = rankPendingActions({
    actions: actionsRes.value,
    docs,
    tensions: tensionsRes.value,
    now,
  });
  const riskById = new Map(rankedAtStart.map((i) => [i.id, i.risk] as const));

  const decidedAt = nowISO();
  const results: BatchRatifyOutcome[] = [];

  for (const id of ids) {
    const action = actionsById.get(id);
    if (!action) {
      results.push({
        action_id: id,
        ok: false,
        applied: false,
        error: `vault_ratify: unknown staged action: ${id}`,
      });
      continue;
    }
    if (action.status !== "pending") {
      results.push({
        action_id: id,
        ok: false,
        applied: false,
        error:
          `vault_ratify: staged action ${id} is '${action.status}', not 'pending' — ` +
          "it cannot be ratified",
      });
      continue;
    }

    // action.status === "pending" here (checked above), so it was necessarily
    // scored into rankedAtStart / riskById above — the fallback is defensive
    // only (e.g. a future refactor that filters riskById).
    const riskAtDecision = riskById.get(id) ?? null;

    if (decision === "reject") {
      const recorded = await rejectOneAction(
        vaultRoot,
        id,
        principal.value,
        reason,
        reasonCategory,
        riskAtDecision,
        decidedAt,
        access,
      );
      if (!recorded.ok) {
        results.push({ action_id: id, ok: false, applied: false, error: recorded.error.message });
        continue;
      }
      results.push({ action_id: id, ok: true, applied: false, decision_kind: "reject" });
      continue;
    }

    // --- approve ---
    const isAmending = !hasIds && hasAmendedDiff;
    const effectiveDiffRaw = isAmending ? amendedDiff : action.proposedDiff;
    const decisionKind: DecisionKind = isAmending ? "edit-then-approve" : "approve";

    const dispatched = await approveOneAction(
      vaultRoot,
      action,
      effectiveDiffRaw,
      principal.value,
      access,
      docs,
    );
    if (!dispatched.ok) {
      results.push({ action_id: id, ok: false, applied: false, error: dispatched.error.message });
      continue;
    }

    // Shadow mode (§11.5): the dispatch computed and shadow-logged the write
    // but applied nothing. Recording a `ratified` decision over a write that
    // never landed would be false history — leave the action pending so a
    // live-mode ratification can really apply it later.
    if (dispatched.value.shadow) {
      results.push({ action_id: id, ok: true, applied: false, shadow: true });
      continue;
    }

    const recorded = await recordDecision(vaultRoot, id, {
      status: "ratified",
      ratifiedAt: decidedAt,
      ratifiedBy: principal.value,
      decisionKind,
      ...(reason ? { reason } : {}),
      ...(reasonCategory ? { reasonCategory } : {}),
      ...(isAmending ? { amendedDiff: effectiveDiffRaw } : {}),
      ...(riskAtDecision !== null ? { riskAtDecision } : {}),
      ...(access?.user != null ? { decidedByPrincipal: access.user } : {}),
    });
    if (!recorded.ok) {
      // The write LANDED but the decision record failed to append — surface
      // loudly rather than silently losing the outcome; `applied` is still
      // true because the mutation and its commit are real.
      results.push({
        action_id: id,
        ok: false,
        applied: true,
        ...(dispatched.value.commit ? { commit: dispatched.value.commit } : {}),
        error: recorded.error.message,
      });
      continue;
    }

    results.push({
      action_id: id,
      ok: true,
      applied: true,
      decision_kind: decisionKind,
      ...(dispatched.value.commit ? { commit: dispatched.value.commit } : {}),
    });

    // Invalidate-on-write (C2): this dispatch mutated the vault, so later
    // ids' tier-0 gates must see the mutated state. Reloading only here keeps
    // the common cases (batch reject, gate-blocked batches, shadow) to one
    // load total. A reload failure means the vault is now in an unknown
    // state relative to what later gates would check — fail the whole call
    // rather than gate the rest against stale docs; every id decided so far
    // is already durably recorded (recordDecision/rejectOneAction already
    // landed), so this is safe to surface as an error and re-issue.
    const reloaded = await loadDocuments(vaultRoot);
    if (!reloaded.ok) return reloaded;
    docs = reloaded.value;
  }

  if (!hasIds) {
    const single = results[0];
    if (!single) return err(new Error(`vault_ratify: no outcome recorded for ${ids[0]}`));
    if (!single.ok)
      return err(new Error(single.error ?? `vault_ratify: ${single.action_id} failed`));
    return ok({
      action_id: single.action_id,
      decision,
      applied: single.applied,
      ...(single.commit ? { commit: single.commit } : {}),
      ...(single.shadow ? { shadow: true } : {}),
      ...(single.decision_kind ? { decision_kind: single.decision_kind } : {}),
    });
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  return ok({ decision, results, succeeded, failed });
}

// ---------------------------------------------------------------------------
// Output schemas (spec 2026-07-26, Decision 3)
// ---------------------------------------------------------------------------

const stageActionOutputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    id: { type: "string", description: "Id of the staged proposal, e.g. 'stage-042'" },
    expires_at: { type: "string", description: "ISO 8601 instant the proposal auto-expires" },
    // #235: empty when the proposal is uncontested.
    conflicts_with: {
      type: "array",
      items: { type: "string" },
      description: "Ids of other pending proposals already targeting the same document",
    },
    tension_id: {
      type: ["string", "null"],
      description: "Id of the inter-proposal tension logged for the conflict, null when none",
    },
    // Present only when the proposal staged but the tension write failed —
    // the conflict is still in conflicts_with; this names why the log entry
    // is missing.
    tension_error: { type: "string" },
  },
  required: ["id", "expires_at", "conflicts_with", "tension_id"],
  additionalProperties: false,
};

const ratifySingleOutputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    action_id: { type: "string" },
    decision: { type: "string", enum: ["approve", "reject"] },
    applied: {
      type: "boolean",
      description: "True only when the dispatch actually wrote; false on reject and in shadow mode",
    },
    commit: { type: "string", description: "Git commit the applied write landed in" },
    // §11.5: computed and shadow-logged but not written — the action stays
    // pending for a live ratification later.
    shadow: { type: "boolean" },
    decision_kind: {
      type: "string",
      enum: [...DECISION_KINDS],
      description:
        "Present on approve: 'approve', or 'edit-then-approve' when amended_diff was used",
    },
  },
  required: ["action_id", "decision", "applied"],
  additionalProperties: false,
};

const ratifyBatchOutcomeSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    action_id: { type: "string" },
    ok: { type: "boolean", description: "False for anything that left the action pending" },
    applied: { type: "boolean" },
    shadow: { type: "boolean" },
    commit: { type: "string" },
    decision_kind: { type: "string", enum: [...DECISION_KINDS] },
    error: { type: "string" },
  },
  required: ["action_id", "ok", "applied"],
  additionalProperties: false,
};

const ratifyBatchOutputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["approve", "reject"] },
    results: { type: "array", items: ratifyBatchOutcomeSchema },
    succeeded: { type: "integer" },
    failed: { type: "integer" },
  },
  required: ["decision", "results", "succeeded", "failed"],
  additionalProperties: false,
};

// Decision 2: a single-`id` call keeps today's RatifyResult shape (plus the
// optional decision_kind); a batch `ids` call returns the aggregate shape.
// The two are structurally disjoint (results/succeeded/failed vs
// action_id/applied), so anyOf is unambiguous for a validator. MCP requires
// `type: 'object'` at the outputSchema root (Tool.outputSchema in the SDK's
// types.ts) — harmless here since both anyOf branches are themselves object
// schemas, so the extra top-level constraint is redundant, never conflicting.
const ratifyOutputSchema: Record<string, unknown> = {
  type: "object",
  anyOf: [ratifySingleOutputSchema, ratifyBatchOutputSchema],
};

// ---------------------------------------------------------------------------
// Compact `content` summaries (spec 2026-07-26, Decision 3, PR 1 gap
// closure). Neither tool's docLinks names a path: the target document
// itself is not part of either result value (StageActionResult carries only
// the proposal's own id/expiry; RatifyResult carries only the decision),
// and the docLinks hard rule forbids inventing one from args.
// ---------------------------------------------------------------------------

function summarizeStageAction(value: unknown): string {
  const r = value as StageActionResult;
  const conflicts =
    r.conflicts_with.length > 0
      ? `conflicts with ${r.conflicts_with.length}: ${r.conflicts_with.join(", ")}`
      : "uncontested";
  const lines = [`staged ${r.id}, expires ${r.expires_at} — ${conflicts}`];
  if (r.tension_id) lines.push(`tension: ${r.tension_id}`);
  if (r.tension_error) lines.push(`tension error: ${r.tension_error}`);
  return lines.join("\n");
}

function isBatchRatifyResult(value: unknown): value is BatchRatifyResult {
  return typeof value === "object" && value !== null && "results" in value;
}

function summarizeRatify(value: unknown): string {
  if (isBatchRatifyResult(value)) {
    const lines = [
      `batch ${value.decision}: ${value.succeeded} succeeded, ${value.failed} failed ` +
        `(${value.results.length} total)`,
    ];
    for (const r of value.results) {
      const outcome = !r.ok
        ? `error: ${r.error ?? "unknown"}`
        : r.shadow
          ? "shadow"
          : r.applied
            ? (r.commit ?? "applied")
            : "not applied";
      lines.push(`  ${r.action_id} — ${outcome}`);
    }
    return lines.join("\n");
  }
  const r = value as RatifyResult;
  const outcome = r.shadow ? "shadow" : r.applied ? (r.commit ?? "applied") : "not applied";
  return `${r.action_id} ${r.decision} — ${outcome}`;
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

export const stagedActionTools: ToolDefinition[] = [
  {
    name: "vault_stage_action",
    title: "Stage an action for ratification",
    oneLine: "Stage a proposed action for later ratification.",
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
    outputSchema: stageActionOutputSchema,
    summarize: summarizeStageAction,
    handler: (vaultRoot, args, access) => vaultStageAction(vaultRoot, args, access),
  },
  {
    name: "vault_ratify",
    title: "Approve or reject staged action(s)",
    oneLine: "Approve or reject one or more staged actions.",
    annotations: { destructiveHint: true },
    description:
      "Approve or reject one pending staged action ('id'), or up to " +
      `${BATCH_RATIFY_MAX} at once ('ids', an explicit list — never a threshold ` +
      "or an 'all pending' sentinel: the parameter shape cannot express one). " +
      "With a single 'id', 'decision' may be omitted to have the server elicit " +
      "it from the human as a form (spec 2026-07-26, Decision 5) — the server " +
      "proposes, the human disposes; a batch 'ids' call always requires an " +
      "explicit 'decision'. Each id is processed independently in caller order " +
      "— RBAC, the " +
      "pending-status check, and the tier-0 gates run per action exactly as a " +
      "single call would; one gate-blocked or failing id leaves THAT action " +
      "pending and the batch continues with per-id outcomes, never a rollback " +
      "of the rest. Durability: each id's decision record and git commit land " +
      "before the next id is processed, so an interrupted batch leaves a " +
      "complete record of what landed — re-issuing the same batch is the " +
      "recovery path (already-decided ids report a 'not pending' outcome; the " +
      "remainder applies). On approve, dispatches to the matching write tool " +
      "(promote → vault_promote, deprecate → vault_deprecate, supersede → " +
      "vault_supersede, confidence-up → vault_set_confidence, merge → " +
      "vault_merge, write → vault_write) and auto-commits. On reject, records " +
      "the rejection and applies nothing; 'reason_category' is REQUIRED on " +
      "reject — a spec-mandated, intentional break from the prior optional " +
      "contract — one of: wrong-conclusion, wrong-target, overbroad, " +
      "stale-evidence, duplicate, formatting, policy, other. Approve-path " +
      "callers are unaffected: 'reason_category' stays optional there, unless " +
      "'amended_diff' is present, where it is also required. 'amended_diff' " +
      "(single-'id' + approve only) dispatches an edited payload instead of " +
      "the staged one — the tier-0 gates run against the amendment too — and " +
      "the decision record keeps both what was proposed and what actually " +
      "landed (decision_kind: 'edit-then-approve'). If shadow_mode is active, " +
      "'amended_diff' errors rather than silently discarding the amendment: " +
      "re-issue without it, or ratify after shadow mode is lifted. Approving " +
      "a promote, an unforwarded deprecate, or a write that declares status " +
      "canonical runs the tier-0 gate first (#232): a certain structural " +
      "violation (broken source refs, canonical citing draft/deprecated/" +
      "archived, schema-invalid frontmatter, stranded canonical dependents) " +
      "errors and the action stays pending. Errors if an id is unknown or not " +
      "pending. Requires the role's 'ratify' grant. If the vault runs " +
      "shadow_mode, an approved dispatch is computed and shadow-logged but NOT " +
      "applied — the outcome carries shadow: true and the action stays " +
      "pending for a live ratification later.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Id of a single staged action to decide, e.g. 'stage-042'. Exactly one of id/ids.",
        },
        ids: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: BATCH_RATIFY_MAX,
          description:
            `Explicit list of staged-action ids to decide together, 1-${BATCH_RATIFY_MAX}, ` +
            "no duplicates. Exactly one of id/ids. One shared decision/reason/" +
            "reason_category applies to every id.",
        },
        decision: {
          type: "string",
          enum: ["approve", "reject"],
          description:
            "Whether to approve (apply) or reject the action(s). With a single " +
            "'id' (no 'ids'), omit it to have the server elicit the decision " +
            "from the human as a form (spec 2026-07-26, Decision 5): the server " +
            "proposes, the human disposes, and the form's preselected answer is " +
            "the safe 'reject'. Required when 'ids' is present — a batch has no " +
            "single-action form to elicit.",
        },
        principal: {
          type: "string",
          description: "Who is deciding, e.g. 'human:mihir'. Recorded and used as the write agent.",
        },
        reason: {
          type: "string",
          description: "Optional free-text reason recorded with the decision",
        },
        reason_category: {
          type: "string",
          enum: [...REASON_CATEGORIES],
          description:
            "Machine-readable correction category. Required on reject and when " +
            "amended_diff is present; optional on a plain approve.",
        },
        amended_diff: {
          type: "object",
          description:
            "Single-'id' + decision:'approve' only. An edited payload dispatched " +
            "instead of the staged proposed_diff; same shape rules as proposed_diff " +
            "for the action's type. Errors under shadow_mode instead of discarding it.",
          additionalProperties: true,
        },
      },
      required: ["principal"],
      additionalProperties: false,
    },
    outputSchema: ratifyOutputSchema,
    summarize: summarizeRatify,
    handler: (vaultRoot, args, access) => vaultRatify(vaultRoot, args, access),
  },
];
