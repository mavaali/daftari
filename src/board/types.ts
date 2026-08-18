// Vault Board — shared type surface (U1).
//
// This file defines every type the board module builds on. It contains NO
// runtime logic: no functions, no class instances, no side-effecting imports.
// A handful of `const` tuple arrays are included where the pattern is
// idiomatic in this codebase (see staged-actions.ts, frontmatter/types.ts).
//
// Unit coverage: none — types only, verified by tsc --noEmit.

import type { AccessContext } from "../access/rbac.js";
import type { Confidence } from "../frontmatter/types.js";

// Re-export so callers importing from board/types.ts need not know the
// originating module.
export type { AccessContext, Confidence };

// ---------------------------------------------------------------------------
// BoardColumn — the five disposition buckets a finding card lives in.
// ---------------------------------------------------------------------------

export const BOARD_COLUMNS = ["new", "accepted", "waiting", "resolved", "dismissed"] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

// ---------------------------------------------------------------------------
// FindingSource — the five detection surfaces that feed the board.
// ---------------------------------------------------------------------------

export const FINDING_SOURCES = ["lint", "staleness", "tension", "staged", "tier2"] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];

// ---------------------------------------------------------------------------
// FindingTarget — heterogeneous per-source payload, discriminated by `kind`.
//
// - lint / staleness: a vault-relative path.
// - tension: a tension id (string).
// - staged: a staged-action id (string).
// - tier2: a (artifact path, unit path, edge class) tuple — the residual
//   compatibility pair the agent judges.
// ---------------------------------------------------------------------------

export interface LintTarget {
  kind: "lint";
  path: string;
}

export interface StalenessTarget {
  kind: "staleness";
  path: string;
}

export interface TensionTarget {
  kind: "tension";
  tensionId: string;
}

export interface StagedTarget {
  kind: "staged";
  stagedActionId: string;
}

export interface Tier2Target {
  kind: "tier2";
  artifact: string; // vault-relative path of the dependent
  unit: string; // vault-relative path of the changed upstream
  edgeClass: string; // the Tier1EdgeClass that queued this pair
}

export type FindingTarget =
  | LintTarget
  | StalenessTarget
  | TensionTarget
  | StagedTarget
  | Tier2Target;

// ---------------------------------------------------------------------------
// FindingDescriptor — a display snapshot carried on LedgerEvents so that
// resolved-and-absent findings can be rendered without the live finding.
//
// U11's dispose tool stamps this on ALL human events (accept/defer/dismiss/
// reassign) from the live finding. The reconciler reads it from whichever
// event has it (typically human disposition events) when rebuilding a
// skeleton for the Resolved column.
// ---------------------------------------------------------------------------

export interface FindingDescriptor {
  source: FindingSource;
  check: string;
  target: FindingTarget;
  /** Short human-readable summary of the finding. */
  label: string;
}

// ---------------------------------------------------------------------------
// LedgerEvent — one append-only record in a finding's disposition history.
//
// Spec shape:
//   { finding_id, event, by, principal_type, at, rationale?, expiry?,
//     against_fingerprint, owner?, identity_scheme_version, descriptor? }
//
// Human-authored events: accept | defer | dismiss | reassign.
// System-authored events: new | resolved | reopened.
// ---------------------------------------------------------------------------

export const LEDGER_EVENT_TYPES = [
  "new",
  "accept",
  "defer",
  "dismiss",
  "reassign",
  "resolved",
  "reopened",
] as const;
export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

export const PRINCIPAL_TYPES = ["human", "agent", "system"] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

export interface LedgerEvent {
  finding_id: string;
  event: LedgerEventType;
  /** The authenticated identity string (AccessContext.user) or a system actor label. */
  by: string;
  principal_type: PrincipalType;
  /** ISO 8601 timestamp of the event. */
  at: string;
  /** Human-readable explanation, required for human-authored events. */
  rationale?: string;
  /** ISO 8601 expiry time — set on `defer` to indicate when the wait ends. */
  expiry?: string;
  /**
   * The fingerprint of the finding at the time of this event. Records which
   * version of the finding the decision was made against, so a fingerprint
   * change (upstream change) can detect stale dispositions.
   */
  against_fingerprint: string;
  /** The owning user at the time of this event; present on reassign events. */
  owner?: string;
  /**
   * The version string of the identity scheme used to compute finding_id.
   * Allows safe migration if the hashing scheme ever changes.
   */
  identity_scheme_version: string;
  /**
   * Optional display snapshot of the finding at the time of this event.
   * U11's dispose tool stamps this on human disposition events (accept/defer/
   * dismiss/reassign) from the live finding. The reconciler reads it when
   * rebuilding skeleton resolved findings so the Resolved column can render
   * the real source/check/target/label without access to the live finding.
   */
  descriptor?: FindingDescriptor;
}

// ---------------------------------------------------------------------------
// Finding — the in-memory derived shape of a board card.
//
// `certainty` reuses the existing `Confidence` type ("low" | "medium" |
// "high") — the same signal the rest of the codebase uses for graded beliefs.
// `evidence` and `verify_predicate` are intentionally opaque at this layer:
// each source adapter fills them in with source-specific data; reconciliation
// and display layers consume them without needing a shared schema here.
// ---------------------------------------------------------------------------

export interface Finding {
  /** Stable content-addressed id, produced by the identity hasher (U2). */
  identity_key: string;

  /** Which detection surface emitted this finding. */
  source: FindingSource;

  /**
   * The specific check within the source (e.g. "staleFiles", "orphanFiles"
   * for lint; a tension kind for tension; "pending" for staged; etc.).
   */
  check: string;

  /** The vault entity this finding addresses — discriminated by source kind. */
  target: FindingTarget;

  /**
   * Optional secondary discriminator within a check (e.g. the lint check
   * sub-category, or a tension id when a single path has multiple tensions).
   * Used by the identity hasher to distinguish otherwise-identical findings.
   */
  discriminator?: string;

  /**
   * Content fingerprint of the underlying vault entity. Changes when the
   * underlying data changes, signalling that a prior disposition may be stale.
   * Computed by the source adapter (U2).
   */
  fingerprint: string;

  /**
   * How confident the detection is. Uses the canonical Confidence type
   * ("low" | "medium" | "high") shared across the rest of the codebase.
   */
  certainty: Confidence;

  /**
   * Opaque structured payload describing what was detected. Each source
   * adapter populates this with source-specific detail; downstream renderers
   * consume it without requiring a shared schema here.
   */
  evidence: Record<string, unknown>;

  /**
   * Short human-readable description of the deterministic re-check: what
   * a reviewer (or automated system) must verify to confirm the finding
   * still holds or has been resolved.
   */
  suggested_action: string;

  /**
   * A short human-readable string describing how to programmatically verify
   * that this finding still applies (e.g. "re-run lint check staleFiles on
   * path X" or "check tension T is still unresolved").
   */
  verify_predicate: string;

  /** The user who owns this finding for triage purposes. */
  owner: string;

  /** ISO 8601 timestamp when this finding first appeared. */
  first_seen: string;

  /** ISO 8601 timestamp of the most recent reconciliation that re-observed this finding. */
  last_seen: string;

  /**
   * Current disposition column. Derived by the reconciler (U4) from the
   * ledger; kept here for fast read access without replaying the full history.
   * Rationale/expiry/owner are available on the most recent LedgerEvent when
   * needed — not duplicated here to keep this field minimal.
   */
  disposition: BoardColumn;

  /** Append-only event history for this finding. */
  history: LedgerEvent[];
}

// ---------------------------------------------------------------------------
// FindingSourceAdapter — the interface each detection-surface adapter
// implements. The board's reconciler calls these to collect raw findings.
//
// `list`        — enumerate all current findings from this source.
// `identityOf`  — compute the stable identity_key for a raw finding.
// `fingerprintOf` — compute the content fingerprint for a raw finding.
// `reproduces`  — deterministic re-check: does this finding_identity_key
//                 still exist in the vault right now? Used to detect
//                 auto-resolved findings.
// ---------------------------------------------------------------------------

export interface FindingSourceAdapter {
  list(vaultRoot: string, access: AccessContext, now?: Date): Promise<Finding[]>;
  identityOf(raw: Finding): string;
  fingerprintOf(raw: Finding): string;
  reproduces(
    identity_key: string,
    vaultRoot: string,
    access: AccessContext,
    now?: Date,
  ): Promise<boolean>;
}
