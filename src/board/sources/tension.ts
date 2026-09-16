// tension.ts — U8: Tension source adapter.
//
// Wraps listTensions (src/curation/tension.ts) filtered to UNRESOLVED entries
// and maps each to a Finding. Resolved tensions and legacy entries with no
// native `id` are excluded.
//
// Identity: NATIVE-ID path — deriveIdentity("tension", check, target) where
//   target = { kind:"tension", tensionId: entry.id }
//   identity.ts fast-path returns "tension:<id>", ignoring source/check/evidence.
//   This guarantees the same real-world tension always maps to one key,
//   regardless of which check name or evidence is associated with it.
//
// RBAC — BOTH-SIDES rule (R19):
//   canSeeTension(db, access, sourceA, sourceB) from tension-access.ts is the
//   canonical gate. A caller must be able to read BOTH sides' collections.
//   If EITHER side is in a denied collection the entry is OMITTED ENTIRELY —
//   no placeholder, no count, no existence signal. Never hand-roll this rule.
//
// Fingerprint: fingerprint({ claimA, claimB, status, kind }) so that:
//   - An edited claim drifts the fingerprint → re-triage signal (R21).
//   - The identity_key (derived from the native id) stays stable.
//
// Legacy tensions (no `id` field): EXCLUDED.
//   Legacy entries predate the id-assignment phase (tension.ts:18-19). Without
//   a stable native id there is no safe way to disposition them — any identity
//   key we mint would be content-addressed (not entity-addressed) and would
//   change if the entry is edited. Excluding them is the correct safe behaviour.
//   Callers that need to surface legacy tensions should migrate them via
//   vault_tension_log to obtain assigned ids.
//
// reproduces: true iff the tension id is still present AND unresolved AND
//   still visible to this caller. Delegates to list() and checks for a
//   matching identity_key.

import type { AccessContext } from "../../access/rbac.js";
import { listTensions } from "../../curation/tension.js";
import { canSeeTension } from "../../curation/tension-access.js";
import { openIndexForAccessOrNull } from "../../tools/search.js";
import { deriveIdentity, fingerprint } from "../identity.js";
import type { Finding, FindingSourceAdapter, TensionTarget } from "../types.js";

// The single check name for this adapter. Stable — never change this after
// ledger entries are written (it feeds into verify_predicate strings but NOT
// into the native-id identity_key for tension targets).
const TENSION_CHECK = "unresolved-tension";

export const tensionAdapter: FindingSourceAdapter = {
  /**
   * Enumerate all UNRESOLVED tensions with a native id, filtered by the
   * both-sides RBAC rule (canSeeTension).
   *
   * `now` is accepted for interface consistency; tension listing does not
   * consume it (no time-dependent staleness computation here).
   */
  async list(vaultRoot: string, access: AccessContext, now?: Date): Promise<Finding[]> {
    const nowIso = (now ?? new Date()).toISOString();

    const result = await listTensions(vaultRoot, "unresolved");
    if (!result.ok) {
      // Surface errors as empty list — same policy as lint/staleness/staged adapters.
      return [];
    }

    const db = openIndexForAccessOrNull(vaultRoot);
    try {
      const findings: Finding[] = [];

      for (const entry of result.value) {
        // EXCLUDE: legacy entries without a native id.
        // Without a stable id we cannot safely mint a permanent identity key.
        // See module-level comment above.
        if (entry.id === undefined) continue;

        // Defensive guard: listTensions filtered to "unresolved", but double-check.
        if (entry.resolved) continue;

        // BOTH-SIDES RBAC gate — the canonical rule from tension-access.ts.
        // Omit entirely if the caller cannot read EITHER side's collection.
        // Never hand-roll: this single call is the audited, tested gate (R19).
        if (!canSeeTension(db, access, entry.sourceA, entry.sourceB)) {
          continue; // omit — no placeholder, no count, no existence signal
        }

        const target: TensionTarget = { kind: "tension", tensionId: entry.id };
        // Native-id fast-path: identity_key = "tension:<entry.id>"
        // source/check/discriminator are intentionally ignored by deriveIdentity
        // for tension targets.
        const identity_key = deriveIdentity("tension", TENSION_CHECK, target);

        // Fingerprint covers the claim text and status so that:
        //   - An edited claim (claimA or claimB) drifts the fingerprint → re-triage.
        //   - The identity_key stays stable (it only uses the native id).
        // `kind` is included because it classifies the nature of the conflict;
        // a kind change (e.g. factual → interpretive) is meaningful enough to
        // warrant re-triage.
        const fingerprintEvidence: Record<string, unknown> = {
          claimA: entry.claimA,
          claimB: entry.claimB,
          status: entry.status,
          kind: entry.kind,
        };
        const fp = fingerprint(fingerprintEvidence);

        // Evidence for display — includes all fingerprint fields so that
        // fingerprintOf(raw) can reconstruct the same hash from the evidence blob.
        const evidence: Record<string, unknown> = {
          title: entry.title,
          kind: entry.kind,
          sourceA: entry.sourceA,
          claimA: entry.claimA,
          sourceB: entry.sourceB,
          claimB: entry.claimB,
          status: entry.status,
        };

        findings.push({
          identity_key,
          source: "tension",
          check: TENSION_CHECK,
          target,
          fingerprint: fp,
          certainty: "medium",
          evidence,
          suggested_action: `Review and resolve tension ${entry.id} (${entry.kind}): ${entry.title}`,
          verify_predicate: `tension:${TENSION_CHECK} id=${entry.id} status=unresolved`,
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
   * For tension targets, deriveIdentity returns the native-id "tension:<id>".
   */
  identityOf(raw: Finding): string {
    return deriveIdentity("tension", raw.check, raw.target, raw.discriminator);
  },

  /**
   * Re-derive the content fingerprint from the Finding's current evidence.
   * Uses only the fingerprint-relevant fields (claimA, claimB, status, kind)
   * extracted from the evidence blob.
   */
  fingerprintOf(raw: Finding): string {
    const { claimA, claimB, status, kind } = raw.evidence as {
      claimA: unknown;
      claimB: unknown;
      status: unknown;
      kind: unknown;
    };
    return fingerprint({ claimA, claimB, status, kind });
  },

  /**
   * Re-check whether this tension is still unresolved AND visible to this caller.
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
