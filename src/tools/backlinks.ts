// vault_backlinks — the reverse of the knowledge graph. Given a target, list
// the documents that reference it. Two facets, inferred from the target:
//   - doc facet:  a vault-relative doc path → docs that cite it in `sources`
//     ('source' edge) or link to it in their body ('link' edge). Computed from
//     the same reverse maps blast-radius already builds, so the two cannot
//     drift.
//   - code facet: a repo code path (optionally `repo:path`) → docs whose
//     `describes` frontmatter binds that file. Inverts the describes edges.
//
// Read-only, no mutation. RBAC mirrors vault_consumes: gate on any-read, then
// omit any referencing document the caller cannot read (plain omission, never
// redaction, never counted). A target that matches nothing returns an empty
// listing — identical to an unreadable or nonexistent one, no existence
// disclosure.

import { type AccessContext, hasAnyRead } from "../access/rbac.js";
import { parseDescribesEntry } from "../audit/describes.js";
import { sourceReadable } from "../curation/tension-access.js";
import { buildReverseLinkMap, buildReverseSourceMap } from "../curation/tension-blast.js";
import { loadDocuments } from "../curation/vault-docs.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { canonicalVaultRelPath } from "../storage/local.js";
import type { ToolDefinition } from "./read.js";
import { openIndexForAccessOrNull } from "./search.js";

export type BacklinkKind = "doc" | "code";

// One doc-facet backlink: a document that references the target doc, and how.
export interface DocBacklink {
  doc: string;
  via: "source" | "link";
}

// One code-facet backlink: a document whose `describes` binds the target file.
export interface CodeBacklink {
  doc: string;
  raw: string; // the describes entry as written
  repo: string; // resolved repo (the source doc's repo for a bare entry)
  path: string; // repo-relative code path the entry resolved to
  pin?: { start: number | null; end: number | null; sha: string };
}

export interface BacklinksResult {
  target: string;
  kind: BacklinkKind;
  references: (DocBacklink | CodeBacklink)[];
  total: number;
}

// Split an optional `repo:` prefix off a code target. A path with no single
// leading colon segment resolves repo to null (match on path alone).
function splitCodeTarget(raw: string): { repo: string | null; path: string } {
  const colon = raw.indexOf(":");
  if (colon === -1) return { repo: null, path: raw.trim() };
  return { repo: raw.slice(0, colon).trim(), path: raw.slice(colon + 1).trim() };
}

export async function vaultBacklinks(
  vaultRoot: string,
  args: Record<string, unknown>,
  access?: AccessContext,
): Promise<Result<BacklinksResult, Error>> {
  if (access && !hasAnyRead(access.role)) {
    return err(new Error(`access denied: role '${access.roleName}' cannot use vault_backlinks`));
  }

  const targetRaw = args.target;
  if (typeof targetRaw !== "string" || targetRaw.trim().length === 0) {
    return err(new Error("vault_backlinks requires 'target' as a non-empty string"));
  }
  const target = targetRaw.trim();

  let kind: BacklinkKind | undefined;
  if (args.kind !== undefined && args.kind !== null) {
    if (args.kind !== "doc" && args.kind !== "code") {
      return err(new Error("vault_backlinks 'kind' must be 'doc' or 'code'"));
    }
    kind = args.kind;
  }

  const loaded = await loadDocuments(vaultRoot);
  if (!loaded.ok) return loaded;
  const docs = loaded.value;
  const docPaths = new Set(docs.map((d) => d.path));

  // Infer the facet when not overridden: a target that resolves to an existing
  // vault document is the doc facet; anything else is a code path.
  let canonicalTarget = target;
  if (kind === undefined) {
    const canon = canonicalVaultRelPath(vaultRoot, target);
    if (canon.ok && docPaths.has(canon.value)) {
      kind = "doc";
      canonicalTarget = canon.value;
    } else {
      kind = "code";
    }
  } else if (kind === "doc") {
    const canon = canonicalVaultRelPath(vaultRoot, target);
    if (canon.ok) canonicalTarget = canon.value;
  }

  const db = access ? openIndexForAccessOrNull(vaultRoot) : null;
  const readable = (docPath: string): boolean => !access || sourceReadable(db, access, docPath);

  try {
    if (kind === "doc") {
      const reverseSource = buildReverseSourceMap(docs);
      const reverseLink = buildReverseLinkMap(docs);
      const references: DocBacklink[] = [];
      for (const doc of reverseSource.get(canonicalTarget) ?? []) {
        if (readable(doc)) references.push({ doc, via: "source" });
      }
      for (const doc of reverseLink.get(canonicalTarget) ?? []) {
        if (readable(doc)) references.push({ doc, via: "link" });
      }
      references.sort((a, b) => a.doc.localeCompare(b.doc) || a.via.localeCompare(b.via));
      return ok({ target: canonicalTarget, kind, references, total: references.length });
    }

    // code facet
    const { repo: wantRepo, path: wantPath } = splitCodeTarget(target);
    const references: CodeBacklink[] = [];
    for (const d of docs) {
      if (!readable(d.path)) continue;
      for (const raw of d.frontmatter.describes ?? []) {
        // sourceRepo is a config concept absent from a pure vault query; a bare
        // entry keeps repo === "" and is matched on path alone.
        const parsed = parseDescribesEntry(raw, "");
        if (parsed.path.length === 0 || parsed.path !== wantPath) continue;
        if (wantRepo !== null && parsed.repo !== wantRepo) continue;
        references.push({
          doc: d.path,
          raw,
          repo: parsed.repo,
          path: parsed.path,
          ...(parsed.pin ? { pin: parsed.pin } : {}),
        });
      }
    }
    references.sort((a, b) => a.doc.localeCompare(b.doc) || a.raw.localeCompare(b.raw));
    return ok({ target, kind, references, total: references.length });
  } finally {
    db?.close();
  }
}

const docBacklinkSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    doc: { type: "string", description: "Vault-relative path of the referencing document" },
    via: {
      type: "string",
      enum: ["source", "link"],
      description: "'source': cited in frontmatter sources; 'link': linked in the body",
    },
  },
  required: ["doc", "via"],
};

const codeBacklinkSchema: Record<string, unknown> = {
  type: "object",
  properties: {
    doc: {
      type: "string",
      description: "Vault-relative path of the document that describes the file",
    },
    raw: { type: "string", description: "The describes entry exactly as written" },
    repo: {
      type: "string",
      description: "Resolved repo name (empty for a bare, unqualified entry)",
    },
    path: { type: "string", description: "Repo-relative code path the entry resolved to" },
    pin: {
      type: "object",
      description: "JIT anchor pin, present only when the entry carried a well-formed pin suffix",
      properties: {
        start: { type: ["integer", "null"] },
        end: { type: ["integer", "null"] },
        sha: { type: "string" },
      },
      required: ["start", "end", "sha"],
    },
  },
  required: ["doc", "raw", "repo", "path"],
};

export const backlinksTools: ToolDefinition[] = [
  {
    name: "vault_backlinks",
    title: "List documents that reference a target",
    annotations: { readOnlyHint: true },
    description:
      "The reverse of the knowledge graph: given a target, list the documents " +
      "that reference it. The facet is inferred from the target (override with " +
      "'kind'). A vault-relative DOC path returns docs that cite it in their " +
      "'sources' ('source' edge) or link to it in their body ('link' edge). A " +
      "repo CODE path (optionally 'repo:path') returns docs whose 'describes' " +
      "frontmatter binds that file — 'which beliefs touch this file'. Read-only; " +
      "an unreadable referencing document is omitted from the list and the count.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "A vault-relative doc path, or a repo code path (optionally 'repo:path')",
        },
        kind: {
          type: "string",
          enum: ["doc", "code"],
          description:
            "Override the inferred facet: 'doc' (vault doc target) or 'code' (code file)",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "The resolved target (canonicalized for the doc facet)",
        },
        kind: { type: "string", enum: ["doc", "code"], description: "Which facet ran" },
        references: {
          type: "array",
          items: { anyOf: [docBacklinkSchema, codeBacklinkSchema] },
        },
        total: {
          type: "integer",
          description:
            "Number of listed references. An unreadable referencing document is " +
            "omitted from the list AND from this count (plain omission).",
        },
      },
      required: ["target", "kind", "references", "total"],
    },
    handler: (vaultRoot, args, access) => vaultBacklinks(vaultRoot, args, access),
  },
];
