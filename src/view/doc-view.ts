// The doc-view DTO — the JSON data contract behind a document page. Both the
// server-rendered HTML page and the `/api/doc/<path>` endpoint read this one
// shape, and a future client app would consume the same JSON: rendering is a
// presentation concern kept OUT of the DTO (it carries raw markdown `content`,
// not HTML), so the viewer can evolve from server-rendered to client-rendered
// without changing the contract.
//
// The DTO is pure reuse: the epistemic reports are exactly what `vault_read`
// already computes (decay, validity, upstream staleness, structural decay,
// anchors, contested); backlinks come from the same reverse maps the rest of
// the viewer uses. Nothing here recomputes knowledge state.

import { buildReverseLinkMap, buildReverseSourceMap } from "../curation/tension-blast.js";
import { loadDocuments } from "../curation/vault-docs.js";
import type { Frontmatter } from "../frontmatter/types.js";
import { ok, type Result } from "../frontmatter/types.js";
import { canonicalVaultRelPath } from "../storage/local.js";
import { type VaultReadResult, vaultRead } from "../tools/read.js";

export interface DocBacklinkRef {
  doc: string;
  via: "source" | "link";
}

export interface DocView {
  path: string;
  frontmatter: Frontmatter;
  content: string; // raw markdown — presentation renders it, the DTO does not
  // Epistemic reports, verbatim from vault_read (null-when-silent contract).
  decay: VaultReadResult["decay"];
  validity: VaultReadResult["validity"];
  upstream_staleness: VaultReadResult["upstream_staleness"];
  structural: VaultReadResult["structural"];
  anchors: VaultReadResult["anchors"];
  contested: NonNullable<VaultReadResult["contested"]>;
  backlinks: DocBacklinkRef[];
}

// Build the DTO for one document, or null if the path resolves to no vault doc.
export async function buildDocView(
  vaultRoot: string,
  target: string,
): Promise<Result<DocView | null, Error>> {
  const loaded = await loadDocuments(vaultRoot);
  if (!loaded.ok) return loaded;
  const docs = loaded.value;

  const canon = canonicalVaultRelPath(vaultRoot, target);
  const path = canon.ok ? canon.value : target;
  const doc = docs.find((d) => d.path === path);
  if (!doc) return ok(null);

  const read = await vaultRead(vaultRoot, path);
  if (!read.ok) return read;
  const r = read.value;

  const reverseSource = buildReverseSourceMap(docs);
  const reverseLink = buildReverseLinkMap(docs);
  const backlinks: DocBacklinkRef[] = [];
  for (const b of reverseSource.get(path) ?? []) backlinks.push({ doc: b, via: "source" });
  for (const b of reverseLink.get(path) ?? []) backlinks.push({ doc: b, via: "link" });
  backlinks.sort((a, b) => a.doc.localeCompare(b.doc) || a.via.localeCompare(b.via));

  return ok({
    path,
    frontmatter: r.frontmatter,
    content: r.content,
    decay: r.decay,
    validity: r.validity,
    upstream_staleness: r.upstream_staleness,
    structural: r.structural,
    anchors: r.anchors,
    contested: r.contested ?? [],
    backlinks,
  });
}
