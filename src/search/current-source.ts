//
// resolveCurrentSource — follow a document's `superseded_by` chain to the
// terminal-current source, for inline foregrounding in search results.
//
// daftari authors the RELATION (points at the current source), never the
// VALUE (the snippet is read verbatim from the successor's indexed content).
// Pure over the index; never throws. Returns null when the document is not
// superseded (nothing to foreground).

import { type AccessContext, canRead } from "../access/rbac.js";
import { getDocument, type IndexDb } from "../storage/index-db.js";

// A leading preview of the successor's body — the successor did not
// necessarily match the query, so there are no query terms to centre on.
// Mirrors hybrid.ts's no-hit snippet (collapse whitespace, cap length).
const PREVIEW_MAX = 280;
function previewSnippet(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();
  return collapsed.length > PREVIEW_MAX ? `${collapsed.slice(0, PREVIEW_MAX)}…` : collapsed;
}

export type CurrentSource =
  | { kind: "resolved"; path: string; title: string; snippet: string; hops: number }
  | { kind: "restricted" }
  | { kind: "dangling"; brokenAt: string }
  | { kind: "cycle" };

export function resolveCurrentSource(
  db: IndexDb,
  stalePath: string,
  access?: AccessContext,
): CurrentSource | null {
  let doc = getDocument(db, stalePath);
  if (!doc || doc.supersededBy === null) return null; // not superseded — nothing to foreground

  const visited = new Set<string>([doc.path]);
  let hops = 0;

  while (doc.supersededBy !== null) {
    const nextPath = doc.supersededBy;
    hops += 1;
    if (visited.has(nextPath)) return { kind: "cycle" };
    visited.add(nextPath);

    const nextDoc = getDocument(db, nextPath);
    if (!nextDoc) return { kind: "dangling", brokenAt: doc.path };

    // RBAC (strict): any unreadable hop, including the terminal head, degrades
    // to a path-free marker. `access` undefined ⇒ RBAC unconfigured ⇒ readable.
    if (access && !canRead(access.role, nextDoc.collection)) return { kind: "restricted" };

    doc = nextDoc;
  }

  return {
    kind: "resolved",
    path: doc.path,
    title: doc.title,
    snippet: previewSnippet(doc.content),
    hops,
  };
}
