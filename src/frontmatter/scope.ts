// Scoped addressing (docs/superpowers/specs/2026-11-08-scoped-addressing-design.md).
//
// A note may carry a stable address: `scope` ("<level>::<value>") plus `key`
// (a slug). The address derives its path deterministically —
// `scopes/<level>/<value>/<key>.md` — so two writers naming the same address
// land on the same file by construction, with no lookup index to drift.
//
// Derivation is a trust boundary: caller text becomes a filesystem path. The
// value keeps `/` as a directory separator; every other character outside
// [A-Za-z0-9._-] becomes `-`. Empty, `.`-leading (which covers `.` and `..`),
// and over-long segments are refused outright rather than repaired, and the
// result is re-checked against the vault root by resolveVaultPath downstream.

import { err, ok, type Result } from "./types.js";

export const SCOPES_COLLECTION = "scopes";

const LEVEL_RE = /^[a-z][a-z0-9-]*$/;
const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
// Whitespace and control characters are refused in the value (not mapped):
// they are almost always a caller bug, and silently turning them into `-`
// would hide it.
const FORBIDDEN_VALUE_RE = /[\s\p{Cc}]/u;
const UNSAFE_CHAR_RE = /[^A-Za-z0-9._-]/g;
// Bounds the whole value and each path segment (most filesystems cap a name
// at 255 bytes; sanitized segments are ASCII, so chars == bytes).
const MAX_VALUE_BYTES = 1024;
const MAX_SEGMENT_BYTES = 255;

export interface ParsedScope {
  level: string;
  value: string;
}

export function parseScope(scope: unknown): Result<ParsedScope, Error> {
  if (typeof scope !== "string") return err(new Error("scope must be a string"));
  const sep = scope.indexOf("::");
  if (sep === -1)
    return err(new Error(`scope must be "<level>::<value>", got ${JSON.stringify(scope)}`));
  const level = scope.slice(0, sep);
  const value = scope.slice(sep + 2);
  if (!LEVEL_RE.test(level)) {
    return err(
      new Error(`scope level must match ${LEVEL_RE.source}, got ${JSON.stringify(level)}`),
    );
  }
  if (value.length === 0) return err(new Error("scope value must be non-empty"));
  if (FORBIDDEN_VALUE_RE.test(value)) {
    return err(new Error("scope value must not contain whitespace or control characters"));
  }
  if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
    return err(new Error(`scope value must be at most ${MAX_VALUE_BYTES} UTF-8 bytes`));
  }
  return ok({ level, value });
}

export function validateKey(key: unknown): Result<string, Error> {
  if (typeof key !== "string" || !KEY_RE.test(key)) {
    return err(new Error(`key must match ${KEY_RE.source}, got ${JSON.stringify(key)}`));
  }
  return ok(key);
}

function valueSegments(value: string): Result<string[], Error> {
  const out: string[] = [];
  for (const raw of value.split("/")) {
    if (raw.length === 0) {
      return err(
        new Error("scope value must not have empty segments (leading, trailing, or '//')"),
      );
    }
    if (raw.startsWith(".")) {
      return err(new Error(`scope value segment ${JSON.stringify(raw)} must not start with '.'`));
    }
    const safe = raw.replace(UNSAFE_CHAR_RE, "-");
    if (safe.length > MAX_SEGMENT_BYTES) {
      return err(new Error(`scope value segments must be at most ${MAX_SEGMENT_BYTES} bytes`));
    }
    out.push(safe);
  }
  return ok(out);
}

// The one scope/key -> vault-relative path function. Pure, no disk I/O.
export function deriveScopedPath(scope: unknown, key: unknown): Result<string, Error> {
  const parsed = parseScope(scope);
  if (!parsed.ok) return parsed;
  const k = validateKey(key);
  if (!k.ok) return k;
  const segments = valueSegments(parsed.value.value);
  if (!segments.ok) return segments;
  return ok([SCOPES_COLLECTION, parsed.value.level, ...segments.value, `${k.value}.md`].join("/"));
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null;
}

// Frontmatter-level checks for validateFrontmatter: both or neither, each
// well-formed, and the pair derivable. Returns issues; the caller merges them.
export function scopeKeyIssues(
  data: Record<string, unknown>,
): Array<{ field: string; message: string }> {
  const hasScope = present(data.scope);
  const hasKey = present(data.key);
  if (!hasScope && !hasKey) return [];
  if (hasScope && !hasKey) return [{ field: "key", message: "required when scope is set" }];
  if (!hasScope && hasKey) return [{ field: "scope", message: "required when key is set" }];
  const issues: Array<{ field: string; message: string }> = [];
  const s = parseScope(data.scope);
  if (!s.ok) issues.push({ field: "scope", message: s.error.message });
  const k = validateKey(data.key);
  if (!k.ok) issues.push({ field: "key", message: k.error.message });
  if (issues.length === 0) {
    const derived = deriveScopedPath(data.scope, data.key);
    if (!derived.ok) issues.push({ field: "scope", message: derived.error.message });
  }
  return issues;
}

// The placement invariant shared by vault_write (refuse) and vault_lint
// (report): a document carrying scope/key lives exactly at its derived path in
// collection `scopes`, and `scopes/` holds nothing else. Returns a reason, or
// null when the document is placed correctly. Assumes scopeKeyIssues passed.
export function scopedPathMismatch(relPath: string, fm: Record<string, unknown>): string | null {
  const inScopes = relPath.startsWith(`${SCOPES_COLLECTION}/`);
  if (!present(fm.scope) && !present(fm.key)) {
    return inScopes
      ? `${SCOPES_COLLECTION}/ is reserved for scoped notes; this document has no scope/key ` +
          "(write it via vault_write scope + key, or move it out of scopes/)"
      : null;
  }
  const derived = deriveScopedPath(fm.scope, fm.key);
  if (!derived.ok) return `invalid scope/key: ${derived.error.message}`;
  if (derived.value !== relPath) {
    return `scope ${JSON.stringify(fm.scope)} + key ${JSON.stringify(fm.key)} derive to ${derived.value}, not ${relPath}`;
  }
  if (fm.collection !== SCOPES_COLLECTION) {
    return `a scoped note's collection must be '${SCOPES_COLLECTION}', got ${JSON.stringify(fm.collection)}`;
  }
  return null;
}
