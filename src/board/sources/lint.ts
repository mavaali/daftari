// lint.ts — U5: Lint source adapter.
//
// Wraps runLint (src/curation/lint.ts) and maps each LintFinding to a Finding.
// RBAC is enforced by filtering findings whose target path's collection the
// caller role cannot read (R17, R18). Denied findings are OMITTED entirely —
// no count, no placeholder.
//
// Collection resolution: collectionForPath(null, path) from
// src/storage/index-db.ts — the same function the rest of the codebase uses.
// With db=null it falls back to path.split("/")[0], which is correct because
// every vault path is collection/rest.md by structural convention. This keeps
// RBAC consistent with the search and tension-access layers.
//
// Discriminator decisions (per-check, see R2):
//
//   All 15 checks produce at most ONE LintFinding per path in the current
//   implementation of runLint. The tier-0 checks (brokenSourceRefs,
//   lifecycleConflicts, domainLeaks) aggregate multiple offenders into one
//   detail string. orphanFiles, staleFiles, oldDrafts, stagnantLowConfidence,
//   retiredStillLinked, unansweredQuestions, schemaInvalid, validityConflicts,
//   verbatimQuoteOverrun each push at most one entry per doc-pass.
//
//   tierDemotions, positionIntegrity, malformedPins CAN push multiple entries
//   for the same path (one per provenance log entry / per position issue / per
//   malformed describes entry). However:
//     - tierDemotions detail contains a volatile timestamp → cannot be used as
//       stable discriminator (R2). Multiple entries for the same path collapse
//       to one Finding. TODO: if sub-path-granularity is needed, a stable
//       provenance entry id would need to be added to the provenance log.
//     - positionIntegrity detail contains position IDs (stable) but the
//       detail string is long and complex. Conservative: no discriminator.
//       TODO: could split on position ID if the adapter were restructured to
//       receive structured (not string) position findings.
//     - malformedPins: the describes entry string is stable, but conservative:
//       no discriminator. TODO: if per-entry identity is needed, the raw
//       describes entry string is a valid stable discriminator.
//
//   For all checks: no discriminator. One Finding per (check, path).
//   If runLint emits multiple LintFindings for the same (check, path), only
//   the LAST one is kept (later evidence overwrites earlier for same identity).
//   This is acceptable: the fingerprint will reflect the last detail seen, and
//   the ledger will re-triage if it drifts.

import type { AccessContext } from "../../access/rbac.js";
import { canRead } from "../../access/rbac.js";
import { type LintCheckName, runLint, TIER0_LINT_CHECKS } from "../../curation/lint.js";
import type { Confidence } from "../../frontmatter/types.js";
import { collectionForPath } from "../../storage/index-db.js";
import { deriveIdentity, fingerprint } from "../identity.js";
import type { Finding, FindingSourceAdapter, LintTarget } from "../types.js";

// ---------------------------------------------------------------------------
// Certainty mapping
// ---------------------------------------------------------------------------

// Tier-0 checks are certain structural failures (not advisory judgments) →
// "high". All other checks are advisory → "medium".
const TIER0_SET = new Set<LintCheckName>(TIER0_LINT_CHECKS);

function certaintyFor(check: LintCheckName): Confidence {
  return TIER0_SET.has(check) ? "high" : "medium";
}

// ---------------------------------------------------------------------------
// Suggested action text per check
// ---------------------------------------------------------------------------

const SUGGESTED_ACTIONS: Record<LintCheckName, string> = {
  staleFiles: "Update or archive the document; its TTL has expired",
  orphanFiles: "Link to this document from at least one other vault document",
  oldDrafts: "Promote, abandon, or archive this draft",
  stagnantLowConfidence: "Revisit and update this low-confidence document",
  retiredStillLinked: "Remove or update links to this retired document",
  unansweredQuestions: "Add answers to the raised questions in an appropriate document",
  tierDemotions: "Review the tier demotion and confirm it was intentional",
  brokenSourceRefs: "Fix or remove the unresolvable sources[] reference(s)",
  lifecycleConflicts: "Update sources[] to remove non-canonical dependencies",
  schemaInvalid: "Fix the schema validation errors in the document frontmatter",
  domainLeaks: "Remove generative-domain citations from an accumulation-domain document",
  validityConflicts: "Correct the valid-time interval fields in the document",
  positionIntegrity: "Fix the position set integrity issue in the document",
  malformedPins: "Fix the malformed pin suffix in the describes entry",
  verbatimQuoteOverrun: "Paraphrase verbatim quotes or add sources[] attribution",
};

// ---------------------------------------------------------------------------
// lintAdapter — the FindingSourceAdapter for the "lint" source
// ---------------------------------------------------------------------------

export const lintAdapter: FindingSourceAdapter & {
  list(vaultRoot: string, access: AccessContext, now?: Date): Promise<Finding[]>;
  reproduces(
    identity_key: string,
    vaultRoot: string,
    access: AccessContext,
    now?: Date,
  ): Promise<boolean>;
} = {
  /**
   * Enumerate all current lint findings, filtered by RBAC.
   *
   * `now` is injected for determinism/testability. Defaults to `new Date()`
   * if omitted. This matches the LintOptions.now contract in runLint.
   */
  async list(vaultRoot: string, access: AccessContext, now?: Date): Promise<Finding[]> {
    const nowDate = now ?? new Date();
    const result = await runLint(vaultRoot, { now: nowDate });
    if (!result.ok) {
      // Surface errors as an empty list rather than throwing — the board engine
      // treats an empty list as "no findings", not a fatal error. The caller
      // can diagnose from logs; a thrown error would crash the reconcile run.
      return [];
    }

    const report = result.value;
    const nowIso = nowDate.toISOString();

    // Collect findings: one per (checkName, path). If runLint emits multiple
    // LintFindings for the same path under the same check, last one wins
    // (map key collision). See discriminator decisions in the file header.
    const rawFindings: Finding[] = [];
    const seen = new Map<string, Finding>();

    for (const checkName of Object.keys(report.checks) as LintCheckName[]) {
      for (const lintFinding of report.checks[checkName]) {
        const { path, detail } = lintFinding;

        // RBAC: resolve collection for path and check read permission.
        const collection = collectionForPath(null, path);
        if (!canRead(access.role, collection)) {
          continue; // omit entirely — no placeholder, no count (R18)
        }

        const target: LintTarget = { kind: "lint", path };
        // No discriminator for any check (see file header).
        const identity_key = deriveIdentity("lint", checkName, target);
        const evidence: Record<string, unknown> = { detail };
        const fp = fingerprint(evidence);

        const finding: Finding = {
          identity_key,
          source: "lint",
          check: checkName,
          target,
          // discriminator: undefined — no check requires a discriminator
          fingerprint: fp,
          certainty: certaintyFor(checkName),
          evidence,
          suggested_action: SUGGESTED_ACTIONS[checkName],
          verify_predicate: `lint:${checkName} on ${path}`,
          owner: "",
          first_seen: nowIso,
          last_seen: nowIso,
          disposition: "new",
          history: [],
        };

        // Dedup by identity_key — last entry for same (check, path) wins.
        seen.set(identity_key, finding);
      }
    }

    return [...seen.values()];
  },

  /**
   * Re-derive the identity key from the Finding's own fields.
   * Stateless — purely from the stored source/check/target/discriminator.
   */
  identityOf(raw: Finding): string {
    return deriveIdentity("lint", raw.check, raw.target, raw.discriminator);
  },

  /**
   * Re-derive the content fingerprint from the Finding's current evidence.
   */
  fingerprintOf(raw: Finding): string {
    return fingerprint(raw.evidence);
  },

  /**
   * Re-run lint and check whether any current finding has the given identity_key.
   * RBAC-respecting: only findings the access context can read are considered.
   *
   * `now` is injected for determinism. Defaults to `new Date()` if omitted.
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
