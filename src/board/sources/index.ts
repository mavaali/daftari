// index.ts — U5: Source adapter registry.
//
// SOURCE_ADAPTERS is the ordered registry array of FindingSourceAdapter that
// the board engine iterates. Each unit that adds a new source adapter appends
// to this array. The engine is source-agnostic: it calls list/identityOf/
// fingerprintOf/reproduces on each adapter without knowing which source it is.
//
// SOURCE_ADAPTER_MAP provides O(1) lookup by FindingSource name, for the U11
// dispose tool's resolve path (and any other caller that needs adapter-by-name).
//
// Ordering:
//   Lint first — the most structurally certain source (tier-0 checks are
//   certain failures). Then staleness adapters (U6): TTL staleness and edge
//   staleness. Later units append tension, staged, tier2.
//
// MAP key notes (U6):
//   "staleness" → ttlStalenessAdapter  (TTL-decay findings; StalenessTarget)
//   "tier2"     → edgeStalenessAdapter (edge-staleness findings; Tier2Target)
//   Both adapters emit source:"staleness" but are distinguished by their
//   check name ("ttl-staleness" vs "edge-staleness") and target kind
//   ("staleness" vs "tier2"). The dispose tool (U11) will use the map key
//   that matches a finding's target.kind for adapter resolution — this
//   assignment is intentional and documented here for U11.

import type { FindingSource, FindingSourceAdapter } from "../types.js";
import { lintAdapter } from "./lint.js";
import { edgeStalenessAdapter, ttlStalenessAdapter } from "./staleness.js";

/**
 * Ordered registry of all active FindingSourceAdapters.
 * The board's reconciler iterates this array to collect findings from every
 * detection surface (R22). Order controls which source's findings appear first
 * in a reconcile run's raw list; the reconciler then sorts/deduplicates.
 *
 * To add a new source adapter: import it here and append it to this array.
 */
export const SOURCE_ADAPTERS: FindingSourceAdapter[] = [
  lintAdapter,
  ttlStalenessAdapter,
  edgeStalenessAdapter,
];

/**
 * Map from FindingSource name to its adapter, for O(1) lookup.
 * Used by the dispose tool (U11) to resolve which adapter handles a given
 * finding's source when verifying or reproducing it.
 */
export const SOURCE_ADAPTER_MAP = new Map<FindingSource, FindingSourceAdapter>([
  ["lint", lintAdapter],
  ["staleness", ttlStalenessAdapter],
  ["tier2", edgeStalenessAdapter],
]);
