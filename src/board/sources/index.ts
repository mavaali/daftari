// index.ts — U5/U6: Source adapter registry.
//
// SOURCE_ADAPTERS is the ordered registry array of FindingSourceAdapter that
// the board engine iterates. Each unit that adds a new source adapter appends
// to this array. The engine is source-agnostic: it calls list/identityOf/
// fingerprintOf/reproduces on each adapter without knowing which source it is.
//
// resolveAdapterForIdentity (C1): identity-key-based adapter lookup for U11.
//   A source→adapter map cannot work when two adapters share the same source
//   ("staleness") — ttlStalenessAdapter and edgeStalenessAdapter both emit
//   source:"staleness" but produce distinct identity_key namespaces. A map
//   keyed by source is therefore ambiguous and cannot disambiguate.
//   Instead, resolveAdapterForIdentity iterates SOURCE_ADAPTERS and returns
//   the first adapter whose reproduces() returns true for the given
//   identity_key. Because identity_keys are namespaced by (source, check,
//   target) in the hash, a given identity_key can be produced by at most ONE
//   adapter — this lookup is unambiguous. U11's resolve tool uses this.
//
// Ordering:
//   Lint first — the most structurally certain source (tier-0 checks are
//   certain failures). Then staleness adapters (U6): TTL staleness and edge
//   staleness. Later units append tension, staged, tier2.

import type { AccessContext, FindingSourceAdapter } from "../types.js";
import { lintAdapter } from "./lint.js";
import { stagedAdapter } from "./staged.js";
import { edgeStalenessAdapter, ttlStalenessAdapter } from "./staleness.js";
import { tensionAdapter } from "./tension.js";
import { tier2QueueAdapter } from "./tier2.js";

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
  stagedAdapter,
  tier2QueueAdapter,
  tensionAdapter,
];

/**
 * Resolve the adapter that produced a given identity_key, by asking each
 * adapter whether it reproduces that key. Returns the first adapter that does,
 * or null if no adapter recognises the key.
 *
 * Rationale: SOURCE_ADAPTER_MAP (keyed by FindingSource) cannot disambiguate
 * two adapters that share the same source string (e.g. "staleness") — both
 * ttlStalenessAdapter and edgeStalenessAdapter emit source:"staleness". An
 * identity_key, by contrast, is namespaced by (source, check, target) in the
 * hash, so a given key can be produced by at most ONE adapter. This lookup is
 * therefore unambiguous. Used by U11's dispose/resolve tool.
 */
export async function resolveAdapterForIdentity(
  identity_key: string,
  vaultRoot: string,
  access: AccessContext,
  now?: Date,
): Promise<FindingSourceAdapter | null> {
  for (const adapter of SOURCE_ADAPTERS) {
    if (await adapter.reproduces(identity_key, vaultRoot, access, now)) {
      return adapter;
    }
  }
  return null;
}
