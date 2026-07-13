// Pure frontmatter mappers between Daftari and OKF. No filesystem, no I/O — the
// export/import modules own that. Keeping the field translation here makes it
// unit-testable in isolation and keeps the two directions symmetric.

import type { Frontmatter } from "../frontmatter/types.js";
import { normalizeIsoDate } from "../utils/dates.js";
import { DAFTARI_SIDECAR_KEY, DEFAULT_IMPORT_COLLECTION, DEFAULT_OKF_TYPE } from "./types.js";

// True when `s` looks like an absolute URI (has a scheme + "://"). Daftari
// `sources` are often bare ids ("aurora-product-page"); only URI-shaped ones map
// to OKF's `resource`, which is defined as a URI identifying the asset.
export function isUri(s: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
}

// A single-sentence summary for OKF's `description`. Prefers the first
// non-heading, non-list paragraph of the body (cut at the first sentence
// boundary); falls back to the doc's first `questions_answered` entry. Returns
// undefined when there is nothing usable, so the field is simply omitted.
export function deriveDescription(fm: Frontmatter, body: string): string | undefined {
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.startsWith("#")) continue; // heading
    if (/^([-*+]|\d+\.)\s/.test(line)) continue; // list item
    const sentence = /^(.*?[.!?])(\s|$)/.exec(line);
    const text = (sentence ? sentence[1] : line).trim();
    return text.length > 280 ? `${text.slice(0, 277)}...` : text;
  }
  if (fm.questions_answered.length > 0) return fm.questions_answered[0];
  return undefined;
}

// Daftari `YYYY-MM-DD` → OKF ISO 8601 datetime. Returns undefined for anything
// that isn't a real calendar date so an invalid `updated` never emits a bogus
// timestamp.
export function toIsoTimestamp(date: string): string | undefined {
  const norm = normalizeIsoDate(date);
  return norm === null ? undefined : `${norm}T00:00:00Z`;
}

// Daftari document → OKF concept-doc frontmatter. `raw` is the document's
// original frontmatter verbatim; it is stashed under the `daftari` key so an
// `okf import` of this bundle can reconstruct the source exactly rather than
// re-deriving it from the lossy OKF core fields. `body` is unchanged by export;
// it is passed only to derive the description.
export function daftariToOkf(
  raw: Record<string, unknown>,
  fm: Frontmatter,
  body: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // `type` is the only required OKF field. Daftari's `collection` is the closest
  // notion of a document kind; fall back to a generic type when it is empty.
  out.type = fm.collection.trim() || DEFAULT_OKF_TYPE;

  if (fm.title.trim() !== "") out.title = fm.title;

  const description = deriveDescription(fm, body);
  if (description !== undefined) out.description = description;

  const resource = fm.sources.find(isUri);
  if (resource !== undefined) out.resource = resource;

  if (fm.tags.length > 0) out.tags = fm.tags;

  const timestamp = toIsoTimestamp(fm.updated);
  if (timestamp !== undefined) out.timestamp = timestamp;

  // Lossless round-trip channel. Never overwritten by the derived fields above
  // because it lives under its own key.
  out[DAFTARI_SIDECAR_KEY] = raw;

  return out;
}

// Basename without extension, humanized, as a fallback title for a foreign OKF
// doc that omitted `title` (OKF says title is derived from the filename then).
export function titleFromPath(relPath: string): string {
  const base = relPath.split("/").pop() ?? relPath;
  return base.replace(/\.md$/i, "").replace(/[-_]+/g, " ").trim();
}

// Top-level bundle directory of a doc, used as the Daftari collection so a
// bundle's folder structure survives import. Null for a doc at the bundle root.
export function collectionFromPath(relPath: string): string | null {
  const parts = relPath.split("/").filter((p) => p !== "");
  return parts.length > 1 ? parts[0] : null;
}

// Lowercase kebab slug of an arbitrary OKF `type` string, for use as a Daftari
// collection when the doc has no directory. Returns null if nothing survives.
export function slugify(s: string): string | null {
  const slug = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? null : slug;
}

// OKF `timestamp` → Daftari `YYYY-MM-DD`. Accepts a js-yaml Date (unquoted ISO
// datetimes parse to Date), an ISO string, or a bare date; returns undefined
// when it cannot recover a real calendar date.
export function dateFromTimestamp(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "string") {
    return normalizeIsoDate(value.slice(0, 10)) ?? undefined;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

export interface OkfImportContext {
  relPath: string; // bundle-relative path of the source OKF doc
  today: string; // YYYY-MM-DD, injected so mapping stays pure/deterministic
  updatedBy: string; // acting identity for created/updated authorship
}

// OKF concept-doc frontmatter → Daftari frontmatter (as a raw record ready for
// serializeDocument). When the doc carries a `daftari` sidecar (it came from
// `daftari okf export`), that verbatim frontmatter is used directly for an exact
// round-trip. Otherwise a Daftari frontmatter is synthesized from the OKF core
// fields, conservatively: imported knowledge lands as a `draft` in the
// `accumulation` domain, and the original OKF `type` is preserved in an
// `okf_type` field so nothing is silently lost.
export function okfToDaftari(
  okfRaw: Record<string, unknown>,
  ctx: OkfImportContext,
): Record<string, unknown> {
  const sidecar = okfRaw[DAFTARI_SIDECAR_KEY];
  if (sidecar !== null && typeof sidecar === "object" && !Array.isArray(sidecar)) {
    return { ...(sidecar as Record<string, unknown>) };
  }

  const title =
    typeof okfRaw.title === "string" && okfRaw.title.trim() !== ""
      ? okfRaw.title
      : titleFromPath(ctx.relPath);

  const okfType = typeof okfRaw.type === "string" ? okfRaw.type : "";
  const collection =
    collectionFromPath(ctx.relPath) ?? slugify(okfType) ?? DEFAULT_IMPORT_COLLECTION;

  const date = dateFromTimestamp(okfRaw.timestamp) ?? ctx.today;

  const sources =
    typeof okfRaw.resource === "string" && okfRaw.resource.trim() !== "" ? [okfRaw.resource] : [];

  const out: Record<string, unknown> = {
    title,
    domain: "accumulation",
    collection,
    status: "draft",
    confidence: "medium",
    created: date,
    updated: date,
    updated_by: ctx.updatedBy,
    provenance: "direct",
    sources,
    superseded_by: null,
    ttl_days: null,
    tags: asStringArray(okfRaw.tags),
    describes: [],
    questions_answered: [],
    questions_raised: [],
  };

  // Preserve the OKF kind so the import is not lossy. serializeDocument writes
  // unknown fields through untouched.
  if (okfType.trim() !== "") out.okf_type = okfType;

  return out;
}
