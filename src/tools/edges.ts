// derives_from edge tools: vault_edge_observe (producer), vault_edge_contest
// (case-2 contest-and-revoke), vault_edges (read). Spec §11.3 — the earned
// re-derivation graph of the cortex loop.
//
// vault_edge_observe records a (re-)derivation sighting an edge. In v1 the
// matcher/loop that would normally call it does not exist yet, so the tool is
// exposed over MCP mainly for testing and for the future loop — the same
// posture vault_stage_action takes.
//
// vault_edge_contest records a case-2 contradiction (a re-derivation failed
// with NO upstream change): the edge drops to `revoked` AND a tension is
// logged — surface, don't silently decrement (strength-Q4). The tension is
// written first: a tension pointing at a still-live edge is harmless advisory
// noise, but a silent revoke is the exact failure mode the design forbids.
//
// RBAC: observe and the read tool gate on hasAnyRead, the curation-surface
// posture (matching vault_tension_log / vault_stage_action). Contest gates on
// the `ratify` grant (§11.6) — it revokes trigger-bearing edges, the same
// curation-verdict tier as vault_ratify.

import { relative, resolve } from "node:path";
import { type AccessContext, canRatify, hasAnyRead } from "../access/rbac.js";
import {
  contestEdge,
  type DerivesFromEdge,
  EDGE_AXES,
  EDGE_STATUSES,
  type EdgeAxis,
  type EdgeStatus,
  getEdge,
  listEdges,
  observeEdge,
} from "../curation/edges.js";
import { addTension, listTensions } from "../curation/tension.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { readFile, resolveVaultPath } from "../storage/local.js";
import type { ToolDefinition } from "./read.js";

// Canonical vault-relative form of a caller-supplied path: trimmed, resolved
// against the vault root (rejecting traversal out of it), re-relativized. The
// edge store keys edges by raw string, so `./a.md`, `b/../a.md`, and `a.md`
// must all collapse to one key here — otherwise aliased inputs would split an
// edge's votes across phantom twins and slip past the self-edge guard (the
// same aliasing class vault_merge guards against).
function canonicalRelPath(vaultRoot: string, relPath: string): Result<string, Error> {
  const resolved = resolveVaultPath(vaultRoot, relPath.trim());
  if (!resolved.ok) return resolved;
  return ok(relative(resolve(vaultRoot), resolved.value));
}

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

// Fail fast on a path that does not name a real document — an edge endpoint
// that never existed could never be re-derived (mirrors vault_stage_action's
// stage-time target check).
async function requireDocument(
  vaultRoot: string,
  relPath: string,
  tool: string,
): Promise<Result<void, Error>> {
  const resolved = resolveVaultPath(vaultRoot, relPath);
  if (!resolved.ok) return resolved;
  const exists = await readFile(resolved.value);
  if (!exists.ok) {
    return err(new Error(`${tool}: document not found: ${relPath}`));
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// vault_edge_observe
// ---------------------------------------------------------------------------

export async function vaultEdgeObserve(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<DerivesFromEdge, Error>> {
  const allowed = requireReadAccess("vault_edge_observe", access);
  if (!allowed.ok) return allowed;

  const fromPath = requireString(args, "from_path", "vault_edge_observe");
  if (!fromPath.ok) return fromPath;
  const toPath = requireString(args, "to_path", "vault_edge_observe");
  if (!toPath.ok) return toPath;
  const observedBy = requireString(args, "observed_by", "vault_edge_observe");
  if (!observedBy.ok) return observedBy;

  if (typeof args.blind !== "boolean") {
    return err(new Error("vault_edge_observe requires a boolean 'blind' argument"));
  }
  let axis: EdgeAxis | undefined;
  if (args.varied_axis !== undefined && args.varied_axis !== null) {
    if (
      typeof args.varied_axis !== "string" ||
      !(EDGE_AXES as readonly string[]).includes(args.varied_axis)
    ) {
      return err(
        new Error(`vault_edge_observe 'varied_axis' must be one of: ${EDGE_AXES.join(", ")}`),
      );
    }
    axis = args.varied_axis as EdgeAxis;
  }
  let note: string | undefined;
  if (args.note !== undefined && args.note !== null) {
    if (typeof args.note !== "string") {
      return err(new Error("vault_edge_observe 'note' must be a string"));
    }
    const trimmed = args.note.trim();
    if (trimmed.length > 0) note = trimmed;
  }

  const canonFrom = canonicalRelPath(vaultRoot, fromPath.value);
  if (!canonFrom.ok) return canonFrom;
  const canonTo = canonicalRelPath(vaultRoot, toPath.value);
  if (!canonTo.ok) return canonTo;

  // Self-edge check on the CANONICAL paths, so `a.md` vs `b/../a.md` cannot
  // slip a self-derivation past a raw string comparison.
  if (canonFrom.value === canonTo.value) {
    return err(new Error("vault_edge_observe: a document cannot derive from itself"));
  }

  const fromExists = await requireDocument(vaultRoot, canonFrom.value, "vault_edge_observe");
  if (!fromExists.ok) return fromExists;
  const toExists = await requireDocument(vaultRoot, canonTo.value, "vault_edge_observe");
  if (!toExists.ok) return toExists;

  return observeEdge(vaultRoot, {
    fromPath: canonFrom.value,
    toPath: canonTo.value,
    observedBy: observedBy.value,
    blind: args.blind,
    ...(axis !== undefined ? { axis } : {}),
    ...(note !== undefined ? { note } : {}),
  });
}

// ---------------------------------------------------------------------------
// vault_edge_contest
// ---------------------------------------------------------------------------

export interface ContestResult {
  edge: DerivesFromEdge;
  tension_id: string | undefined;
}

export async function vaultEdgeContest(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<ContestResult, Error>> {
  // Contest is the curation-verdict tier (§11.6): it revokes a trigger-bearing
  // edge — destructive to the future loop's trigger graph — so it needs the
  // explicit `ratify` grant, the same tier as approving/rejecting staged
  // actions (this closes the gap flagged in the §11.3 review).
  if (access && !canRatify(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot contest edges`));
  }

  const fromPath = requireString(args, "from_path", "vault_edge_contest");
  if (!fromPath.ok) return fromPath;
  const toPath = requireString(args, "to_path", "vault_edge_contest");
  if (!toPath.ok) return toPath;
  const contestedBy = requireString(args, "contested_by", "vault_edge_contest");
  if (!contestedBy.ok) return contestedBy;
  const reason = requireString(args, "reason", "vault_edge_contest");
  if (!reason.ok) return reason;

  // Canonicalize like observe does, so a contest addresses the same key the
  // observation wrote. No doc-existence check here — an edge whose endpoint
  // doc was since deleted is still contestable.
  const canonFrom = canonicalRelPath(vaultRoot, fromPath.value);
  if (!canonFrom.ok) return canonFrom;
  const canonTo = canonicalRelPath(vaultRoot, toPath.value);
  if (!canonTo.ok) return canonTo;

  // Validate the edge is contestable BEFORE writing the tension, so a contest
  // of a non-existent or already-revoked edge never leaves a junk tension.
  const current = await getEdge(vaultRoot, canonFrom.value, canonTo.value);
  if (!current.ok) return current;
  if (!current.value) {
    return err(
      new Error(
        `vault_edge_contest: no such edge: ${canonFrom.value} derives_from ${canonTo.value}`,
      ),
    );
  }
  if (current.value.status === "revoked") {
    return err(
      new Error(
        `vault_edge_contest: edge already revoked: ${canonFrom.value} derives_from ${canonTo.value}`,
      ),
    );
  }

  // Tension first (surface), then revoke. If the revoke fails after the
  // tension landed, the tension stands as advisory noise — the safe side of
  // the ordering (revoke-first would risk the silent revoke the design
  // forbids). To keep a failed-revoke retry from stacking duplicate tensions,
  // an unresolved tension with this exact title is reused instead of appended.
  const title = `Contested derives_from edge: ${canonFrom.value} -> ${canonTo.value}`;
  const existing = await listTensions(vaultRoot);
  if (!existing.ok) return existing;
  const open = existing.value.find((t) => t.title === title && !t.resolved);

  let tensionId: string | undefined;
  if (open) {
    tensionId = open.id;
  } else {
    const tension = await addTension(vaultRoot, {
      title,
      kind: "factual",
      sourceA: canonFrom.value,
      claimA: `derives from ${canonTo.value} (k_survived=${current.value.kSurvived})`,
      sourceB: canonTo.value,
      claimB: `re-derivation failed with no upstream change — ${reason.value}`,
      loggedBy: contestedBy.value,
      decidedByPrincipal: access?.user,
    });
    if (!tension.ok) return tension;
    tensionId = tension.value.id;
  }

  const revoked = await contestEdge(vaultRoot, {
    fromPath: canonFrom.value,
    toPath: canonTo.value,
    contestedBy: contestedBy.value,
    reason: reason.value,
  });
  if (!revoked.ok) return revoked;

  return ok({ edge: revoked.value, tension_id: tensionId });
}

// ---------------------------------------------------------------------------
// vault_edges
// ---------------------------------------------------------------------------

export interface EdgesResult {
  edges: DerivesFromEdge[];
  total: number;
}

export async function vaultEdges(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<EdgesResult, Error>> {
  const allowed = requireReadAccess("vault_edges", access);
  if (!allowed.ok) return allowed;

  const filter: { fromPath?: string; toPath?: string; status?: EdgeStatus } = {};
  for (const [argName, key] of [
    ["from_path", "fromPath"],
    ["to_path", "toPath"],
  ] as const) {
    const v = args[argName];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" || v.trim().length === 0) {
      return err(new Error(`vault_edges '${argName}' must be a non-empty string`));
    }
    const canon = canonicalRelPath(vaultRoot, v);
    if (!canon.ok) return canon;
    filter[key] = canon.value;
  }
  if (args.status !== undefined && args.status !== null) {
    if (
      typeof args.status !== "string" ||
      !(EDGE_STATUSES as readonly string[]).includes(args.status)
    ) {
      return err(new Error(`vault_edges 'status' must be one of: ${EDGE_STATUSES.join(", ")}`));
    }
    filter.status = args.status as EdgeStatus;
  }

  const edges = await listEdges(vaultRoot, filter);
  if (!edges.ok) return edges;
  return ok({ edges: edges.value, total: edges.value.length });
}

// ---------------------------------------------------------------------------
// MCP tool definitions
// ---------------------------------------------------------------------------

export const edgeTools: ToolDefinition[] = [
  {
    name: "vault_edge_observe",
    title: "Record a derives_from observation",
    annotations: { destructiveHint: false },
    description:
      "Record that a (re-)derivation observed a derives_from edge between two " +
      "documents. The first observation seeds the edge as a zero-strength " +
      "candidate; an edge earns strength only through later blind observations " +
      "that vary at least one axis (prompt | input-neighborhood | model). " +
      "Normally called by the consolidation loop, not by a human directly.",
    inputSchema: {
      type: "object",
      properties: {
        from_path: {
          type: "string",
          description: "Vault-relative path of the deriving document",
        },
        to_path: {
          type: "string",
          description: "Vault-relative path of the document it derives from",
        },
        observed_by: {
          type: "string",
          description: "Principal observing the edge, e.g. 'agent:curation-loop'",
        },
        blind: {
          type: "boolean",
          description:
            "True if this pass could not see the edge's prior existence or " +
            "strength. Only blind observations can count as independent votes.",
        },
        varied_axis: {
          type: "string",
          enum: [...EDGE_AXES],
          description:
            "Which axis this re-derivation varied versus prior passes. " +
            "Required for the observation to count as an independent vote.",
        },
        note: {
          type: "string",
          description: "Optional free-text context recorded with the observation",
        },
      },
      required: ["from_path", "to_path", "observed_by", "blind"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultEdgeObserve(vaultRoot, args, access),
  },
  {
    name: "vault_edge_contest",
    title: "Contest and revoke a derives_from edge",
    annotations: { destructiveHint: true },
    description:
      "Record a case-2 contradiction: a re-derivation failed with no upstream " +
      "change. The edge is revoked (drops below trigger-bearing) and a tension " +
      "is logged — contests surface loudly, never as silent decrements. A " +
      "revoked edge can only be re-earned through fresh observations. " +
      "Requires the role's 'ratify' grant (the curation-verdict tier).",
    inputSchema: {
      type: "object",
      properties: {
        from_path: {
          type: "string",
          description: "Vault-relative path of the deriving document",
        },
        to_path: {
          type: "string",
          description: "Vault-relative path of the document it claimed to derive from",
        },
        contested_by: {
          type: "string",
          description: "Principal contesting the edge, e.g. 'agent:curation-loop'",
        },
        reason: {
          type: "string",
          description: "Why the re-derivation failed (recorded on the tension)",
        },
      },
      required: ["from_path", "to_path", "contested_by", "reason"],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultEdgeContest(vaultRoot, args, access),
  },
  {
    name: "vault_edges",
    title: "List derives_from edges",
    annotations: { readOnlyHint: true },
    description:
      "List derives_from edges with their live aged strength, strongest " +
      "first. Strength = independent-vote count decayed by time since the " +
      "last qualifying re-derivation; an edge is trigger-bearing while its " +
      "aged strength stays above the floor. Filter by endpoint or status " +
      "(candidate | trigger-bearing | revoked).",
    inputSchema: {
      type: "object",
      properties: {
        from_path: {
          type: "string",
          description: "Only edges whose deriving document is this path",
        },
        to_path: {
          type: "string",
          description: "Only edges that derive from this path",
        },
        status: {
          type: "string",
          enum: [...EDGE_STATUSES],
          description: "Only edges currently in this status",
        },
      },
      required: [],
      additionalProperties: false,
    },
    handler: (vaultRoot, args, access) => vaultEdges(vaultRoot, args, access),
  },
];
