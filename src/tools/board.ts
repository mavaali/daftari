// board.ts — U11: Board MCP tools.
//
// Three tools that form the human/agent trust boundary for the Vault Board.
//
// Security model:
//   - vault_board_list: no extra gating — RBAC lives inside source adapters.
//   - vault_board_dispose: canDispose gate (R13/R16) FIRST; then RBAC on target
//     (R20, via caller's own board view); then reassign principal gate (R31);
//     then append with principal_type "human".
//   - vault_board_resolve: callable by ANY role; RBAC via ledger descriptor
//     (R20); reproduces gate (R14); writes resolved with principal_type "system".
//   - "reopened" is never a tool entry point (R15) — blocked at input validation.
//
// Gate order for dispose (load-bearing):
//   1. canDispose(access.role)                    — R13/R16
//   2. finding in caller's own board view         — R20 (RBAC non-disclosure)
//   3. reassign → isConfiguredPrincipal(owner)    — R31
//   4. appendEvent with principal_type "human"    — write
//
// Resolve RBAC (absent finding):
//   A to-be-resolved finding may have been removed from the live set (fixed).
//   We look up the finding's descriptor from its ledger events (loadLedger →
//   byFinding). If no prior events → reject. Extract descriptor from the
//   most recent event that carries one; RBAC-check the target using the same
//   primitives the adapters use (sourceReadable via rbacPaths on descriptor).
//   If not readable → reject with a non-disclosing error.
//
// Registration: boardTools array is imported by src/server.ts (same pattern
//   as tier2Tools, stagedActionTools, etc.).

import { type AccessContext, canDispose } from "../access/rbac.js";
import { type BoardFilters, type BoardResult, listBoard } from "../board/board.js";
import { appendEvent, loadLedger } from "../board/ledger.js";
import { isConfiguredPrincipal } from "../board/principals.js";
import { resolveAdapterForIdentity } from "../board/sources/index.js";
import type { Finding, FindingDescriptor, LedgerEvent } from "../board/types.js";
import { sourceReadable } from "../curation/tension-access.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { DaftariConfig } from "../utils/config.js";
import type { ToolDefinition } from "./read.js";
import { openIndexForAccessOrNull } from "./search.js";

// ---------------------------------------------------------------------------
// Dispose event type guard — "reopened" is never a valid input (R15).
// Also excludes system-only events "new" and "resolved".
// ---------------------------------------------------------------------------

const DISPOSE_EVENTS = ["accept", "defer", "dismiss", "reassign"] as const;
type DisposeEvent = (typeof DISPOSE_EVENTS)[number];

function isDisposeEvent(v: unknown): v is DisposeEvent {
  return DISPOSE_EVENTS.includes(v as DisposeEvent);
}

// ---------------------------------------------------------------------------
// Result types (returned from handler functions, not just ToolDefinition)
// ---------------------------------------------------------------------------

// BoardListResult is just BoardResult re-exported for callers.
export type BoardListResult = BoardResult;

export interface BoardDisposeResult {
  event: LedgerEvent;
}

export interface BoardResolveResult {
  resolved: boolean;
  still_reproduces: boolean;
  event?: LedgerEvent;
}

// ---------------------------------------------------------------------------
// Dispose args
// ---------------------------------------------------------------------------

export interface DisposeArgs {
  finding_id: string;
  event: DisposeEvent | string; // string to accept runtime input; validated below
  rationale?: string;
  expiry?: string;
  owner?: string;
}

// ---------------------------------------------------------------------------
// Non-disclosing error for "not found or not permitted" (R20).
// The message is identical regardless of whether the finding doesn't exist or
// the caller lacks RBAC — we MUST not distinguish them.
// ---------------------------------------------------------------------------

// The error message MUST NOT include the finding_id — doing so would let a
// caller distinguish "not found" (a recognisable id returns a different msg)
// from "not permitted" (an opaque sha256 returns a different msg). Both paths
// return byte-identical text so there is no existence oracle (R20).
function noFindingError(): Error {
  return new Error(`vault_board_dispose: finding not found or not permitted`);
}

function noResolveTargetError(): Error {
  return new Error(`vault_board_resolve: finding not found or not permitted`);
}

// ---------------------------------------------------------------------------
// vaultBoardList
// ---------------------------------------------------------------------------

export async function vaultBoardList(
  vaultRoot: string,
  access: AccessContext,
  _config: DaftariConfig,
  filters?: BoardFilters,
  now?: Date,
): Promise<Result<BoardListResult, Error>> {
  try {
    const result = await listBoard(vaultRoot, access, filters, now);
    return ok(result);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`vault_board_list: ${reason}`));
  }
}

// ---------------------------------------------------------------------------
// vaultBoardDispose
// ---------------------------------------------------------------------------

export async function vaultBoardDispose(
  vaultRoot: string,
  access: AccessContext,
  config: DaftariConfig,
  args: DisposeArgs,
  now?: Date,
): Promise<Result<BoardDisposeResult, Error>> {
  const { finding_id, event, rationale, expiry, owner } = args;

  // -------------------------------------------------------------------
  // Input validation: finding_id must be a non-empty string.
  // This is an argument-level error (not a per-finding disclosure) — the
  // message names the argument, not any finding's existence.
  // -------------------------------------------------------------------
  if (typeof finding_id !== "string" || finding_id.trim().length === 0) {
    return err(
      new Error("vault_board_dispose: finding_id is required and must be a non-empty string"),
    );
  }

  // -------------------------------------------------------------------
  // Gate 1 (R13/R16): canDispose capability check — FIRST, unconditionally.
  // An agent's role lacks dispose:true, so this is the human/agent boundary.
  // -------------------------------------------------------------------
  if (!canDispose(access.role)) {
    return err(
      new Error(
        `vault_board_dispose: permission denied — role '${access.roleName}' lacks the dispose capability`,
      ),
    );
  }

  // -------------------------------------------------------------------
  // Input validation: event must be one of the four human events (R15).
  // "reopened" is explicitly blocked here — it is only emitted by reconcile.
  // "new" and "resolved" are system events and also blocked.
  // -------------------------------------------------------------------
  if (!isDisposeEvent(event)) {
    return err(
      new Error(
        `vault_board_dispose: invalid event '${String(event)}' — must be one of: ${DISPOSE_EVENTS.join(", ")}. 'reopened' is not allowed as a tool entry point (R15).`,
      ),
    );
  }

  // -------------------------------------------------------------------
  // Gate 2 (R20): Find the live finding in the CALLER'S OWN board view.
  // If it is not present (doesn't exist OR RBAC-hidden from this caller),
  // reject with the SAME non-disclosing error either way.
  // -------------------------------------------------------------------
  let liveFinding: Finding | undefined;
  try {
    const boardResult = await listBoard(vaultRoot, access, undefined, now);
    liveFinding = boardResult.all.find((f) => f.identity_key === finding_id);
  } catch {
    // listBoard failure = treat as not found (no existence disclosure)
    return err(noFindingError());
  }

  if (!liveFinding) {
    return err(noFindingError());
  }

  // -------------------------------------------------------------------
  // Gate 3 (R31): reassign requires owner to be a configured principal.
  // accept/defer/dismiss do not require owner.
  // -------------------------------------------------------------------
  if (event === "reassign") {
    if (typeof owner !== "string" || owner.trim().length === 0) {
      return err(new Error(`vault_board_dispose: reassign requires a non-empty 'owner' argument`));
    }
    if (!isConfiguredPrincipal(config, owner)) {
      return err(
        new Error(
          `vault_board_dispose: '${owner}' is not a configured principal — reassign rejected (R31)`,
        ),
      );
    }
  }

  // -------------------------------------------------------------------
  // Gate 4: Build and stamp the descriptor from the live finding.
  // This is mandatory on ALL human dispose events so the reconciler can
  // render resolved-and-absent findings without the live finding (U4).
  //
  // rbacPaths: denormalise the RBAC-relevant paths into the descriptor so
  // vault_board_resolve can enforce the same gate even when the live
  // finding is absent. ALL paths must be readable (AND rule, R19/R20).
  // Filter out any undefined/empty entries defensively.
  // -------------------------------------------------------------------
  const rbacPathsForTarget = ((): string[] => {
    const { target } = liveFinding;
    switch (target.kind) {
      case "lint":
      case "staleness":
        return [target.path];
      case "tier2":
        return [target.artifact, target.unit];
      case "tension": {
        // sourceA and sourceB live in evidence (populated by the tension adapter).
        const ev = liveFinding.evidence as Record<string, unknown>;
        const a = typeof ev.sourceA === "string" ? ev.sourceA : undefined;
        const b = typeof ev.sourceB === "string" ? ev.sourceB : undefined;
        return [a, b].filter((p): p is string => typeof p === "string" && p.length > 0);
      }
      case "staged": {
        // targetPath lives in evidence (populated by the staged adapter).
        const ev = liveFinding.evidence as Record<string, unknown>;
        const p = typeof ev.targetPath === "string" ? ev.targetPath : undefined;
        return p !== undefined ? [p] : [];
      }
      default:
        return [];
    }
  })();

  const descriptor: FindingDescriptor = {
    source: liveFinding.source,
    check: liveFinding.check,
    target: liveFinding.target,
    label:
      liveFinding.suggested_action.length > 0
        ? liveFinding.suggested_action
        : `${liveFinding.source}/${liveFinding.check}`,
    // rbacPaths: always present and non-empty for known kinds (see above).
    // Carry it unconditionally so resolve can enforce the gate without a
    // canRead("*") fallback. Empty array means "no paths to check" — for
    // unknown future kinds this is conservative (no paths = open); the
    // unknown-kind branch above returns [] only as a defensive fallback.
    rbacPaths: rbacPathsForTarget,
  };

  // -------------------------------------------------------------------
  // Append the human event (principal_type "human").
  // -------------------------------------------------------------------
  const eventRecord: Omit<LedgerEvent, "identity_scheme_version"> = {
    finding_id,
    event,
    by: access.user,
    principal_type: "human",
    at: (now ?? new Date()).toISOString(),
    against_fingerprint: liveFinding.fingerprint,
    descriptor,
    ...(rationale !== undefined ? { rationale } : {}),
    ...(expiry !== undefined ? { expiry } : {}),
    ...(owner !== undefined ? { owner } : {}),
  };

  const appendResult = await appendEvent(vaultRoot, eventRecord);
  if (!appendResult.ok) {
    return err(
      new Error(`vault_board_dispose: failed to append event: ${appendResult.error.message}`),
    );
  }

  return ok({ event: appendResult.value });
}

// ---------------------------------------------------------------------------
// vaultBoardResolve
// ---------------------------------------------------------------------------

export async function vaultBoardResolve(
  vaultRoot: string,
  access: AccessContext,
  _config: DaftariConfig,
  args: { finding_id: string },
  now?: Date,
): Promise<Result<BoardResolveResult, Error>> {
  const { finding_id } = args;

  // -------------------------------------------------------------------
  // Input validation: finding_id must be a non-empty string.
  // This is an argument-level error (not a per-finding disclosure) — the
  // message names the argument, not any finding's existence.
  // -------------------------------------------------------------------
  if (typeof finding_id !== "string" || finding_id.trim().length === 0) {
    return err(
      new Error("vault_board_resolve: finding_id is required and must be a non-empty string"),
    );
  }

  // -------------------------------------------------------------------
  // Step 1: Load ledger for this finding. If no prior events → reject
  // (nothing to resolve; no existence signal).
  // -------------------------------------------------------------------
  const ledgerResult = await loadLedger(vaultRoot);
  if (!ledgerResult.ok) {
    return err(new Error(`vault_board_resolve: cannot load ledger: ${ledgerResult.error.message}`));
  }

  const priorEvents = ledgerResult.value.byFinding.get(finding_id);
  if (!priorEvents || priorEvents.length === 0) {
    return err(noResolveTargetError());
  }

  // -------------------------------------------------------------------
  // Step 2: RBAC check on the descriptor target.
  // Extract the most recent descriptor from the prior events.
  // If no event carries a descriptor, we still proceed but cannot RBAC
  // on the target (legacy edge — documented).
  // -------------------------------------------------------------------
  let descriptor: FindingDescriptor | undefined;
  for (let i = priorEvents.length - 1; i >= 0; i--) {
    const ev = priorEvents[i];
    if (ev === undefined) throw new Error("vaultBoardResolve: internal error: index out of bounds");
    if (ev.descriptor !== undefined) {
      descriptor = ev.descriptor;
      break;
    }
  }

  if (descriptor !== undefined) {
    // RBAC-check the descriptor's target using the same primitives adapters use.
    const db = openIndexForAccessOrNull(vaultRoot);
    try {
      const readable = isTargetReadable(db, access, descriptor);
      if (!readable) {
        return err(noResolveTargetError());
      }
    } finally {
      if (db) db.close();
    }
  } else {
    // No descriptor on any prior event (pre-U11 ledger data / missing descriptor).
    // FAIL CLOSED — reject with the same non-disclosing error.
    // Do NOT proceed to the reproduces check: a distinguishable still_reproduces:true
    // response would leak existence via the different ok-result shape.
    // Document: callers must re-dispose the finding via dispose (which stamps rbacPaths)
    // before resolve can be used against pre-U11 ledger entries.
    return err(noResolveTargetError());
  }

  // -------------------------------------------------------------------
  // Step 3 (R14): The reproduces gate.
  // Call resolveAdapterForIdentity — if it returns a non-null adapter,
  // the finding STILL reproduces → do NOT write resolved.
  // If it returns null → the condition is gone → append resolved.
  //
  // Wrapped in try/catch (FIX 2): adapters open vault files and can throw.
  // The function's contract is Result, not throw — surface errors as a
  // non-disclosing err Result rather than letting exceptions propagate.
  // -------------------------------------------------------------------
  const effectiveNow = now ?? new Date();
  let adapter: Awaited<ReturnType<typeof resolveAdapterForIdentity>>;
  try {
    adapter = await resolveAdapterForIdentity(finding_id, vaultRoot, access, effectiveNow);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`vault_board_resolve: adapter error: ${reason}`));
  }

  if (adapter !== null) {
    // Still reproduces — do not write resolved (R14).
    return ok({ resolved: false, still_reproduces: true });
  }

  // -------------------------------------------------------------------
  // Step 3b (FIX 4): Double-resolve guard — idempotency.
  // If the latest event is already "resolved", do NOT write a second one.
  // A second call on an already-resolved+gone finding is a no-op.
  // Return resolved:false / still_reproduces:false to signal idempotency
  // (the condition is gone, the finding is already resolved, nothing to do).
  // -------------------------------------------------------------------
  // priorEvents.length > 0 is guaranteed by the guard at the top of Step 1.
  const latestEvent = priorEvents[priorEvents.length - 1];
  if (latestEvent === undefined)
    throw new Error("vaultBoardResolve: internal error: last event undefined");
  if (latestEvent.event === "resolved") {
    return ok({ resolved: false, still_reproduces: false });
  }

  // No longer reproduces — append a system-authored resolved event.
  // Carry the descriptor forward from the most recent ledger descriptor.
  // against_fingerprint from the latest event.

  const resolvedRecord: Omit<LedgerEvent, "identity_scheme_version"> = {
    finding_id,
    event: "resolved",
    by: "system",
    principal_type: "system",
    at: effectiveNow.toISOString(),
    against_fingerprint: latestEvent.against_fingerprint,
    ...(descriptor !== undefined ? { descriptor } : {}),
  };

  const appendResult = await appendEvent(vaultRoot, resolvedRecord);
  if (!appendResult.ok) {
    return err(
      new Error(`vault_board_resolve: failed to append resolved: ${appendResult.error.message}`),
    );
  }

  return ok({ resolved: true, still_reproduces: false, event: appendResult.value });
}

// ---------------------------------------------------------------------------
// isTargetReadable — RBAC check for a descriptor's target.
//
// Primary path (U11+): descriptor.rbacPaths is present → require ALL paths
// to pass sourceReadable (AND rule). This covers all source kinds including
// tension (sourceA + sourceB) and staged (targetPath) which could not be
// checked without the denormalised paths.
//
// Legacy path (pre-U11): descriptor.rbacPaths is absent → FAIL CLOSED.
// The caller (vaultBoardResolve) must reject before reaching this function
// when no descriptor exists; this inner guard is defence-in-depth.
//
// Kind-specific fallback (rbacPaths present but empty): fail closed for
// unknown future kinds — an empty path set means we cannot verify access.
//
// The canRead(role,"*") fallback for tension/staged has been REMOVED.
// That fallback prevented scoped roles from ever resolving tension/staged
// findings (even when they could fully read both sides) while silently
// passing wildcard roles without verifying the actual paths.
// ---------------------------------------------------------------------------

function isTargetReadable(
  db: ReturnType<typeof openIndexForAccessOrNull>,
  access: AccessContext,
  descriptor: FindingDescriptor,
): boolean {
  // Primary path: use denormalised rbacPaths if present.
  if (descriptor.rbacPaths !== undefined) {
    // Empty rbacPaths for a known kind is unexpected — fail closed to be safe.
    if (descriptor.rbacPaths.length === 0) {
      // Defensive: an unknown future kind landed with an empty path set.
      // Fall through to the kind-specific logic below (which also fails closed
      // for unknown kinds via the default branch).
      const { target } = descriptor;
      switch (target.kind) {
        case "lint":
        case "staleness":
        case "tension":
        case "staged":
        case "tier2":
          // Known kinds should always have non-empty rbacPaths — empty is a
          // coding error; fail closed.
          return false;
        default:
          return false;
      }
    }
    // ALL paths must be readable (AND rule, R19/R20).
    return descriptor.rbacPaths.every((p) => sourceReadable(db, access, p));
  }

  // Legacy path: no rbacPaths on descriptor.
  // isTargetReadable should only be called when a descriptor exists (the
  // resolve path returns early if descriptor is undefined). If we reach here
  // with rbacPaths absent, fail closed — do not fall back to canRead("*").
  return false;
}

// ---------------------------------------------------------------------------
// MCP ToolDefinition wiring
// ---------------------------------------------------------------------------

// Input schema for vault_board_list
const boardListInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    collection: {
      type: "string",
      description: "Keep only findings whose collection equals this value",
    },
    check: {
      type: "string",
      description: "Keep only findings whose check equals this value",
    },
    certainty: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "Keep only findings with this certainty level",
    },
    owner: {
      type: "string",
      description: "Keep only findings owned by this identity",
    },
    minAgeDays: {
      type: "integer",
      description: "Keep only findings at least this many days old",
    },
    document: {
      type: "string",
      description: "Keep only findings that reference this vault-relative document path",
    },
  },
  additionalProperties: false,
};

// Input schema for vault_board_dispose
const boardDisposeInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    finding_id: {
      type: "string",
      description: "The stable identity key of the finding to dispose",
    },
    event: {
      type: "string",
      enum: ["accept", "defer", "dismiss", "reassign"],
      description: "Disposition event — 'reopened' and system events are never valid inputs",
    },
    rationale: {
      type: "string",
      description: "Human-readable rationale for this disposition",
    },
    expiry: {
      type: "string",
      description: "ISO 8601 expiry timestamp — applicable to defer/dismiss",
    },
    owner: {
      type: "string",
      description: "New owner identity — required for reassign (must be a configured principal)",
    },
  },
  required: ["finding_id", "event"],
  additionalProperties: false,
};

// Input schema for vault_board_resolve
const boardResolveInputSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    finding_id: {
      type: "string",
      description: "The stable identity key of the finding to resolve",
    },
  },
  required: ["finding_id"],
  additionalProperties: false,
};

// Shared ledger event schema fragment
const ledgerEventSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    finding_id: { type: "string" },
    event: { type: "string" },
    by: { type: "string" },
    principal_type: { type: "string", enum: ["human", "agent", "system"] },
    at: { type: "string", description: "ISO 8601 timestamp" },
    against_fingerprint: { type: "string" },
    identity_scheme_version: { type: "string" },
    rationale: { type: "string" },
    expiry: { type: "string" },
    owner: { type: "string" },
    descriptor: {
      type: "object",
      properties: {
        source: { type: "string" },
        check: { type: "string" },
        target: { type: "object" },
        label: { type: "string" },
      },
      required: ["source", "check", "target", "label"],
    },
  },
  required: [
    "finding_id",
    "event",
    "by",
    "principal_type",
    "at",
    "against_fingerprint",
    "identity_scheme_version",
  ],
};

export const boardTools: ToolDefinition[] = [
  {
    name: "vault_board_list",
    title: "List board findings",
    annotations: { readOnlyHint: true },
    description:
      "List all current board findings, grouped by disposition column " +
      "(new / accepted / waiting / resolved / dismissed). " +
      "RBAC is enforced inside the source adapters — only findings the " +
      "caller may read are returned. Optional filters narrow the view " +
      "without affecting what is persisted.",
    inputSchema: boardListInputSchema,
    outputSchema: {
      type: "object",
      properties: {
        columns: {
          type: "object",
          description: "Findings grouped by disposition column",
          additionalProperties: { type: "array", items: { type: "object" } },
        },
        all: {
          type: "array",
          items: { type: "object" },
          description: "Flat list of all visible findings",
        },
      },
      required: ["columns", "all"],
    },
    handler: (vaultRoot, args, access) => {
      const filters: BoardFilters = {};
      if (typeof args.collection === "string") filters.collection = args.collection;
      if (typeof args.check === "string") filters.check = args.check;
      if (args.certainty === "low" || args.certainty === "medium" || args.certainty === "high") {
        filters.certainty = args.certainty;
      }
      if (typeof args.owner === "string") filters.owner = args.owner;
      if (typeof args.minAgeDays === "number") filters.minAgeDays = args.minAgeDays;
      if (typeof args.document === "string") filters.document = args.document;
      // config not needed for list (RBAC is inside adapters)
      // We still need to call the function; use empty config placeholder
      const emptyConfig = { principals: [], server: { tokens: [] } } as unknown as DaftariConfig;
      return vaultBoardList(
        vaultRoot,
        access ?? { user: "guest", roleName: "guest", role: null },
        emptyConfig,
        Object.keys(filters).length > 0 ? filters : undefined,
      );
    },
  },
  {
    name: "vault_board_dispose",
    title: "Dispose a board finding",
    annotations: { readOnlyHint: false, idempotentHint: false },
    description:
      "Record a human disposition decision on a board finding. " +
      "Event must be one of: accept / defer / dismiss / reassign. " +
      "Requires the 'dispose' capability on the caller's role (R13/R16) — " +
      "agent roles never have this. The finding must be visible in the " +
      "caller's board view (R20). For reassign, 'owner' must be a " +
      "configured principal (R31). All events are stamped principal_type " +
      "'human' and a descriptor is always recorded for later rendering.",
    inputSchema: boardDisposeInputSchema,
    outputSchema: {
      type: "object",
      properties: {
        event: {
          ...ledgerEventSchema,
          description: "The appended ledger event",
        },
      },
      required: ["event"],
    },
    handler: (vaultRoot, args, access) => {
      // config must be loaded from vault for isConfiguredPrincipal
      // The handler signature doesn't carry config; we need to load it.
      // Use loadConfig from the vault to get the actual config.
      return loadConfigAndDispose(
        vaultRoot,
        access ?? { user: "guest", roleName: "guest", role: null },
        args,
      );
    },
  },
  {
    name: "vault_board_resolve",
    title: "Verify and resolve a board finding",
    annotations: { readOnlyHint: false, idempotentHint: true },
    description:
      "Deterministically verify that a finding no longer reproduces, " +
      "and if so write a system-authored 'resolved' event. " +
      "Unlike dispose, this is callable by any role (no canDispose gate). " +
      "The finding must have prior ledger events (R14). If the underlying " +
      "condition still reproduces, no event is written and 'still_reproduces' " +
      "is returned true. Resolved events carry principal_type 'system' — " +
      "the system verified it, the caller merely requested it.",
    inputSchema: boardResolveInputSchema,
    outputSchema: {
      type: "object",
      properties: {
        resolved: {
          type: "boolean",
          description: "True if a 'resolved' event was written",
        },
        still_reproduces: {
          type: "boolean",
          description: "True if the finding still reproduces (no event written)",
        },
        event: {
          ...ledgerEventSchema,
          description: "The appended 'resolved' event, present only when resolved=true",
        },
      },
      required: ["resolved", "still_reproduces"],
    },
    handler: (vaultRoot, args, access) => {
      const finding_id = typeof args.finding_id === "string" ? args.finding_id : "";
      const emptyConfig = { principals: [], server: { tokens: [] } } as unknown as DaftariConfig;
      return vaultBoardResolve(
        vaultRoot,
        access ?? { user: "guest", roleName: "guest", role: null },
        emptyConfig,
        { finding_id },
      );
    },
  },
];

// ---------------------------------------------------------------------------
// loadConfigAndDispose — loads config from vault, then calls vaultBoardDispose.
// Needed because the ToolDefinition handler signature does not carry config.
// ---------------------------------------------------------------------------

async function loadConfigAndDispose(
  vaultRoot: string,
  access: AccessContext,
  args: Record<string, unknown>,
): Promise<Result<BoardDisposeResult, Error>> {
  const { loadConfig } = await import("../utils/config.js");
  const configResult = loadConfig(vaultRoot);
  if (!configResult.ok) {
    return err(new Error(`vault_board_dispose: cannot load config: ${configResult.error.message}`));
  }
  const disposeArgs: DisposeArgs = {
    finding_id: typeof args.finding_id === "string" ? args.finding_id : "",
    event: typeof args.event === "string" ? args.event : "",
    ...(typeof args.rationale === "string" ? { rationale: args.rationale } : {}),
    ...(typeof args.expiry === "string" ? { expiry: args.expiry } : {}),
    ...(typeof args.owner === "string" ? { owner: args.owner } : {}),
  };
  return vaultBoardDispose(vaultRoot, access, configResult.value, disposeArgs);
}
