// staleness.ts — U6: Staleness + edge-staleness source adapters.
//
// Two FindingSourceAdapter implementations:
//
//   ttlStalenessAdapter
//     Wraps computeStaleness (src/curation/staleness.ts) over every vault doc
//     that has expired its TTL. Emits one Finding per expired doc.
//     - source: "staleness", check: "ttl-staleness"
//     - target: StalenessTarget { kind:"staleness", path }
//     - identity: deriveIdentity("staleness", "ttl-staleness", target)
//       No discriminator: one finding per path.
//     - fingerprint: fingerprint({score, ageDays}) — VOLATILE by design.
//       Identity does NOT include score/ageDays; these drift daily. This is
//       the exact "identity-stable / fingerprint-drifts" case (R2).
//     - RBAC: path's collection resolved via openIndexForAccessOrNull +
//       collectionForPath, same as lint adapter (R17/R18).
//
//   edgeStalenessAdapter
//     Wraps upstreamStaleness (src/curation/edge-staleness.ts) over every
//     vault artifact and its upstream edges. Emits one Finding per
//     pending-broken row (artifact, unit, edge_class).
//     - source: "staleness", check: "edge-staleness"
//     - target: Tier2Target { kind:"tier2", artifact, unit, edgeClass }
//       Note: edge-staleness and the tier-2 queue share the Tier2Target shape
//       because both address the same (artifact, unit, edgeClass) triple.
//       The board engine distinguishes them by source+check, not target kind.
//     - identity: deriveIdentity("staleness", "edge-staleness", target)
//       The tuple makes it unique per (artifact,unit,edge_class).
//     - fingerprint: fingerprint({staleness, changed_fields, baseline}) —
//       volatile (staleness state can change when verdicts land).
//     - RBAC: filter by the ARTIFACT's collection (not the unit). A finding
//       about a dependent the caller cannot read is omitted entirely (R17).
//
// Surfaced edge-staleness states: ONLY "pending-broken".
//   "current"            — not a problem, no finding.
//   "pending-compatible" — cosmetic, not an incident; not surfaced.
//   "pending-unchecked"  — incomplete information; surfaced by the tier-2
//                          queue tool (U8), not here, to avoid double cards.
//   "unverifiable"       — unit deleted/invisible; RBAC/existence oracle risk
//                          if named; not surfaced here.
//   Conservative choice: pending-broken is the only state that constitutes a
//   known-wrong read incident per the edge-staleness spec (#234).
//
// Dependency injection for edge-staleness (testability):
//   makeEdgeStalenessAdapter(fn) creates an adapter that calls
//   `fn(artifact)` → UpstreamStaleness[] instead of the real loading path.
//   Tests inject a pre-canned function to drive the mapping logic without
//   building a full provenance/consumes/edges graph fixture. The production
//   export `edgeStalenessAdapter` uses the real upstreamStaleness path via
//   the full loader (loadQueueSources pattern from tools/tier2.ts).

import type { AccessContext } from "../../access/rbac.js";
import { canRead } from "../../access/rbac.js";
import { type UpstreamStaleness, upstreamStaleness } from "../../curation/edge-staleness.js";
import { listEdges } from "../../curation/edges.js";
import { readProvenanceLog } from "../../curation/provenance.js";
import { computeStaleness } from "../../curation/staleness.js";
import { readTier2Verdicts } from "../../curation/tier2.js";
import { loadDocuments } from "../../curation/vault-docs.js";
import { collectionForPath } from "../../storage/index-db.js";
import { openIndexForAccessOrNull } from "../../tools/search.js";
import { deriveIdentity, fingerprint } from "../identity.js";
import type { Finding, FindingSourceAdapter, StalenessTarget, Tier2Target } from "../types.js";

// ---------------------------------------------------------------------------
// TTL staleness adapter
// ---------------------------------------------------------------------------

export const ttlStalenessAdapter: FindingSourceAdapter = {
  /**
   * Enumerate all vault docs whose TTL has expired, filtered by RBAC.
   *
   * `now` is injected for determinism/testability. Defaults to `new Date()`.
   */
  async list(vaultRoot: string, access: AccessContext, now?: Date): Promise<Finding[]> {
    const nowDate = now ?? new Date();
    const nowIso = nowDate.toISOString();

    const loaded = await loadDocuments(vaultRoot);
    if (!loaded.ok) return [];

    const db = openIndexForAccessOrNull(vaultRoot);
    try {
      const findings: Finding[] = [];

      for (const doc of loaded.value) {
        const { path, frontmatter: fm } = doc;

        // RBAC: resolve collection and check read permission.
        const collection = collectionForPath(db, path);
        if (!canRead(access.role, collection)) {
          continue; // omit entirely (R17/R18)
        }

        // TTL staleness: emit only for expired docs.
        const staleness = computeStaleness({ updated: fm.updated, ttl_days: fm.ttl_days }, nowDate);
        if (!staleness.expired) continue;

        const target: StalenessTarget = { kind: "staleness", path };
        const identity_key = deriveIdentity("staleness", "ttl-staleness", target);
        // Fingerprint is volatile: score and ageDays drift daily as time passes.
        // They MUST NOT feed into the identity — that is the whole design point.
        const evidence: Record<string, unknown> = {
          score: staleness.score,
          ageDays: staleness.ageDays,
          ttlDays: staleness.ttlDays,
        };
        // fingerprint covers all evidence fields. score and ageDays are the
        // volatile parts (they drift daily); ttlDays is stable but harmless to
        // include. fingerprintOf must use the same set — calling fingerprint(raw.evidence)
        // is correct because evidence == {score, ageDays, ttlDays}.
        const fp = fingerprint(evidence);

        findings.push({
          identity_key,
          source: "staleness",
          check: "ttl-staleness",
          target,
          fingerprint: fp,
          certainty: "medium",
          evidence,
          suggested_action: "Update or archive this document; its TTL has expired",
          verify_predicate: `staleness:ttl-staleness on ${path}`,
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

  identityOf(raw: Finding): string {
    return deriveIdentity("staleness", raw.check, raw.target, raw.discriminator);
  },

  fingerprintOf(raw: Finding): string {
    return fingerprint(raw.evidence);
  },

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

// ---------------------------------------------------------------------------
// Edge staleness adapter — factory + production singleton
// ---------------------------------------------------------------------------

/**
 * Type of the injectable upstream-staleness function.
 * Given an artifact path, returns its upstream staleness rows.
 */
type UpstreamStalenessFn = (artifact: string) => UpstreamStaleness[];

/**
 * makeEdgeStalenessAdapter — factory for testability.
 *
 * In tests, inject a function that returns pre-canned UpstreamStaleness rows.
 * In production, use the real loading path via `edgeStalenessAdapter`.
 *
 * Only "pending-broken" rows produce a Finding. See file header for rationale.
 */
export function makeEdgeStalenessAdapter(upstreamFn: UpstreamStalenessFn): FindingSourceAdapter {
  return {
    async list(vaultRoot: string, access: AccessContext, now?: Date): Promise<Finding[]> {
      const nowDate = now ?? new Date();
      const nowIso = nowDate.toISOString();

      const loaded = await loadDocuments(vaultRoot);
      if (!loaded.ok) return [];

      const db = openIndexForAccessOrNull(vaultRoot);
      try {
        const findings: Finding[] = [];

        for (const doc of loaded.value) {
          const artifact = doc.path;

          // RBAC: filter by ARTIFACT collection (R17).
          const collection = collectionForPath(db, artifact);
          if (!canRead(access.role, collection)) continue;

          // Get upstream staleness rows for this artifact via the injected fn.
          const rows = upstreamFn(artifact);

          for (const row of rows) {
            // Only surface pending-broken (see "surfaced states" in file header).
            if (row.staleness !== "pending-broken") continue;

            const target: Tier2Target = {
              kind: "tier2",
              artifact,
              unit: row.unit,
              edgeClass: row.edge_class,
            };
            const identity_key = deriveIdentity("staleness", "edge-staleness", target);
            // Fingerprint covers volatile fields: the staleness state can change
            // when a tier-2 verdict lands; changed_fields and baseline are its
            // descriptive context.
            const evidence: Record<string, unknown> = {
              staleness: row.staleness,
              changed_fields: row.changed_fields,
              baseline: row.baseline,
              reason: row.reason,
            };
            // fingerprint covers all evidence fields. staleness/changed_fields/baseline
            // are the volatile parts; reason is included too. fingerprintOf must use
            // the same set — calling fingerprint(raw.evidence) is correct because
            // evidence == {staleness, changed_fields, baseline, reason}.
            const fp = fingerprint(evidence);

            findings.push({
              identity_key,
              source: "staleness",
              check: "edge-staleness",
              target,
              fingerprint: fp,
              certainty: "medium",
              evidence,
              suggested_action: `Review ${row.unit} — upstream change may have broken ${artifact}`,
              verify_predicate: `staleness:edge-staleness artifact=${artifact} unit=${row.unit} class=${row.edge_class}`,
              owner: "",
              first_seen: nowIso,
              last_seen: nowIso,
              disposition: "new",
              history: [],
            });
          }
        }

        return findings;
      } finally {
        db?.close();
      }
    },

    identityOf(raw: Finding): string {
      return deriveIdentity("staleness", raw.check, raw.target, raw.discriminator);
    },

    fingerprintOf(raw: Finding): string {
      return fingerprint(raw.evidence);
    },

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
}

/**
 * Production edge-staleness adapter.
 *
 * Loads consumes, provenance, earned edges, and tier-2 verdicts for each
 * artifact and calls the real upstreamStaleness function. This mirrors the
 * loading pattern in tools/tier2.ts (loadQueueSources).
 *
 * Because loading is async but makeEdgeStalenessAdapter's upstreamFn is sync,
 * the production adapter is built separately — it does the async loading
 * inside list() and feeds the result into the same mapping logic.
 */
export const edgeStalenessAdapter: FindingSourceAdapter = {
  async list(vaultRoot: string, access: AccessContext, now?: Date): Promise<Finding[]> {
    const nowDate = now ?? new Date();
    const nowIso = nowDate.toISOString();

    // Load all sources needed for upstreamStaleness.
    const loaded = await loadDocuments(vaultRoot);
    if (!loaded.ok) return [];

    const provenanceResult = await readProvenanceLog(vaultRoot);
    if (!provenanceResult.ok) return [];

    const verdictsResult = await readTier2Verdicts(vaultRoot);
    if (!verdictsResult.ok) return [];

    const edgesResult = await listEdges(vaultRoot);
    if (!edgesResult.ok) return [];

    // Build earned edges map: artifact → [{unit, lastRederived}]
    const earnedByArtifact = new Map<string, { unit: string; lastRederived: string }[]>();
    for (const e of edgesResult.value) {
      if (e.status === "revoked") continue;
      const list = earnedByArtifact.get(e.fromPath) ?? [];
      list.push({ unit: e.toPath, lastRederived: e.lastRederived });
      earnedByArtifact.set(e.fromPath, list);
    }

    const db = openIndexForAccessOrNull(vaultRoot);
    try {
      const findings: Finding[] = [];

      for (const doc of loaded.value) {
        const artifact = doc.path;

        // RBAC: filter by ARTIFACT collection.
        const collection = collectionForPath(db, artifact);
        if (!canRead(access.role, collection)) continue;

        // Compute upstream staleness for this artifact.
        // Note: we skip compiled edges (consumes: []) to keep the load light
        // and match the tier-2 queue pattern from tools/tier2.ts (which only
        // processes declared/earned residuals). Compiled-edge findings are
        // already visible via the broken-read report surface.
        const rows = upstreamStaleness({
          artifact,
          consumes: [], // compiled edges excluded (see comment above)
          provenance: provenanceResult.value,
          declaredUnits: doc.frontmatter.sources,
          earned: earnedByArtifact.get(artifact) ?? [],
          verdicts: verdictsResult.value,
        });

        for (const row of rows) {
          if (row.staleness !== "pending-broken") continue;

          const target: Tier2Target = {
            kind: "tier2",
            artifact,
            unit: row.unit,
            edgeClass: row.edge_class,
          };
          const identity_key = deriveIdentity("staleness", "edge-staleness", target);
          const evidence: Record<string, unknown> = {
            staleness: row.staleness,
            changed_fields: row.changed_fields,
            baseline: row.baseline,
            reason: row.reason,
          };
          const fp = fingerprint(evidence);

          findings.push({
            identity_key,
            source: "staleness",
            check: "edge-staleness",
            target,
            fingerprint: fp,
            certainty: "medium",
            evidence,
            suggested_action: `Review ${row.unit} — upstream change may have broken ${artifact}`,
            verify_predicate: `staleness:edge-staleness artifact=${artifact} unit=${row.unit} class=${row.edge_class}`,
            owner: "",
            first_seen: nowIso,
            last_seen: nowIso,
            disposition: "new",
            history: [],
          });
        }
      }

      return findings;
    } finally {
      db?.close();
    }
  },

  identityOf(raw: Finding): string {
    return deriveIdentity("staleness", raw.check, raw.target, raw.discriminator);
  },

  fingerprintOf(raw: Finding): string {
    return fingerprint(raw.evidence);
  },

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
