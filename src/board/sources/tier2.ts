// tier2.ts — U7: Tier-2 queue source adapter.
//
// Wraps the tier-2 residual queue (pending-unchecked rows with no covering
// verdict) from src/tools/tier2.ts and maps each residual to a Finding.
//
// Identity: HASH-PATH via tuple (artifact, unit, edgeClass).
//   target = { kind:"tier2", artifact, unit, edgeClass }
//   identity_key = deriveIdentity("tier2", "pending-unchecked", target)
//   This is the hash-path (not native-id), so source+check ARE included.
//   The key is DISJOINT from edge-staleness keys:
//     edge-staleness:  source="staleness", check="edge-staleness"
//     tier2-queue:     source="tier2",     check="pending-unchecked"
//   Same Tier2Target shape, different source+check → different hash → no collision.
//
// RBAC: BOTH artifact AND unit must be readable (matching vaultTier2Queue).
//   A finding names two endpoints; if either is in a denied collection the
//   entire finding is omitted. This prevents upstream existence disclosure:
//   the unit path appears in the finding's target and evidence, so surfacing
//   it when the unit's collection is denied would reveal that the unit exists.
//   Uses sourceReadable(db, access, path) from src/curation/tension-access.ts
//   for both endpoints — the same primitive vaultTier2Queue uses.
//
// Dependency injection for testability (mirrors makeEdgeStalenessAdapter in U6):
//   makeTier2QueueAdapter(fn) creates an adapter that calls
//   `fn(vaultRoot)` → Tier2WorkItem[] instead of the real loading path.
//   Tests inject a pre-canned function to drive mapping logic without a full
//   graph fixture. The production export `tier2QueueAdapter` uses the real
//   loadQueueSources + residualRows path (same inputs as U6's edge-staleness).
//
// reproduces: true iff the (artifact, unit, edgeClass) triple is still
//   pending-unchecked with no covering verdict in the current live set.

import type { AccessContext } from "../../access/rbac.js";
import { upstreamStaleness } from "../../curation/edge-staleness.js";
import { listEdges } from "../../curation/edges.js";
import { readProvenanceLog } from "../../curation/provenance.js";
import { sourceReadable, sourceVerifiable } from "../../curation/tension-access.js";
import { readTier2Verdicts } from "../../curation/tier2.js";
import { loadDocuments } from "../../curation/vault-docs.js";
import { openIndexForAccessOrNull } from "../../tools/search.js";
import type { Tier2WorkItem } from "../../tools/tier2.js";
import { deriveIdentity, fingerprint } from "../identity.js";
import type { Finding, FindingSourceAdapter, Tier2Target } from "../types.js";

// The single check name for tier-2-queue findings. Stable — never change this
// after ledger entries are written. Deliberately differs from edge-staleness's
// "edge-staleness" check so identity keys are disjoint even though both adapters
// use Tier2Target { kind:"tier2", ... }.
const TIER2_CHECK = "pending-unchecked";

// ---------------------------------------------------------------------------
// buildTier2Finding — pure mapping helper shared by injected and production paths
// ---------------------------------------------------------------------------

function buildTier2Finding(item: Tier2WorkItem, nowIso: string): Finding {
  const target: Tier2Target = {
    kind: "tier2",
    artifact: item.artifact,
    unit: item.unit,
    edgeClass: item.edge_class,
  };
  const identity_key = deriveIdentity("tier2", TIER2_CHECK, target);

  // Fingerprint covers volatile fields: question, changed_fields, baseline can
  // change when a new upstream write alters the change set or question text.
  const evidence: Record<string, unknown> = {
    edge_class: item.edge_class,
    changed_fields: item.changed_fields,
    baseline: item.baseline,
    question: item.question,
  };
  const fp = fingerprint(evidence);

  return {
    identity_key,
    source: "tier2",
    check: TIER2_CHECK,
    target,
    fingerprint: fp,
    certainty: "medium",
    evidence,
    suggested_action: `Review tier-2 compatibility: ${item.artifact} depends on ${item.unit} via ${item.edge_class} edge`,
    verify_predicate: `tier2:${TIER2_CHECK} artifact=${item.artifact} unit=${item.unit} class=${item.edge_class}`,
    owner: "",
    first_seen: nowIso,
    last_seen: nowIso,
    disposition: "new",
    history: [],
  };
}

// ---------------------------------------------------------------------------
// Type of the injectable items function
// ---------------------------------------------------------------------------

type Tier2ItemsFn = (vaultRoot: string) => Promise<Tier2WorkItem[]>;

// ---------------------------------------------------------------------------
// makeTier2QueueAdapter — factory for testability
// ---------------------------------------------------------------------------

/**
 * makeTier2QueueAdapter — factory for testability.
 *
 * In tests, inject a function that returns pre-canned Tier2WorkItem rows.
 * In production, use the real loading path via `tier2QueueAdapter`.
 *
 * RBAC requires BOTH artifact AND unit readable (matching vaultTier2Queue),
 * because the finding names the unit and must not disclose an unreadable
 * upstream. Uses sourceReadable() from tension-access.ts for both endpoints.
 */
export function makeTier2QueueAdapter(itemsFn: Tier2ItemsFn): FindingSourceAdapter {
  return {
    async list(vaultRoot: string, access: AccessContext, now?: Date): Promise<Finding[]> {
      const nowDate = now ?? new Date();
      const nowIso = nowDate.toISOString();

      const items = await itemsFn(vaultRoot);

      const db = openIndexForAccessOrNull(vaultRoot);
      try {
        const findings: Finding[] = [];

        for (const item of items) {
          // RBAC: BOTH artifact AND unit must be readable.
          // The finding names the unit path; surfacing it when the unit's
          // collection is denied would disclose the existence of an unreadable
          // upstream. Matches vaultTier2Queue's both-endpoints-readable policy.
          if (!sourceReadable(db, access, item.artifact)) continue;
          if (!sourceReadable(db, access, item.unit)) continue;

          findings.push(buildTier2Finding(item, nowIso));
        }

        return findings;
      } finally {
        db?.close();
      }
    },

    identityOf(raw: Finding): string {
      return deriveIdentity("tier2", raw.check, raw.target, raw.discriminator);
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

// ---------------------------------------------------------------------------
// Production tier-2 queue adapter
//
// Loads provenance, verdicts, docs, and earned edges — the same inputs that
// tools/tier2.ts:loadQueueSources assembles — then calls upstreamStaleness and
// filters to pending-unchecked rows (residualRows in tools/tier2.ts). Mirrors
// the production wiring from edgeStalenessAdapter in staleness.ts (U6).
//
// isVerifiable is intentionally NOT applied here: the tier-2 queue is about
// pending-unchecked rows regardless of whether the unit is verifiable. The
// residual queue includes units that exist but haven't been checked yet; we
// want to surface ALL pending-unchecked pairs. (This differs from
// edgeStalenessAdapter which uses isVerifiable to classify absent units as
// "unverifiable" rather than surfacing them as edge-staleness findings.)
// ---------------------------------------------------------------------------

export const tier2QueueAdapter: FindingSourceAdapter = {
  async list(vaultRoot: string, access: AccessContext, now?: Date): Promise<Finding[]> {
    const nowDate = now ?? new Date();
    const nowIso = nowDate.toISOString();

    // Load all sources needed for upstreamStaleness (mirrors loadQueueSources).
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

        // RBAC: BOTH artifact AND unit must be readable (matching vaultTier2Queue).
        // The finding names the unit; if the unit's collection is denied the
        // finding is omitted to prevent upstream existence disclosure.
        if (!sourceReadable(db, access, artifact)) continue;

        // Compute upstream staleness for this artifact (compiled edges excluded
        // via consumes:[] — same as tools/tier2.ts:residualRows).
        const rows = upstreamStaleness({
          artifact,
          consumes: [],
          provenance: provenanceResult.value,
          declaredUnits: doc.frontmatter.sources,
          earned: earnedByArtifact.get(artifact) ?? [],
          verdicts: verdictsResult.value,
          // No isVerifiable for the tier-2 queue — we want to surface all
          // pending-unchecked pairs regardless of verifiability.
        });

        // Only pending-unchecked rows go on the tier-2 board (residual queue).
        for (const row of rows) {
          if (row.staleness !== "pending-unchecked") continue;

          // RBAC: unit must also be readable before we name it in the finding.
          if (!sourceReadable(db, access, row.unit)) continue;

          const item: Tier2WorkItem = {
            artifact,
            unit: row.unit,
            edge_class: row.edge_class as Exclude<"compiled", string>,
            baseline: row.baseline,
            changed_fields: row.changed_fields,
            field_changes: {},
            usage_span: null,
            question: `${row.unit} has pending-unchecked changes affecting ${artifact} via ${row.edge_class} edge.`,
          };

          findings.push(buildTier2Finding(item, nowIso));
        }
      }

      return findings;
    } finally {
      db?.close();
    }
  },

  identityOf(raw: Finding): string {
    return deriveIdentity("tier2", raw.check, raw.target, raw.discriminator);
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
