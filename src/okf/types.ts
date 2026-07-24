// Open Knowledge Format (OKF) — shared constants and types.
//
// OKF is Google Cloud's vendor-neutral specification (v0.2) for the LLM-wiki
// pattern: a directory of markdown files with YAML frontmatter that any
// producer can emit and any consumer can read without translation. Daftari's
// vault *is* this pattern, so `daftari okf export|import` bridges the two.
//
// Spec essentials that this module implements:
//   - A concept doc is any non-reserved `.md` file with a frontmatter block.
//   - The single required frontmatter field is `type` (a free-form kind string).
//   - Recommended fields: title, description, resource, tags.
//   - Reserved filenames: index.md (progressive-disclosure listing) and log.md
//     (chronological change history, newest first).
//   - Consumers must tolerate unknown fields and unknown `type` values.
//
// v0.2 adds opt-in trust signals — raw credibility indicators, never computed
// scores, all optional so v0.1 bundles stay valid:
//   - `generated: {by, at}` — who produced the content and when it last
//     meaningfully changed. Renames v0.1 `timestamp` (consumers fall back).
//   - `verified: [{by, at}]` — independent confirmations. The trust tier is
//     derived: no key = unverified, machine actors only = machine-confirmed,
//     any `human:<id>` entry = human-reviewed.
//   - `status: draft | stable | deprecated` — lifecycle; absent means stable.
//   - `stale_after: YYYY-MM-DD` — absolute date (not a TTL) for deterministic
//     staleness checks.
//   - `sources: [{id, resource, title, author, usage_count, last_modified}]`
//     — structured provenance. Renames the v0.1 body `# Citations` list.
//   - A new concept type, `Attested Computation`: a sanctioned computation
//     agents may parameterize but never edit.

// The OKF spec version this producer targets and this consumer understands.
// Written into the exported bundle's root index.md frontmatter (the spec's
// place for a bundle to declare its target version).
export const OKF_VERSION = "0.2";

// Reserved filenames with defined structural meaning. They are NOT concept
// docs: export generates them, import skips them.
export const OKF_INDEX_FILE = "index.md";
export const OKF_LOG_FILE = "log.md";
export const OKF_RESERVED_FILES = [OKF_INDEX_FILE, OKF_LOG_FILE] as const;

// The frontmatter key under which export stashes the document's original,
// verbatim Daftari frontmatter. It is an ordinary producer-defined field as far
// as OKF is concerned (consumers preserve it), but it lets `okf import` of a
// Daftari-produced bundle reconstruct the source frontmatter exactly rather than
// re-synthesizing it from the lossy OKF core fields. Absent on foreign bundles.
export const DAFTARI_SIDECAR_KEY = "daftari";

// The `type` value assigned to a concept doc that has no natural kind to map
// from (an untitled/uncollected doc on export, a foreign doc with no directory
// on import). OKF requires a non-empty `type`; this keeps every emitted doc
// conformant without inventing a false-specific kind.
export const DEFAULT_OKF_TYPE = "note";

// The Daftari collection assigned to a foreign OKF concept doc that carries no
// directory and no usable `type` to derive one from.
export const DEFAULT_IMPORT_COLLECTION = "imported";

// The canonical OKF frontmatter fields, in the order export writes them. `type`
// is the only required one; the rest are recommended/optional and omitted when
// empty. `timestamp` is the v0.1 name for `generated.at` — export writes the
// v0.2 form, import still accepts the old one.
export const OKF_CORE_FIELDS = [
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "generated",
  "verified",
  "status",
  "stale_after",
  "sources",
] as const;

// The v0.2 lifecycle states. Absence means "stable" per spec.
export const OKF_STATUSES = ["draft", "stable", "deprecated"] as const;
export type OkfStatus = (typeof OKF_STATUSES)[number];

// The v0.2 concept type for a sanctioned computation. Agents may fill declared
// parameters at call time but must never edit the computation itself. Import
// flags these docs in a warning so an operator can grant `tier: source` via
// vault_set_tier — it never auto-elevates, because a foreign bundle's
// self-declared type is not an authorization for write-protection enforcement.
export const OKF_ATTESTED_COMPUTATION_TYPE = "Attested Computation";

// Prefix under which import preserves foreign OKF fields that have no lossless
// Daftari mapping (the trust record, attestation machinery, and any unknown
// producer-defined fields). Keeps the import non-destructive, mirroring what
// the `daftari` sidecar does in the export direction.
export const OKF_PRESERVED_PREFIX = "okf_";
