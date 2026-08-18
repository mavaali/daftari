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
//   certain failures). Later units append staleness, tension, staged, tier2.

import type { FindingSource, FindingSourceAdapter } from "../types.js";
import { lintAdapter } from "./lint.js";

/**
 * Ordered registry of all active FindingSourceAdapters.
 * The board's reconciler iterates this array to collect findings from every
 * detection surface (R22). Order controls which source's findings appear first
 * in a reconcile run's raw list; the reconciler then sorts/deduplicates.
 *
 * To add a new source adapter: import it here and append it to this array.
 */
export const SOURCE_ADAPTERS: FindingSourceAdapter[] = [lintAdapter];

/**
 * Map from FindingSource name to its adapter, for O(1) lookup.
 * Used by the dispose tool (U11) to resolve which adapter handles a given
 * finding's source when verifying or reproducing it.
 */
export const SOURCE_ADAPTER_MAP = new Map<FindingSource, FindingSourceAdapter>([
  ["lint", lintAdapter],
]);
