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

// The metadata layer for every vault document. Mirrors the YAML frontmatter
// block. Daftari does not maintain any metadata outside frontmatter.
export interface Frontmatter {
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
}

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
