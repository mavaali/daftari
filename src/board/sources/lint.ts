// lint.ts — U5: Lint source adapter.
//
// Wraps runLint (src/curation/lint.ts) and maps each LintFinding to a Finding.
// RBAC is enforced by filtering findings whose target path's collection the
// caller role cannot read (R17, R18). Denied findings are OMITTED entirely —
// no count, no placeholder.
//
// Collection resolution: uses openIndexForAccessOrNull (from tools/search.ts)
// to open the index for the active embedding provider, then calls
// collectionForPath(db, path). This resolves the INDEXED collection
// (frontmatter.collection) exactly as search.ts does — avoiding the RBAC
// inconsistency where collectionForPath(null, path) uses path-prefix only,
// while the indexed collection may differ (daftari allows frontmatter.collection
// != path-prefix). Falls back to path-prefix only when db is null (degraded:
// index unavailable). The db handle is opened once per list/reproduces call
// and closed in a finally block, mirroring the read.ts / tension-access.ts
// pattern.
//
// Discriminator decisions (per-check, see R2):
//
//   verbatimQuoteOverrun pushes TWO distinct findings per path when BOTH the
//   char-overrun condition AND the no-attribution condition fire. The adapter
//   parses a stable token from the detail string:
//     "char-overrun"   — detail contains "verbatim-quoted chars exceed cap"
//     "no-attribution" — detail contains "no sources[] attribution"
//   These tokens are derived from stable substrings (not volatile numbers),
//   so the discriminator is stable across reconcile runs. Two independent
//   Finding cards are emitted; resolving one does not affect the other.
//
//   malformedPins pushes one finding per malformed describes entry. The raw
//   entry string appears in the detail after "malformed pin suffix in describes
//   entry: ". That suffix is stable (it's the raw describes entry text), so
//   the adapter uses it as the discriminator. Each malformed entry gets its
//   own Finding card.
//
//   tierDemotions detail contains a volatile timestamp → cannot be used as
//   stable discriminator (R2). Multiple entries for the same path collapse
//   to one Finding. TODO: if sub-path-granularity is needed, a stable
//   provenance entry id would need to be added to the provenance log.
//
//   positionIntegrity CAN push multiple entries for the same path (one per
//   position issue). KNOWN R27 LIMITATION: these all fold to one Finding
//   (last-wins dedup by identity_key). A clean fix requires restructured
//   (non-string) lint output so stable position IDs can be extracted without
//   brittle string parsing of the complex detail strings. A follow-up bead
//   tracks this. The header note below documents it explicitly.
//
//   All other checks: no discriminator. One Finding per (check, path).
//   If runLint emits multiple LintFindings for the same (check, path) and
//   no discriminator is assigned, only the LAST one is kept (later evidence
//   overwrites earlier for same identity). The fingerprint will reflect the
//   last detail seen, and the ledger will re-triage if it drifts.

import type { AccessContext } from "../../access/rbac.js";
import { canRead } from "../../access/rbac.js";
import { type LintCheckName, runLint, TIER0_LINT_CHECKS } from "../../curation/lint.js";
import type { Confidence } from "../../frontmatter/types.js";
import { collectionForPath } from "../../storage/index-db.js";
import { openIndexForAccessOrNull } from "../../tools/search.js";
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
  unverifiableSourceRefs: "Restore or correct the repository source, or configure repo_root",
};

// ---------------------------------------------------------------------------
// discriminatorFor — stable per-finding discriminator token.
//
// Returns a stable string for findings that can produce multiple entries per
// path under the same check, or undefined for checks where one finding per
// (check, path) is correct.
// ---------------------------------------------------------------------------

function discriminatorFor(checkName: LintCheckName, detail: string): string | undefined {
  switch (checkName) {
    case "verbatimQuoteOverrun":
      // runLint can push TWO findings per path: a char-overrun AND a
      // no-attribution. Parse a stable token from the stable substring of each.
      if (detail.includes("verbatim-quoted chars exceed cap")) return "char-overrun";
      if (detail.includes("no sources[] attribution")) return "no-attribution";
      // Defensive fallback: unknown verbatimQuoteOverrun detail → no discriminator.
      return undefined;

    case "malformedPins": {
      // Detail format: "malformed pin suffix in describes entry: <raw-entry>"
      // The raw describes entry is stable — use it as the discriminator.
      const PREFIX = "malformed pin suffix in describes entry: ";
      const idx = detail.indexOf(PREFIX);
      if (idx !== -1) return detail.slice(idx + PREFIX.length).trim();
      return undefined;
    }

    default:
      // All other checks: no discriminator. One Finding per (check, path).
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// lintAdapter — the FindingSourceAdapter for the "lint" source
// ---------------------------------------------------------------------------

export const lintAdapter: FindingSourceAdapter = {
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

    // RBAC: open the index to resolve frontmatter.collection, mirroring
    // exactly how search.ts resolves collection for RBAC decisions. Falls back
    // to the path-prefix rule when the index is unavailable (db is null).
    const db = openIndexForAccessOrNull(vaultRoot);

    try {
      // Collect findings: one per (checkName, path, discriminator?).
      // verbatimQuoteOverrun and malformedPins can produce multiple entries per
      // path — they get distinct discriminators so each is a separate card.
      // All other checks: last entry for same (check, path) wins (map collision).
      // See discriminator decisions in the file header.
      const seen = new Map<string, Finding>();

      for (const checkName of Object.keys(report.checks) as LintCheckName[]) {
        for (const lintFinding of report.checks[checkName]) {
          const { path, detail } = lintFinding;

          // RBAC: resolve collection from the index (frontmatter), falling back
          // to path-prefix when the index is unavailable. This matches the
          // resolution search.ts uses, preventing divergence between the board
          // adapter's RBAC decision and the search tool's RBAC decision.
          const collection = collectionForPath(db, path);
          if (!canRead(access.role, collection)) {
            continue; // omit entirely — no placeholder, no count (R18)
          }

          const target: LintTarget = { kind: "lint", path };
          const discriminator = discriminatorFor(checkName, detail);
          const identity_key = deriveIdentity("lint", checkName, target, discriminator);
          const evidence: Record<string, unknown> = { detail };
          const fp = fingerprint(evidence);

          const finding: Finding = {
            identity_key,
            source: "lint",
            check: checkName,
            target,
            ...(discriminator !== undefined ? { discriminator } : {}),
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

          // Dedup by identity_key — last entry for same (check, path, discriminator?) wins.
          seen.set(identity_key, finding);
        }
      }

      return [...seen.values()];
    } finally {
      db?.close();
    }
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
