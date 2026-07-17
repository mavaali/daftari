// Hand-rolled, dependency-free frontmatter validator.
//
// Validation is advisory and best-effort: it always produces a complete
// Frontmatter object (filling defaults for anything missing or malformed) so
// downstream readers never crash, and it returns a ValidationReport listing
// every structural problem. It does NOT enforce curation rules (staleness,
// tension, superseded_by consistency) — that is the curation engine's job.

import type { SchemaExtension } from "../utils/config.js";
import { normalizeIsoDate } from "../utils/dates.js";
import {
  CONFIDENCES,
  type Confidence,
  DOMAINS,
  type Domain,
  type Frontmatter,
  PROVENANCES,
  type Provenance,
  STATUSES,
  type Status,
  TIERS,
  type Tier,
  type ValidationIssue,
  type ValidationReport,
} from "./types.js";

export interface FrontmatterValidation {
  frontmatter: Frontmatter;
  report: ValidationReport;
}

// Upper bound on the length of a value a config-declared `pattern` is run
// against. Config load already screens patterns for catastrophic backtracking
// (utils/redos.ts), but JS regex is synchronous — this caps worst-case work so
// no pattern, safe or not, can be driven by an unbounded value. Generous enough
// for the structured short fields patterns are meant for (ids, slugs, urls).
const MAX_PATTERN_INPUT_LENGTH = 4096;

// Validates one config-declared extension field against the raw frontmatter,
// appending any problem to `issues`. Advisory, like the built-in checks: a
// missing optional field is fine, a missing field with a declared default is
// fine (the default is applied at serialization time).
function validateExtensionField(
  data: Record<string, unknown>,
  ext: SchemaExtension,
  issues: ValidationIssue[],
): void {
  const v = data[ext.field];
  const field = ext.field;

  if (v === undefined || v === null) {
    if (ext.required && ext.default === undefined) {
      issues.push({ field, message: "missing required field" });
    }
    return;
  }

  switch (ext.type) {
    case "string": {
      if (typeof v !== "string") {
        issues.push({ field, message: `expected string, got ${typeof v}` });
        return;
      }
      if (ext.pattern) {
        // Defense-in-depth against ReDoS: config load screens patterns for
        // catastrophic backtracking, but JS regex is synchronous, so never run
        // even a linear-safe pattern against an unbounded value.
        if (v.length > MAX_PATTERN_INPUT_LENGTH) {
          issues.push({
            field,
            message: `value too long to pattern-validate (${v.length} > ${MAX_PATTERN_INPUT_LENGTH})`,
          });
        } else if (!new RegExp(ext.pattern).test(v)) {
          issues.push({ field, message: `does not match pattern /${ext.pattern}/` });
        }
      }
      return;
    }
    case "date": {
      // js-yaml parses unquoted ISO dates into Date objects.
      if (v instanceof Date && !Number.isNaN(v.getTime())) return;
      if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return;
      issues.push({ field, message: `expected a YYYY-MM-DD date, got ${JSON.stringify(v)}` });
      return;
    }
    case "number": {
      if (typeof v !== "number" || !Number.isFinite(v)) {
        issues.push({ field, message: `expected number, got ${typeof v}` });
      }
      return;
    }
    case "boolean": {
      if (typeof v !== "boolean") {
        issues.push({ field, message: `expected boolean, got ${typeof v}` });
      }
      return;
    }
    case "array": {
      if (!Array.isArray(v) || !v.every((item) => typeof item === "string")) {
        issues.push({ field, message: "expected an array of strings" });
      }
      return;
    }
    case "enum": {
      const allowed = ext.enum ?? [];
      if (typeof v !== "string" || !allowed.includes(v)) {
        issues.push({
          field,
          message: `expected one of [${allowed.join(", ")}], got ${JSON.stringify(v)}`,
        });
      }
      return;
    }
  }
}

// Validates frontmatter against the built-in schema and, when supplied, the
// config-declared schema extensions. Extensions are checked alongside the
// built-ins; their issues land in the same advisory report. With no
// extensions the behaviour is identical to before they existed.
export function validateFrontmatter(
  data: Record<string, unknown>,
  extensions: SchemaExtension[] = [],
): FrontmatterValidation {
  const issues: ValidationIssue[] = [];

  const requireString = (field: string): string => {
    const v = data[field];
    if (typeof v === "string" && v.length > 0) return v;
    if (v === undefined || v === null || v === "") {
      issues.push({ field, message: "missing required field" });
    } else {
      issues.push({ field, message: `expected string, got ${typeof v}` });
    }
    return "";
  };

  const requireEnum = <T extends string>(field: string, allowed: readonly T[], fallback: T): T => {
    const v = data[field];
    if (typeof v === "string" && (allowed as readonly string[]).includes(v)) {
      return v as T;
    }
    if (v === undefined || v === null) {
      issues.push({ field, message: "missing required field" });
    } else {
      issues.push({
        field,
        message: `expected one of [${allowed.join(", ")}], got ${JSON.stringify(v)}`,
      });
    }
    return fallback;
  };

  const requireDate = (field: string): string => {
    const v = data[field];
    // js-yaml parses unquoted ISO dates into Date objects.
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
      return v.toISOString().slice(0, 10);
    }
    if (typeof v === "string") {
      // Preserve the author's raw value verbatim (serializeDocument writes this
      // back to the source file — a tool-mediated write must never rewrite or
      // drop what the author put there, #113). Flag anything that isn't a
      // canonical, real-calendar YYYY-MM-DD so vault_lint surfaces it; this also
      // closes the gap where an out-of-range value like "2026-13-45" passed the
      // bare regex unflagged. The index layer (insertDocument) does the
      // normalize-or-empty so date-math consumers never see a poison string.
      if (normalizeIsoDate(v) !== v) {
        issues.push({ field, message: `expected YYYY-MM-DD date, got "${v}"` });
      }
      return v;
    }
    if (v === undefined || v === null) {
      issues.push({ field, message: "missing required field" });
    } else {
      issues.push({ field, message: `expected date, got ${typeof v}` });
    }
    return "";
  };

  // Optional arrays default to []; only malformed values are flagged.
  const optionalStringArray = (field: string): string[] => {
    const v = data[field];
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) {
      const out: string[] = [];
      v.forEach((item, i) => {
        if (typeof item === "string") out.push(item);
        else issues.push({ field, message: `element ${i} is not a string` });
      });
      return out;
    }
    issues.push({ field, message: `expected array, got ${typeof v}` });
    return [];
  };

  // Optional enums default to null, NOT to a member value — unlike
  // requireEnum's fallback. tier depends on this: null means "no write-path
  // enforcement", so coercing a missing tier to any member would silently
  // opt every untagged doc into (or out of) protection.
  const optionalEnum = <T extends string>(field: string, allowed: readonly T[]): T | null => {
    const v = data[field];
    if (v === undefined || v === null) return null;
    if (typeof v === "string" && (allowed as readonly string[]).includes(v)) {
      return v as T;
    }
    issues.push({
      field,
      message: `expected one of [${allowed.join(", ")}] or null, got ${JSON.stringify(v)}`,
    });
    return null;
  };

  const optionalString = (field: string): string | null => {
    const v = data[field];
    if (v === undefined || v === null) return null;
    if (typeof v === "string") return v;
    issues.push({ field, message: `expected string or null, got ${typeof v}` });
    return null;
  };

  const optionalNumber = (field: string): number | null => {
    const v = data[field];
    if (v === undefined || v === null) return null;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    issues.push({ field, message: `expected number or null, got ${typeof v}` });
    return null;
  };

  const frontmatter: Frontmatter = {
    title: requireString("title"),
    domain: requireEnum<Domain>("domain", DOMAINS, "accumulation"),
    collection: requireString("collection"),
    status: requireEnum<Status>("status", STATUSES, "draft"),
    confidence: requireEnum<Confidence>("confidence", CONFIDENCES, "low"),
    created: requireDate("created"),
    updated: requireDate("updated"),
    updated_by: requireString("updated_by"),
    provenance: requireEnum<Provenance>("provenance", PROVENANCES, "inferred"),
    tier: optionalEnum<Tier>("tier", TIERS),
    sources: optionalStringArray("sources"),
    superseded_by: optionalString("superseded_by"),
    ttl_days: optionalNumber("ttl_days"),
    tags: optionalStringArray("tags"),
    describes: optionalStringArray("describes"),
    questions_answered: optionalStringArray("questions_answered"),
    questions_raised: optionalStringArray("questions_raised"),
  };

  for (const ext of extensions) {
    validateExtensionField(data, ext, issues);
  }

  return {
    frontmatter,
    report: { valid: issues.length === 0, issues },
  };
}
