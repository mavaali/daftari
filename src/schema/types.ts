// Shared types for `daftari schema infer` / `daftari schema diff`.
//
// infer reports the vault's de facto frontmatter schema — every key that
// actually occurs, its inferred type(s), example values, and whether it looks
// enum-like. diff compares that against the declared schema (built-ins +
// config schema_extensions). Both are read-only and advisory: they report,
// they fix nothing.

export interface ScannedDoc {
  relPath: string;
  scope: string; // first path component, "" for root-level docs
  raw: Record<string, unknown>;
}

// Inferred type labels for an observed frontmatter value. "date" is a string
// that parses as YYYY-MM-DD (or a js-yaml-parsed Date) — distinct from a plain
// string so a field that's consistently date-shaped reads as such.
export type InferredType =
  | "string"
  | "date"
  | "number"
  | "boolean"
  | "array"
  | "object"
  | "null";

export interface FieldStats {
  field: string;
  occurrences: number; // docs where the key is present with a non-null value
  types: InferredType[]; // distinct types observed, most frequent first
  examples: unknown[]; // up to a handful of distinct example values
  distinctValues: number; // count of distinct values seen (capped)
  distinctValuesCapped: boolean; // true if distinctValues hit the tracking cap
  enumLike: boolean; // small, repeated value set — a plausible enum
}

export interface InferredSchema {
  scope: string | null;
  totalDocs: number;
  skipped: { path: string; reason: string }[];
  fields: FieldStats[]; // sorted by occurrence desc, then field name
}

export interface UndeclaredKeyFinding {
  field: string;
  occurrences: number;
  types: InferredType[];
  enumLike: boolean;
  nearMiss: string | null; // closest declared field name, if within edit distance
}

export interface UnusedExtensionFinding {
  field: string;
  type: string;
}

export interface DriftFinding {
  field: string;
  declaredType: string;
  occurrences: number; // docs where the field is present
  offending: number; // docs whose value violates the declared type/enum
  messages: string[]; // distinct validation messages observed
  examples: unknown[]; // sample offending raw values
}

export interface SchemaDiffReport {
  scope: string | null;
  totalDocs: number;
  undeclared: UndeclaredKeyFinding[];
  unusedExtensions: UnusedExtensionFinding[];
  drift: DriftFinding[];
}
