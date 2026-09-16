// staged.ts — U7: Staged-actions source adapter.
//
// Wraps listStagedActions (src/curation/staged-actions.ts) and maps each
// PENDING StagedAction to a Finding. Non-pending actions (ratified, rejected,
// expired) are excluded: they are no longer open work items.
//
// Identity: NATIVE-ID path — deriveIdentity("staged", check, target) where
//   target = { kind:"staged", stagedActionId: id }
//   identity.ts fast-path returns "staged:<id>" ignoring source/check/evidence.
//   This guarantees the same real-world staged action always maps to one key,
//   regardless of what check name or evidence is associated with it.
//
// RBAC: filter by targetPath's collection, exactly as lint and staleness do.
//   openIndexForAccessOrNull + collectionForPath + canRead(access.role, collection).
//   Denied findings are omitted entirely — no placeholder, no count (R17/R18).
//
// reproduces: true iff the action id is still present AND pending.
//   Delegates to list() and checks for a matching identity_key.

import type { AccessContext } from "../../access/rbac.js";
import { canRead } from "../../access/rbac.js";
import { listStagedActions } from "../../curation/staged-actions.js";
import { collectionForPath } from "../../storage/index-db.js";
import { openIndexForAccessOrNull } from "../../tools/search.js";
import { deriveIdentity, fingerprint } from "../identity.js";
import type { Finding, FindingSourceAdapter, StagedTarget } from "../types.js";

// The single check name for this adapter. Stable — never change this after
// ledger entries are written (it feeds into verify_predicate strings but NOT
// into the native-id identity_key for staged targets).
const STAGED_CHECK = "pending-ratification";

export const stagedAdapter: FindingSourceAdapter = {
  /**
   * Enumerate all PENDING staged actions, filtered by RBAC on the targetPath.
   *
   * `now` is accepted for interface consistency but staged-actions listing
   * does not consume it directly (expiry sweeping is a separate concern).
   */
  async list(vaultRoot: string, access: AccessContext, _now?: Date): Promise<Finding[]> {
    const nowIso = (_now ?? new Date()).toISOString();

    const result = await listStagedActions(vaultRoot, "pending");
    if (!result.ok) {
      // Surface errors as empty list — same policy as lint/staleness adapters.
      return [];
    }

    const db = openIndexForAccessOrNull(vaultRoot);
    try {
      const findings: Finding[] = [];

      for (const action of result.value) {
        // Only pending actions are surface-worthy (list already filtered, but
        // guard defensively in case the filter arg is ignored).
        if (action.status !== "pending") continue;

        // RBAC: resolve targetPath's collection and check read permission.
        const collection = collectionForPath(db, action.targetPath);
        if (!canRead(access.role, collection)) {
          continue; // omit entirely — no placeholder, no count (R17/R18)
        }

        const target: StagedTarget = { kind: "staged", stagedActionId: action.id };
        // Native-id fast-path: identity_key = "staged:<action.id>"
        // source/check/discriminator are intentionally ignored by deriveIdentity
        // for staged targets.
        const identity_key = deriveIdentity("staged", STAGED_CHECK, target);

        // Fingerprint covers volatile fields: status could change on ratification,
        // expiresAt is a fixed-at-proposal timestamp but relevant for drift detection.
        // rationale and actionType are stable but included for completeness.
        const evidence: Record<string, unknown> = {
          actionType: action.actionType,
          targetPath: action.targetPath,
          rationale: action.rationale,
          expiresAt: action.expiresAt,
          status: action.status,
        };
        const fp = fingerprint(evidence);

        findings.push({
          identity_key,
          source: "staged",
          check: STAGED_CHECK,
          target,
          fingerprint: fp,
          certainty: "medium",
          evidence,
          suggested_action: `Ratify or reject staged action ${action.id} (${action.actionType}) on ${action.targetPath}`,
          verify_predicate: `staged:${STAGED_CHECK} id=${action.id} status=pending`,
          owner: "",
          first_seen: nowIso,
          last_seen: nowIso,
          disposition: "new",
          history: [],
        });
      }

      return findings;
    } finally {
      db?.close();
    }
  },

  /**
   * Re-derive the identity key from the Finding's own fields.
   * For staged targets, deriveIdentity returns the native-id "staged:<id>".
   */
  identityOf(raw: Finding): string {
    return deriveIdentity("staged", raw.check, raw.target, raw.discriminator);
  },

  /**
   * Re-derive the content fingerprint from the Finding's current evidence.
   */
  fingerprintOf(raw: Finding): string {
    return fingerprint(raw.evidence);
  },

  /**
   * Re-check whether this staged action is still pending.
   * Delegates to list() and checks for a matching identity_key.
   */
  async reproduces(
    identity_key: string,
    vaultRoot: string,
    access: AccessContext,
    now?: Date,
  ): Promise<boolean> {
    const currentFindings = await this.list(vaultRoot, access, now);
    return currentFindings.some((f) => f.identity_key === identity_key);
  },
};
