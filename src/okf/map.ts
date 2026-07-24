// Pure frontmatter mappers between Daftari and OKF. No filesystem, no I/O — the
// export/import modules own that. Keeping the field translation here makes it
// unit-testable in isolation and keeps the two directions symmetric.

import type { Frontmatter } from "../frontmatter/types.js";
import { normalizeIsoDate } from "../utils/dates.js";
import {
  DAFTARI_SIDECAR_KEY,
  DEFAULT_IMPORT_COLLECTION,
  DEFAULT_OKF_TYPE,
  OKF_ATTESTED_COMPUTATION_TYPE,
  OKF_PRESERVED_PREFIX,
  type OkfStatus,
} from "./types.js";

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

// Daftari lifecycle → OKF v0.2 `status`. `canonical` is the vault's "current,
// trusted" state (OKF `stable`); everything retired — deprecated, superseded,
// archived — maps to `deprecated`, which OKF keeps for historical
// reproducibility without surfacing to new work.
export function statusToOkf(status: string): OkfStatus {
  if (status === "draft") return "draft";
  if (status === "canonical") return "stable";
  return "deprecated";
}

// Daftari's relative `ttl_days` → OKF v0.2 absolute `stale_after` date
// (`updated` + TTL). OKF deliberately uses an absolute date so staleness checks
// are deterministic; anchoring at `updated` preserves the exact day the TTL
// would have expired. Undefined when there is no TTL (no freshness promise) or
// no valid `updated` to anchor it to.
export function staleAfterFromTtl(updated: string, ttlDays: number | null): string | undefined {
  if (ttlDays === null || !Number.isFinite(ttlDays)) return undefined;
  const norm = normalizeIsoDate(updated);
  if (norm === null) return undefined;
  const d = new Date(`${norm}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.trunc(ttlDays));
  return d.toISOString().slice(0, 10);
}

// One Daftari source string → an OKF v0.2 structured source entry. URI-shaped
// sources carry the URI in `resource` with an `id` slug derived from the last
// path segment (the citation handle); bare ids are already ids. Daftari has no
// per-source author/usage_count/last_modified to offer — OKF signals are
// opt-in, so those are simply absent.
export function toOkfSource(source: string): Record<string, unknown> {
  if (!isUri(source)) return { id: source };
  const tail =
    source
      .replace(/[?#].*$/, "")
      .split("/")
      .filter((p) => p !== "")
      .pop() ?? source;
  const id = slugify(tail.replace(/\.[a-z0-9]+$/i, "")) ?? slugify(source) ?? source;
  return { id, resource: source };
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

  // v0.2 trust signals, derived from native Daftari metadata. `generated`
  // replaces the v0.1 `timestamp` (the spec's deliberate rename): `updated_by`
  // is who last produced the content, `updated` is when it last meaningfully
  // changed. `verified` is deliberately NOT emitted — Daftari records
  // authorship, not independent confirmations, and OKF's trust tiers make the
  // absence meaningful (unverified) rather than fabricating a signal.
  const generated: Record<string, unknown> = {};
  if (fm.updated_by.trim() !== "") generated.by = fm.updated_by;
  const at = toIsoTimestamp(fm.updated);
  if (at !== undefined) generated.at = at;
  if (Object.keys(generated).length > 0) out.generated = generated;

  out.status = statusToOkf(fm.status);

  const staleAfter = staleAfterFromTtl(fm.updated, fm.ttl_days);
  if (staleAfter !== undefined) out.stale_after = staleAfter;

  if (fm.sources.length > 0) out.sources = fm.sources.map(toOkfSource);

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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// The document date of an OKF doc: v0.2 `generated.at`, falling back to the
// v0.1 `timestamp` it renamed (the spec-mandated consumer fallback).
export function dateFromGenerated(okfRaw: Record<string, unknown>): string | undefined {
  const generated = asRecord(okfRaw.generated);
  return dateFromTimestamp(generated?.at) ?? dateFromTimestamp(okfRaw.timestamp);
}

// The v0.2 trust tiers, derived from `verified` exactly as the spec defines:
// no entries = unverified, machine actors only = machine-confirmed, any
// `human:<id>` confirmation = human-reviewed.
export type OkfTrustTier = "unverified" | "machine-confirmed" | "human-reviewed";

export function trustTier(verified: unknown): OkfTrustTier {
  if (!Array.isArray(verified) || verified.length === 0) return "unverified";
  const humanReviewed = verified.some((entry) => {
    const by = asRecord(entry)?.by;
    return typeof by === "string" && by.startsWith("human:");
  });
  return humanReviewed ? "human-reviewed" : "machine-confirmed";
}

// OKF v0.2 absolute `stale_after` → Daftari's relative `ttl_days`, anchored at
// the doc's derived date so the freshness promise expires on the same calendar
// day. A stale_after at or before the anchor clamps to 0 — computeStaleness
// reads a non-positive TTL as "stale the moment it ages", which is exactly what
// an already-passed absolute date means. Null when either date is unusable.
export function ttlFromStaleAfter(staleAfter: unknown, anchorDate: string): number | null {
  const target = dateFromTimestamp(staleAfter);
  const anchor = normalizeIsoDate(anchorDate);
  if (target === undefined || anchor === null) return null;
  const days = Math.round(
    (Date.parse(`${target}T00:00:00Z`) - Date.parse(`${anchor}T00:00:00Z`)) / 86_400_000,
  );
  return Math.max(0, days);
}

// Flatten OKF provenance into Daftari's `sources: string[]`: the top-level
// `resource` URI first, then each v0.2 structured source (its `resource` URI
// when present, else its `id`). Per-source signals like author/usage_count
// don't fit a bare string — the raw entries are preserved under
// `okf_sources` by okfToDaftari so nothing is lost.
export function sourcesFromOkf(okfRaw: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && v.trim() !== "" && !out.includes(v)) out.push(v);
  };
  push(okfRaw.resource);
  if (Array.isArray(okfRaw.sources)) {
    for (const entry of okfRaw.sources) {
      if (typeof entry === "string") {
        push(entry);
        continue;
      }
      const rec = asRecord(entry);
      if (rec !== null) push(typeof rec.resource === "string" ? rec.resource : rec.id);
    }
  }
  return out;
}

export interface OkfImportContext {
  relPath: string; // bundle-relative path of the source OKF doc
  today: string; // YYYY-MM-DD, injected so mapping stays pure/deterministic
  updatedBy: string; // acting identity for created/updated authorship
}

// OKF fields the synthesis below consumes into a native Daftari slot (or, for
// description, re-derives from the body on a future export). Everything else —
// the lossy-mapped trust record (`generated`, `verified`, `sources`), the
// Attested Computation machinery (runtime/parameters/executor/receipt/attester),
// and any producer-defined field — is preserved under the `okf_` prefix so the
// import stays non-destructive.
const OKF_CONSUMED_FIELDS = new Set<string>([
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "timestamp",
  "status",
  "stale_after",
  DAFTARI_SIDECAR_KEY,
]);

// OKF concept-doc frontmatter → Daftari frontmatter (as a raw record ready for
// serializeDocument). When the doc carries a `daftari` sidecar (it came from
// `daftari okf export`), that verbatim frontmatter is used directly for an exact
// round-trip. Otherwise a Daftari frontmatter is synthesized from the OKF core
// fields, conservatively: imported knowledge lands as a `draft` in the
// `accumulation` domain, and the original OKF `type` is preserved in an
// `okf_type` field so nothing is silently lost.
//
// v0.2 trust signals feed the synthesis:
//   - `generated.at` dates the doc (falling back to the v0.1 `timestamp`).
//   - `verified` sets confidence by trust tier: human-reviewed lands `high`.
//     Positive signals only ever raise confidence — absence keeps the default
//     `medium`, because an unverified v0.2 doc is indistinguishable from a
//     v0.1 doc that never had the chance to carry the field.
//   - `status: deprecated` imports as `deprecated` (retired knowledge must not
//     resurface as a fresh draft); `draft`/`stable`/absent stay `draft` — this
//     vault has not canonized foreign content, however stable its producer
//     considers it.
//   - `stale_after` converts to `ttl_days` anchored at the doc date.
//   - An `Attested Computation` lands as `tier: source`: the spec forbids
//     agents from editing the computation, and `source` makes the body
//     immutable to every writer.
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

  const date = dateFromGenerated(okfRaw) ?? ctx.today;

  const okfStatus = typeof okfRaw.status === "string" ? okfRaw.status.trim().toLowerCase() : "";

  const attested = okfType.trim().toLowerCase() === OKF_ATTESTED_COMPUTATION_TYPE.toLowerCase();

  const out: Record<string, unknown> = {
    title,
    domain: "accumulation",
    collection,
    status: okfStatus === "deprecated" ? "deprecated" : "draft",
    confidence: trustTier(okfRaw.verified) === "human-reviewed" ? "high" : "medium",
    created: date,
    updated: date,
    updated_by: ctx.updatedBy,
    provenance: "direct",
    tier: attested ? "source" : null,
    sources: sourcesFromOkf(okfRaw),
    superseded_by: null,
    ttl_days: ttlFromStaleAfter(okfRaw.stale_after, date),
    tags: asStringArray(okfRaw.tags),
    describes: [],
    questions_answered: [],
    questions_raised: [],
  };

  // Preserve the OKF kind so the import is not lossy. serializeDocument writes
  // unknown fields through untouched.
  if (okfType.trim() !== "") out.okf_type = okfType;

  // Preserve everything the synthesis did not consume losslessly, prefixed so
  // it can never collide with a Daftari built-in.
  for (const [key, value] of Object.entries(okfRaw)) {
    if (OKF_CONSUMED_FIELDS.has(key)) continue;
    if (value === null || value === undefined) continue;
    out[`${OKF_PRESERVED_PREFIX}${key}`] = value;
  }

  return out;
}
