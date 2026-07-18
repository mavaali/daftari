// Structural decay (#8) — the graph-shaped half of inline decay surfacing.
//
// #2 shipped TEMPORAL decay inline (TTL, old drafts, stagnant confidence):
// arithmetic over the document's own frontmatter, free at read time. The
// structural signals deliberately left out — orphanhood and
// deprecated-still-linked — need the whole-vault inbound-link graph, which
// is exactly what a read must NOT recompute per query. That graph is now
// materialized into the ephemeral index at (re)index time (index-db.ts
// doc_links, fed by the same extraction/resolution lint uses), so this
// module answers from one indexed query.
//
// Advisory, the decay banner's contract: reported on reads and search hits,
// never blocking, never auto-fixed. Unresolved tensions — the third signal
// #8 names — ride the existing contested channel (search has carried it
// inline since the feud benchmark; vault_read gains parity in tools/read.ts)
// rather than a second tension surface here.
//
// RBAC follows lint's vantage rule (#217, the codebase's decided posture for
// exactly this check): invisible docs are excluded from the linker set
// BEFORE the checks run, so a hidden linker neither names itself nor
// silently un-flags an orphan — "orphan" always means "orphan from YOUR
// vantage", and no signal encodes hidden existence.

import type { AccessContext } from "../access/rbac.js";
import { type IndexDb, inboundLinkers } from "../storage/index-db.js";
import { sourceReadable } from "./tension-access.js";

export interface StructuralDecay {
  // No document the caller can read links here.
  orphan: boolean;
  // Set when THIS doc is deprecated and canonical docs still link to it —
  // the "settled docs keep leaning on a retired one" hazard. Linker paths
  // are caller-visible by construction (vantage rule above).
  deprecated_still_linked: { canonical_linkers: string[] } | null;
  banner: string;
}

// Structural decay for one document, or null when there is nothing to say
// (linked, and not a still-linked deprecated doc) — the same null-when-healthy
// contract as temporal decay. `db` may be null (index unavailable): the
// signal is advisory, so it degrades to silence, never to an error.
export function structuralDecay(input: {
  db: IndexDb | null;
  path: string;
  status: string;
  access?: AccessContext;
}): StructuralDecay | null {
  const { db, path, status, access } = input;
  if (db === null) return null;

  let linkers: { path: string; status: string }[];
  try {
    linkers = inboundLinkers(db, path);
  } catch {
    // A pre-doc_links index (not yet rebuilt at the new schema) has no table;
    // advisory means silence, not failure.
    return null;
  }
  const visible = access ? linkers.filter((l) => sourceReadable(db, access, l.path)) : linkers;

  const orphan = visible.length === 0;
  const canonicalLinkers =
    status === "deprecated"
      ? visible.filter((l) => l.status === "canonical").map((l) => l.path)
      : [];
  const deprecatedStillLinked =
    canonicalLinkers.length > 0 ? { canonical_linkers: canonicalLinkers } : null;

  if (!orphan && deprecatedStillLinked === null) return null;

  const notes: string[] = [];
  if (orphan) {
    notes.push("no vault document you can read links here — connect it or consider archiving");
  }
  if (deprecatedStillLinked) {
    notes.push(
      `deprecated but still linked from canonical doc${canonicalLinkers.length === 1 ? "" : "s"}: ` +
        canonicalLinkers.join(", "),
    );
  }
  return {
    orphan,
    deprecated_still_linked: deprecatedStillLinked,
    banner: `Structural decay: ${notes.join("; ")}.`,
  };
}
