// corpus — assemble the daftari arm's vault. Each clause VERSION becomes its own
// markdown doc so daftari's document-level `superseded_by` edge becomes
// clause-scoped: clause-X@master --superseded_by--> clause-X@amendment-1 --> ...
// The governing (latest) version terminates the chain and is therefore the
// current source that `resolveCurrentSource` resolves to.

import type { ChainDoc, ClauseResolution } from "./clause-edge.js";
import { extractValue } from "./qa-build.js";

export interface CorpusDoc {
  path: string;
  frontmatter: {
    title: string;
    clause: string;
    source: string;
    superseded_by?: string;
  };
  body: string;
}

function clausePath(clause: string, docId: string): string {
  // Sanitize term names ("Applicable Margin") into path-safe slugs; Section ids
  // ("4.2") are unchanged since they carry no whitespace or illegal characters.
  const slug = clause.trim().replace(/\s+/g, "-").replace(/[/\\:*?"<>|]/g, "");
  return `clause-${slug}/${docId}.md`;
}

export function buildCorpus(docs: ChainDoc[], resolutions: ClauseResolution[]): CorpusDoc[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const out: CorpusDoc[] = [];
  for (const r of resolutions) {
    r.history.forEach((docId, i) => {
      const src = byId.get(docId);
      const nextId = r.history[i + 1];
      const frontmatter: CorpusDoc["frontmatter"] = {
        title: `Section ${r.clause} (${docId})`,
        clause: r.clause,
        source: docId,
      };
      if (nextId) frontmatter.superseded_by = clausePath(r.clause, nextId);
      out.push({
        path: clausePath(r.clause, docId),
        frontmatter,
        body: src ? extractValue(src.text, r.clause) : "",
      });
    });
  }
  return out;
}
