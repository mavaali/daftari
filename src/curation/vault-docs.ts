// Shared vault-document loading and in-vault link helpers.
//
// Extracted from lint.ts so the same loader and link-resolution machinery can
// back any curation surface that needs the full set of vault docs plus a
// reverse-link view (lint, tension blast radius). Keeps the link-extraction
// regexes and the path-normalisation rules in one place so the two callers
// can't drift apart.

import { posix } from "node:path";
import { parseDocument } from "../frontmatter/parser.js";
import { type Frontmatter, ok, type Result, type ValidationReport } from "../frontmatter/types.js";
import { listFiles, readFile, resolveVaultPath } from "../storage/local.js";

export interface LoadedDoc {
  path: string;
  frontmatter: Frontmatter;
  content: string;
  // The schema-validation report from the SAME parse pass that produced
  // `frontmatter`. Carried so downstream consumers (e.g. the consolidate
  // envelope's provenance check) can tell schema-valid from schema-invalid
  // frontmatter without re-reading or re-parsing the file. `content` is the
  // body only (frontmatter stripped), so validation cannot be recovered from
  // it alone — that is why we surface it here.
  validation: ValidationReport;
}

// Loads every markdown file under the vault root, returning frontmatter +
// body for each. Files that fail to parse or to read are silently skipped —
// the curation surface should never crash because a single file is malformed.
export async function loadDocuments(vaultRoot: string): Promise<Result<LoadedDoc[], Error>> {
  const list = await listFiles(vaultRoot);
  if (!list.ok) return list;

  const docs: LoadedDoc[] = [];
  for (const relPath of list.value) {
    const resolved = resolveVaultPath(vaultRoot, relPath);
    if (!resolved.ok) continue;
    const file = await readFile(resolved.value.absPath);
    if (!file.ok) continue;
    const parsed = parseDocument(file.value);
    if (!parsed.ok) continue;
    docs.push({
      path: relPath,
      frontmatter: parsed.value.frontmatter,
      content: parsed.value.content,
      validation: parsed.value.validation,
    });
  }
  return ok(docs);
}

// Pulls every internal link target out of a markdown body: both [[wikilinks]]
// and [text](target) markdown links. External URLs and anchors are dropped.
export function extractLinks(content: string): string[] {
  const targets: string[] = [];

  for (const m of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
    // A wikilink may carry a |display alias and/or a #heading anchor.
    const raw = (m[1] as string).split("|")[0]?.split("#")[0]?.trim();
    if (raw) targets.push(raw);
  }

  for (const m of content.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = (m[1] as string).split("#")[0]?.trim();
    if (!raw) continue;
    if (/^(https?:|mailto:|#)/i.test(raw)) continue;
    targets.push(raw);
  }

  return targets;
}

// Resolves a raw link target to a vault-relative path, or null if it points
// nowhere. Tries, in order: the target as-is, with a .md suffix, resolved
// relative to the linking file's directory, then a bare basename match (the
// common [[note-name]] wikilink form).
export function resolveLink(
  rawTarget: string,
  fromPath: string,
  byPath: Set<string>,
  byBasename: Map<string, string>,
): string | null {
  const withMd = (p: string) => (p.endsWith(".md") ? p : `${p}.md`);

  if (byPath.has(rawTarget)) return rawTarget;
  if (byPath.has(withMd(rawTarget))) return withMd(rawTarget);

  const relual = posix.normalize(posix.join(posix.dirname(fromPath), rawTarget));
  if (byPath.has(relual)) return relual;
  if (byPath.has(withMd(relual))) return withMd(relual);

  const base = posix.basename(rawTarget).replace(/\.md$/, "");
  return byBasename.get(base) ?? null;
}

// Precomputes the two indexes resolveLink consults: the set of every known
// vault-relative path, and the basename → path map used for bare-name
// wikilinks. First write wins on basename collisions so the mapping is
// deterministic across runs.
export function buildPathIndexes(docs: LoadedDoc[]): {
  byPath: Set<string>;
  byBasename: Map<string, string>;
} {
  const byPath = new Set(docs.map((d) => d.path));
  const byBasename = new Map<string, string>();
  for (const d of docs) {
    const base = posix.basename(d.path).replace(/\.md$/, "");
    if (!byBasename.has(base)) byBasename.set(base, d.path);
  }
  return { byPath, byBasename };
}
