// Hand-rolled, dependency-free frontmatter validator.
//
// Validation is advisory and best-effort: it always produces a complete
// Frontmatter object (filling defaults for anything missing or malformed) so
// downstream readers never crash, and it returns a ValidationReport listing
// every structural problem. It does NOT enforce curation rules (staleness,
// tension, superseded_by consistency) — that is the curation engine's job.

import {
  CONFIDENCES,
  DOMAINS,
  PROVENANCES,
  STATUSES,
  type Confidence,
  type Domain,
  type Frontmatter,
  type Provenance,
  type Status,
  type ValidationIssue,
  type ValidationReport,
} from "./types.js";

export interface FrontmatterValidation {
  frontmatter: Frontmatter;
  report: ValidationReport;
}

export function validateFrontmatter(
  data: Record<string, unknown>,
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

  const requireEnum = <T extends string>(
    field: string,
    allowed: readonly T[],
    fallback: T,
  ): T => {
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
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
      issues.push({ field, message: `expected YYYY-MM-DD date, got "${v}"` });
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
    sources: optionalStringArray("sources"),
    superseded_by: optionalString("superseded_by"),
    ttl_days: optionalNumber("ttl_days"),
    tags: optionalStringArray("tags"),
  };

  return {
    frontmatter,
    report: { valid: issues.length === 0, issues },
  };
}
