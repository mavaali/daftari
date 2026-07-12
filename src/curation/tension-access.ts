// tension-access — the single visibility rule for tension entries (#212).
//
// A tension quotes claims from two documents; seeing either half crosses the
// ACL boundary of the other. Rule (matching the #211 contested-annotation
// gate): a caller may see an entry only with read access to BOTH sides'
// collections. Invisible entries are omitted entirely — never redacted — so
// neither existence nor authorship context leaks.
//
// This module holds policy only. Curation computations (clusters, blast)
// take the filter by injection so they never import RBAC or the index.

import { type AccessContext, canRead } from "../access/rbac.js";
import { canonicalRel } from "../search/contested.js";
import { collectionForPath, type IndexDb } from "../storage/index-db.js";
import type { TensionEntry } from "./tension.js";

// True iff the caller may see a tension between these two sources. Sides are
// canonicalized before resolution — an alias must not widen visibility. A
// side that canonicalizes to blank or escapes the root (`..`-leading) is
// visible to no role: such a path can never be a readable vault document.
// `access` undefined ⇒ RBAC unconfigured ⇒ visible, matching every other
// read surface. `db` null ⇒ index unavailable ⇒ pure first-segment rule
// (fail-closed; never fails the caller).
export function canSeeTension(
  db: IndexDb | null,
  access: AccessContext | undefined,
  sourceA: string,
  sourceB: string,
): boolean {
  if (!access) return true;
  return sideReadable(db, access, sourceA) && sideReadable(db, access, sourceB);
}

function sideReadable(db: IndexDb | null, access: AccessContext, source: string): boolean {
  const canonical = canonicalRel(source);
  if (canonical.length === 0 || canonical.startsWith("..")) return false;
  return canRead(access.role, collectionForPath(db, canonical));
}

// The subset of `entries` visible to the caller, original order preserved.
export function visibleTensions(
  db: IndexDb | null,
  entries: TensionEntry[],
  access?: AccessContext,
): TensionEntry[] {
  if (!access) return entries;
  return entries.filter((e) => canSeeTension(db, access, e.sourceA, e.sourceB));
}
