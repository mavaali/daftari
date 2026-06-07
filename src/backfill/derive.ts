// Deterministic frontmatter derivation for `daftari backfill` (§11.1).
//
// No LLM calls: every value comes from git metadata, body conventions, the
// path, or a fixed default. The contract is "suggest, don't assert" — adopted
// docs are proposed as canonical/medium/direct, but a human ratifies per folder
// before anything is written. Existing frontmatter is never overwritten: a
// present field is preserved verbatim, only missing fields are filled.

import { validateFrontmatter } from "../frontmatter/schema.js";
import type { Frontmatter } from "../frontmatter/types.js";
import type { FileGitMeta } from "../utils/git.js";
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
  // The same frontmatter coerced by the validator — used to read present
  // fields with their normalized types (e.g. a YAML Date → YYYY-MM-DD string).
  coerced: Frontmatter;
  git: FileGitMeta;
  // YYYY-MM-DD fallback for created/updated when git has no history.
  mtimeDate: string;
  identityMap: Record<string, string>;
  // The CLI invoker identity — last-resort fallback for updated_by when a doc
  // has neither an existing value nor any git author.
  invoker: string;
}

export interface DerivedFrontmatter {
  proposed: Frontmatter;
  derivation: DerivationMap;
}

// Builds the full proposed frontmatter for a non-conformant doc plus a per-field
// derivation map. Present fields are preserved (coerced value, label
// "preserved"); missing fields are derived from git / body / path / defaults.
export function deriveProposed(input: DeriveInputs): DerivedFrontmatter {
  const { relPath, body, raw, coerced, git, mtimeDate, identityMap, invoker } = input;
  const derivation: DerivationMap = {};

  // Resolves one field: if present in raw, preserve the coerced value; else use
  // the derived value. Records the chosen source label either way.
  function resolve<K extends keyof Frontmatter>(
    field: K,
    derivedValue: Frontmatter[K],
    derivedLabel: string,
  ): Frontmatter[K] {
    if (isPresent(raw, field as string)) {
      derivation[field as string] = "preserved";
      return coerced[field] as Frontmatter[K];
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

  // updated_by ← git author mapped through identity config, else invoker.
  const updatedBy = resolve(
    "updated_by",
    git.author ? mapIdentity(git.author, identityMap) : invoker,
    git.author ? "git-author + identity-map" : "invoker-fallback",
  );

  // questions ← body sections, else empty.
  const qAnswered = parseQuestionSection(body, "Questions Answered");
  const qRaised = parseQuestionSection(body, "Questions Raised");

  const proposed: Frontmatter = {
    title,
    domain: resolve("domain", "accumulation", "default"),
    collection,
    status: resolve("status", "canonical", "default"),
    confidence: resolve("confidence", "medium", "default"),
    created,
    updated,
    updated_by: updatedBy,
    provenance: resolve("provenance", "direct", "default"),
    sources: resolve("sources", [], "empty"),
    superseded_by: resolve("superseded_by", null, "null"),
    ttl_days: resolve("ttl_days", null, "null"),
    tags: resolve("tags", [], "empty"),
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
