// MCP resources — the protocol-level statement that markdown with YAML
// frontmatter is the source of truth (spec 2026-07-26, Decision 2).
//
// A client that speaks resources can pin and re-read a document as a thing
// with an identity, instead of re-running a search and hoping the same text
// comes back. `resources/read` returns the file verbatim, frontmatter
// included — the metadata layer IS part of the document.
//
// The invariant that gates all of it: a resource listing is a doc list, and
// doc lists never name docs in unreadable collections (2026-07-14 spec —
// omission over redaction, no existence leak). An unreadable doc is ABSENT
// from listings, and reading one returns the identical error a nonexistent
// path returns. A distinguishable "forbidden" IS the existence leak.
//
// Tension and edge data deliberately do NOT become resources: they are
// derived, disclosure-coarsened views, and stable URIs would invite clients
// to treat them as documents. They stay behind their tools, where the
// coarsening already lives.

import { type AccessContext, canRead } from "./access/rbac.js";
import { parseDocument } from "./frontmatter/parser.js";
import { err, ok, type Result } from "./frontmatter/types.js";
import { readFile, resolveVaultPath } from "./storage/local.js";
import { collectionOf, vaultIndex } from "./tools/read.js";

export const DOC_URI_PREFIX = "daftari://doc/";
export const COLLECTION_URI_PREFIX = "daftari://collection/";

const MARKDOWN_MIME = "text/markdown";
const JSON_MIME = "application/json";

export interface ResourceDescriptor {
  uri: string;
  name: string;
  mimeType: string;
  description?: string;
}

export interface ResourceTemplateDescriptor {
  uriTemplate: string;
  name: string;
  mimeType: string;
  description?: string;
}

export interface ResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

// Templates are advertised unconditionally: a URI *shape* names no document,
// so publishing it discloses nothing about what the vault holds or what this
// role may see.
export function resourceTemplates(): ResourceTemplateDescriptor[] {
  return [
    {
      uriTemplate: `${DOC_URI_PREFIX}{+path}`,
      name: "Vault document",
      mimeType: MARKDOWN_MIME,
      description:
        "A vault document, verbatim, YAML frontmatter included. " +
        "The path is the vault-relative path, e.g. daftari://doc/notes/pricing.md",
    },
    {
      uriTemplate: `${COLLECTION_URI_PREFIX}{name}`,
      name: "Collection listing",
      mimeType: JSON_MIME,
      description: "The documents in one collection the caller may read.",
    },
  ];
}

export function docUri(relPath: string): string {
  // Encode per segment: the separators stay structural, everything else is
  // escaped so a path with spaces or '#' round-trips.
  return DOC_URI_PREFIX + relPath.split("/").map(encodeURIComponent).join("/");
}

export function collectionUri(name: string): string {
  return COLLECTION_URI_PREFIX + encodeURIComponent(name);
}

// The one error both "no such document" and "you may not read it" return.
// Keeping them byte-identical is what makes omission-over-redaction hold on
// the read path.
function notFound(uri: string): Error {
  return new Error(`resource not found: ${uri}`);
}

// Lists every document the role may read, plus one entry per readable
// collection. `vaultIndex` already applies the read filter, so this function
// inherits the same visibility rule the vault_index tool enforces — one
// predicate, not two that can drift apart.
export async function listResources(
  vaultRoot: string,
  access?: AccessContext,
): Promise<Result<ResourceDescriptor[], Error>> {
  const index = await vaultIndex(vaultRoot, {}, access);
  if (!index.ok) return index;

  const resources: ResourceDescriptor[] = [];
  const collections = new Set<string>();

  for (const entry of index.value.entries) {
    resources.push({
      uri: docUri(entry.path),
      name: entry.title || entry.path,
      mimeType: MARKDOWN_MIME,
      description: entry.collection ? `${entry.collection} · ${entry.status}` : entry.status,
    });
    if (entry.collection) collections.add(entry.collection);
  }

  for (const name of [...collections].sort()) {
    resources.push({
      uri: collectionUri(name),
      name: `Collection: ${name}`,
      mimeType: JSON_MIME,
    });
  }

  return ok(resources);
}

// Reads one resource. Dispatches on the URI prefix; anything else is a
// not-found, same as an unreadable or nonexistent document.
export async function readResource(
  vaultRoot: string,
  uri: string,
  access?: AccessContext,
): Promise<Result<ResourceContents, Error>> {
  if (uri.startsWith(DOC_URI_PREFIX)) {
    return readDocResource(vaultRoot, uri, access);
  }
  if (uri.startsWith(COLLECTION_URI_PREFIX)) {
    return readCollectionResource(vaultRoot, uri, access);
  }
  return err(notFound(uri));
}

async function readDocResource(
  vaultRoot: string,
  uri: string,
  access?: AccessContext,
): Promise<Result<ResourceContents, Error>> {
  const raw = uri.slice(DOC_URI_PREFIX.length);
  if (raw.length === 0) return err(notFound(uri));

  let relPath: string;
  try {
    relPath = raw.split("/").map(decodeURIComponent).join("/");
  } catch {
    // Malformed percent-encoding — indistinguishable from a path that isn't
    // there, and reported as such.
    return err(notFound(uri));
  }

  // Path confinement first: every vault path resolves through the realpath'd
  // canonicalization, and a resolved path that escapes the vault root is
  // rejected. A symlinked file cannot read outside the vault, even when the
  // vault itself sits under a symlinked parent.
  const resolved = resolveVaultPath(vaultRoot, relPath);
  if (!resolved.ok) return err(notFound(uri));

  const file = await readFile(resolved.value.absPath);
  if (!file.ok) return err(notFound(uri));

  const parsed = parseDocument(file.value);
  if (!parsed.ok) return err(notFound(uri));

  if (access) {
    // Gate on the canonical path the filesystem read, not the caller's raw
    // `relPath`: `resolveVaultPath` collapses `..`, so a `public/../restricted/…`
    // alias would otherwise be checked against collection `public` while
    // returning the restricted doc (F1).
    const collection = collectionOf(resolved.value.relPath, parsed.value.frontmatter);
    if (!canRead(access.role, collection)) return err(notFound(uri));
  }

  // Verbatim: frontmatter included, bytes as they sit on disk. The file is
  // the source of truth, so the resource is the file — not a re-serialization
  // of what the parser understood.
  return ok({ uri, mimeType: MARKDOWN_MIME, text: file.value });
}

async function readCollectionResource(
  vaultRoot: string,
  uri: string,
  access?: AccessContext,
): Promise<Result<ResourceContents, Error>> {
  const raw = uri.slice(COLLECTION_URI_PREFIX.length);
  if (raw.length === 0) return err(notFound(uri));

  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return err(notFound(uri));
  }

  if (access && !canRead(access.role, name)) return err(notFound(uri));

  const index = await vaultIndex(vaultRoot, { collection: name }, access);
  if (!index.ok) return index;

  // An empty readable collection and a collection that does not exist are the
  // same answer on purpose — neither confirms nor denies anything the
  // listing would not already have shown.
  const docs = index.value.entries.map((e) => ({
    uri: docUri(e.path),
    path: e.path,
    title: e.title,
    status: e.status,
  }));

  return ok({
    uri,
    mimeType: JSON_MIME,
    text: JSON.stringify({ collection: name, count: docs.length, documents: docs }, null, 2),
  });
}
