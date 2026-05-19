// Core shared types for Daftari: the Result pattern and the frontmatter schema.

// A Result<T, E> is returned instead of throwing. Tool handlers and storage
// functions surface failures as values so callers can branch explicitly.
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E = Error>(error: E): Result<never, E> => ({ ok: false, error });

export const DOMAINS = ["accumulation", "generative"] as const;
export type Domain = (typeof DOMAINS)[number];

export const STATUSES = ["draft", "canonical", "deprecated", "superseded", "archived"] as const;
export type Status = (typeof STATUSES)[number];

export const CONFIDENCES = ["low", "medium", "high"] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const PROVENANCES = ["direct", "synthesized", "inferred"] as const;
export type Provenance = (typeof PROVENANCES)[number];

// The runtime value of a config-declared schema-extension field. `date` and
// `enum` fields are carried as strings; `array` fields as string[]. A core
// type so config.ts and the frontmatter layer agree on the shape.
export type ExtensionValue = string | number | boolean | string[] | null;

// Daftari's built-in frontmatter fields — the core schema every vault shares.
// Each field keeps a narrow type; `Frontmatter` intersects this with an open
// index signature so config-declared extension fields are also well-typed.
export interface BuiltinFrontmatter {
  title: string;
  domain: Domain;
  collection: string;
  status: Status;
  confidence: Confidence;
  created: string; // YYYY-MM-DD
  updated: string; // YYYY-MM-DD
  updated_by: string; // agent:<id> | human:<username>
  provenance: Provenance;
  sources: string[];
  superseded_by: string | null;
  ttl_days: number | null;
  tags: string[];
  // Optional epistemic-surface fields. They mirror the body's `## Questions
  // Answered` / `## Questions Raised` convention as structured, tool-queryable
  // metadata. Default to [] when absent.
  questions_answered: string[];
  questions_raised: string[];
}

// The built-in field names, as a runtime list. Config-declared schema
// extensions are rejected if they reuse one of these — an extension adds a
// field, it never redefines a built-in.
export const BUILTIN_FRONTMATTER_FIELDS = [
  "title",
  "domain",
  "collection",
  "status",
  "confidence",
  "created",
  "updated",
  "updated_by",
  "provenance",
  "sources",
  "superseded_by",
  "ttl_days",
  "tags",
  "questions_answered",
  "questions_raised",
] as const;

// The metadata layer for every vault document. Mirrors the YAML frontmatter
// block. The built-in fields keep their narrow types; the index signature
// admits any config-declared schema-extension field without a core type
// change. Daftari does not maintain any metadata outside frontmatter.
export type Frontmatter = BuiltinFrontmatter & {
  [extensionKey: string]: ExtensionValue;
};

// A single problem found while validating frontmatter. Advisory only —
// validation never blocks a read.
export interface ValidationIssue {
  field: string;
  message: string;
}

export interface ValidationReport {
  valid: boolean;
  issues: ValidationIssue[];
}
