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

// A principal's stance on the claim a doc carries. `qualify` refines without
// contesting: it conflicts with nothing (R-1 rule — contested requires a live
// assert AND a live dispute; stance-enum-only, no text comparison).
export const STANCES = ["assert", "dispute", "qualify"] as const;
export type Stance = (typeof STANCES)[number];

// One principal's attributed, graded, supersedable position on a claim doc.
// `principal` is the bare AccessContext.user string — the same ground truth
// the provenance log records (DN-1); never the free-text `agent` claim.
// `superseded_by` targets a position id WITHIN the same doc, or null (live).
export interface Position {
  id: string; // pos-NNN, unique within the doc
  principal: string;
  stance: Stance;
  statement: string | null;
  confidence: Confidence;
  provenance: Provenance;
  valid_from: string | null; // YYYY-MM-DD
  superseded_by: string | null;
  created: string; // YYYY-MM-DD
  sources: string[];
}

// The RATIFIED consolidated stance. Typed in Slice 1 so reads and the schema
// round-trip it; the only writer (vault_consolidate) is Slice 2.
export interface OrgPosition {
  stance: Stance;
  confidence: Confidence;
  ratified_by: string;
  ratified_at: string; // YYYY-MM-DD
  dissent: string[]; // surviving minority position ids
}

// #141: opt-in write-protection tier. `source` — raw ingested material, body
// is immutable to every writer (escape hatch: vault_set_tier demotes it first,
// loudly). `manual` — human-authored canon, body rewrites require a `human:*`
// identity. `compiled` — agent-maintained synthesis, no enforcement; named so
// a compilation pass can assert what it is allowed to regenerate. Unset (null)
// means no enforcement — the pre-#141 behavior for every existing doc.
export const TIERS = ["source", "compiled", "manual"] as const;
export type Tier = (typeof TIERS)[number];

// Cost-of-being-wrong for a document — the one triage signal the graph cannot
// infer (a pricing/legal/security doc is load-bearing; a scratch note is not).
// Optional and display-only: it enforces nothing on the write path, it makes a
// tension's stakes legible. Null = unstated (every pre-feature doc), never "low".
export const CRITICALITIES = ["low", "medium", "high"] as const;
export type Criticality = (typeof CRITICALITIES)[number];

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
  tier: Tier | null;
  criticality: Criticality | null;
  sources: string[];
  superseded_by: string | null;
  ttl_days: number | null;
  // Valid time — when the fact is true IN THE WORLD, as distinct from the
  // transaction time carried by created/updated and git history.
  //
  // HALF-OPEN and day-granular: [valid_from, valid_until). valid_from
  // 2026-01-01 / valid_until 2026-04-01 covers 2026-03-31 but NOT 2026-04-01,
  // so valid_until names the first day the claim did not hold. That makes a
  // handoff exact — a successor's valid_from is its predecessor's valid_until,
  // sharing no day and needing no arithmetic.
  //
  // A null valid_until with a valid_from means open-ended (still true as far
  // as the vault knows), NOT "unknown end"; a null valid_from with a
  // valid_until means open-start. Both null means valid-time-unknown, which is
  // the state of every document that predates the feature — never "always
  // valid". Authored, never inferred: ttl_days is a review promise ("re-check
  // me in 45 days"), not a claim that a fact held for 45 days, and the two
  // must not be collapsed.
  valid_from: string | null; // YYYY-MM-DD
  valid_until: string | null; // YYYY-MM-DD
  tags: string[];
  // Doc-to-code bindings: code paths this doc describes, each `repo:path` or
  // `repo:path::symbol` (a bare `path` resolves against the doc's own repo).
  // A first-class relationship like `sources` / `superseded_by`. Default [].
  describes: string[];
  // Optional epistemic-surface fields. They mirror the body's `## Questions
  // Answered` / `## Questions Raised` convention as structured, tool-queryable
  // metadata. Default to [] when absent.
  questions_answered: string[];
  questions_raised: string[];
  // Reserved built-in for the deferred subject-keyed erasure subsystem.
  // Default []; not populated by distill, no cascade — placeholder so future
  // subject-keyed erasure is a feature-add, not a migration.
  subjects: string[];
  // Multi-principal contested beliefs (Slice 1). Null = legacy consolidated
  // doc — principal unknown, never retroactively attributed from updated_by.
  positions: Position[] | null;
  org_position: OrgPosition | null;
  // Derived: ≥2 unsuperseded positions with conflicting stances (assert vs
  // dispute). Recomputed by every vault_assert; lint flags hand-set drift.
  contested: boolean | null;
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
  "tier",
  "criticality",
  "sources",
  "superseded_by",
  "ttl_days",
  "valid_from",
  "valid_until",
  "tags",
  "describes",
  "questions_answered",
  "questions_raised",
  "subjects",
  "positions",
  "org_position",
  "contested",
] as const;

// The metadata layer for every vault document. Mirrors the YAML frontmatter
// block. The built-in fields keep their narrow types; the index signature
// admits any config-declared schema-extension field without a core type
// change. Daftari does not maintain any metadata outside frontmatter.
export type Frontmatter = BuiltinFrontmatter & {
  // Widened beyond ExtensionValue because Position[]/OrgPosition are built-in
  // object shapes an intersection literal must satisfy (LD-8). Config-declared
  // extensions are still constrained to ExtensionValue at the config layer.
  [extensionKey: string]: ExtensionValue | Position[] | OrgPosition;
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
