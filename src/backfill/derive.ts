// Deterministic frontmatter derivation for `daftari backfill` (§11.1).
//
// No LLM calls: every value comes from git metadata, body conventions, the
// path, or a fixed default. The contract is "suggest, don't assert" — adopted
// docs are proposed as canonical/medium/direct, but a human ratifies per folder
// before anything is written. Existing frontmatter is never overwritten: a present
// field is preserved as the author wrote it (Dates normalized to YYYY-MM-DD
// strings), only missing fields are filled. A present built-in field whose value
// is foreign vocabulary (#116) is preserved too and labeled a "collision" — the
// apply guard then skips it.

import { validateFrontmatter } from "../frontmatter/schema.js";
import type { Frontmatter } from "../frontmatter/types.js";
import type { FileGitMeta } from "../utils/git.js";
import { detectCollisions } from "./collisions.js";
import { coerceDatePrefix, harvestInlineTags, webClipperSources } from "./obsidian.js";
import type { DerivationMap, DocClassification } from "./types.js";

// kebab-case a free-form string: lowercase, non-alphanumerics → single hyphen,
// trimmed. Used for collection names and the identity fallback slug.
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The first ATX H1 (`# Title`) in the body, or null. Only a single leading `#`
// counts — `##` and deeper are sub-headings, not the document title.
export function firstH1(body: string): string | null {
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (m) return (m[1] as string).trim();
  }
  return null;
}

// Title-cased title derived from a filename when the body has no H1. Strips the
// `.md`, splits the basename on `-`/`_`, and capitalizes each word.
export function titleFromFilename(relPath: string): string {
  const base = (relPath.split("/").pop() ?? relPath).replace(/\.md$/i, "");
  const words = base.split(/[-_]+/).filter((w) => w.length > 0);
  if (words.length === 0) return base;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// Bullet items under a `## <heading>` section, in order. Collection stops at the
// next heading of any level. Placeholder bullets (empty, or fully parenthical
// like "(none yet)") are dropped — they are scaffolding, not real questions.
export function parseQuestionSection(body: string, heading: string): string[] {
  const lines = body.split(/\r?\n/);
  const target = heading.toLowerCase();
  const out: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/);
    if (headingMatch) {
      const text = (headingMatch[1] as string).trim().toLowerCase();
      inSection = text === target;
      continue;
    }
    if (!inSection) continue;
    const bullet = line.match(/^\s*[-*]\s+(.*\S)\s*$/);
    if (!bullet) continue;
    const item = (bullet[1] as string).trim();
    if (item.length === 0) continue;
    if (item.startsWith("(") && item.endsWith(")")) continue;
    out.push(item);
  }
  return out;
}

// Maps a git author name to a Daftari identity: an explicit identity_map entry
// wins; otherwise the default `human:<slug>` fallback.
export function mapIdentity(author: string, identityMap: Record<string, string>): string {
  const mapped = identityMap[author];
  if (mapped) return mapped;
  return `human:${slugify(author) || "unknown"}`;
}

// A frontmatter field is "present" — and therefore preserved — when the raw
// YAML carries a non-null, non-empty-string value for it. Empty arrays count as
// present (the author wrote `[]` deliberately).
function isPresent(raw: Record<string, unknown>, field: string): boolean {
  const v = raw[field];
  if (v === undefined || v === null) return false;
  if (typeof v === "string" && v.length === 0) return false;
  return true;
}

// Whether a document needs backfilling. A doc whose existing frontmatter
// already validates against the built-in schema is conformant and skipped;
// otherwise it is `missing` (no frontmatter at all) or `partial`.
export function classifyDoc(raw: Record<string, unknown>): DocClassification {
  if (validateFrontmatter(raw).report.valid) return "conformant";
  return Object.keys(raw).length === 0 ? "missing" : "partial";
}

export interface DeriveInputs {
  relPath: string;
  body: string;
  // Frontmatter exactly as parsed from YAML (`{}` when absent).
  raw: Record<string, unknown>;
  git: FileGitMeta;
  // YYYY-MM-DD fallback for created/updated when git has no history.
  mtimeDate: string;
  identityMap: Record<string, string>;
  // The CLI invoker identity — last-resort fallback for updated_by when a doc
  // has neither an existing value nor any git author.
  invoker: string;
  // When true, apply Obsidian-aware enrichment: harvest inline #tags into
  // `tags` and map a Web Clipper `source` into `sources`. Default/false leaves
  // derivation byte-identical to the general backfill path.
  obsidian?: boolean;
}

export interface DerivedFrontmatter {
  proposed: Frontmatter;
  derivation: DerivationMap;
}

// A present field is kept verbatim, with one normalization: js-yaml parses an
// unquoted ISO date into a Date, which must become a YYYY-MM-DD string for
// serialization. Everything else (including an out-of-enum value) is returned
// as-is, so it survives to the apply guard instead of being coerced away (#116).
function normalizeRawValue(v: unknown): unknown {
  // A Date never leaves as an object: a valid one becomes YYYY-MM-DD; an invalid
  // one becomes its string form ("Invalid Date") so it stays serializable and is
  // cleanly rejected by the apply guard rather than written as a broken object.
  if (v instanceof Date)
    return Number.isNaN(v.getTime()) ? String(v) : v.toISOString().slice(0, 10);
  return v;
}

// Builds the full proposed frontmatter for a non-conformant doc plus a per-field
// derivation map. Present fields are preserved as the author wrote them (Dates
// normalized to YYYY-MM-DD; out-of-enum values labeled "collision"); missing
// fields are derived from git / body / path / defaults.
export function deriveProposed(input: DeriveInputs): DerivedFrontmatter {
  const { relPath, body, raw, git, mtimeDate, identityMap, invoker } = input;
  const derivation: DerivationMap = {};
  const collisionFields = new Set(detectCollisions(raw).map((c) => c.field));

  // Resolves one field: if present in raw, preserve the normalized raw value
  // (labeling it "collision" when the value is foreign vocabulary); else use the
  // derived value. Records the chosen source label either way.
  function resolve<K extends keyof Frontmatter>(
    field: K,
    derivedValue: Frontmatter[K],
    derivedLabel: string,
  ): Frontmatter[K] {
    if (isPresent(raw, field as string)) {
      derivation[field as string] = collisionFields.has(field as string)
        ? "collision"
        : "preserved";
      return normalizeRawValue(raw[field as string]) as Frontmatter[K];
    }
    derivation[field as string] = derivedLabel;
    return derivedValue;
  }

  // title ← H1, else filename.
  const h1 = firstH1(body);
  const title = resolve("title", h1 ?? titleFromFilename(relPath), h1 ? "body-h1" : "filename");

  // collection ← first path component, kebab-cased.
  const folder = relPath.split("/")[0] ?? "";
  const collection = resolve("collection", slugify(folder), "parent-folder");

  // created/updated ← git, else file mtime.
  const created = resolve(
    "created",
    git.created ?? mtimeDate,
    git.created ? "git-first-commit" : "file-mtime",
  );
  const updated = resolve(
    "updated",
    git.updated ?? mtimeDate,
    git.updated ? "git-last-commit" : "file-mtime",
  );

  // Obsidian-aware: Obsidian/plugins write datetime created/updated; coerce to
  // the date-only form the schema requires. Off-path is untouched (verbatim).
  const createdValue = input.obsidian ? (coerceDatePrefix(created) as typeof created) : created;
  const updatedValue = input.obsidian ? (coerceDatePrefix(updated) as typeof updated) : updated;

  // updated_by ← git author mapped through identity config, else invoker.
  const updatedBy = resolve(
    "updated_by",
    git.author ? mapIdentity(git.author, identityMap) : invoker,
    git.author ? "git-author + identity-map" : "invoker-fallback",
  );

  // questions ← body sections, else empty.
  const qAnswered = parseQuestionSection(body, "Questions Answered");
  const qRaised = parseQuestionSection(body, "Questions Raised");

  // Obsidian-aware tags: take resolve()'s value (present value preserved
  // verbatim — possibly a non-array — else []), then append harvested inline
  // tags ONLY when in obsidian mode and the base is an array. Never coerce or
  // rebuild: a non-array preserved value passes through untouched, so the
  // non-obsidian path and the malformed-tags test stay byte-identical.
  let tagsValue = resolve("tags", [], "empty"); // also sets derivation.tags
  const inlineTags = input.obsidian ? harvestInlineTags(body) : [];
  if (input.obsidian && Array.isArray(tagsValue) && inlineTags.length > 0) {
    const merged = [...tagsValue];
    for (const t of inlineTags) if (!merged.includes(t)) merged.push(t);
    tagsValue = merged;
    // If the base had no present tags, these came from the body. Otherwise
    // resolve() already labeled it "preserved" — leave that.
    if (!isPresent(raw, "tags")) derivation.tags = "inline-tags";
  }

  // Obsidian-aware sources: substitute a Web Clipper `source` only when no
  // sources are present. resolve() handles the present/empty paths and label;
  // we override to "web-clipper-source" only in the substitution case.
  let sourcesValue = resolve("sources", [], "empty"); // also sets derivation.sources
  const clipSources = input.obsidian ? webClipperSources(raw) : undefined;
  if (input.obsidian && !isPresent(raw, "sources") && clipSources) {
    sourcesValue = clipSources;
    derivation.sources = "web-clipper-source";
  }

  const proposed: Frontmatter = {
    title,
    domain: resolve("domain", "accumulation", "default"),
    collection,
    status: resolve("status", "canonical", "default"),
    confidence: resolve("confidence", "medium", "default"),
    created: createdValue,
    updated: updatedValue,
    updated_by: updatedBy,
    provenance: resolve("provenance", "direct", "default"),
    sources: sourcesValue,
    superseded_by: resolve("superseded_by", null, "null"),
    ttl_days: resolve("ttl_days", null, "null"),
    tags: tagsValue,
    // No signal to derive doc-to-code bindings from raw content; default empty.
    describes: resolve("describes", [], "empty"),
    questions_answered: resolve(
      "questions_answered",
      qAnswered,
      qAnswered.length > 0 ? "body-section" : "empty",
    ),
    questions_raised: resolve(
      "questions_raised",
      qRaised,
      qRaised.length > 0 ? "body-section" : "empty",
    ),
  };

  return { proposed, derivation };
}
