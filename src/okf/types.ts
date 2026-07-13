// Open Knowledge Format (OKF) — shared constants and types.
//
// OKF is Google Cloud's vendor-neutral specification (v0.1) for the LLM-wiki
// pattern: a directory of markdown files with YAML frontmatter that any
// producer can emit and any consumer can read without translation. Daftari's
// vault *is* this pattern, so `daftari okf export|import` bridges the two.
//
// Spec essentials that this module implements:
//   - A concept doc is any non-reserved `.md` file with a frontmatter block.
//   - The single required frontmatter field is `type` (a free-form kind string).
//   - Recommended fields: title, description, resource, tags, timestamp.
//   - Reserved filenames: index.md (progressive-disclosure listing) and log.md
//     (chronological change history, newest first).
//   - Consumers must tolerate unknown fields and unknown `type` values.

// The OKF spec version this producer targets and this consumer understands.
// Written into the exported bundle's root index.md frontmatter (the spec's
// place for a bundle to declare its target version).
export const OKF_VERSION = "0.1";

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
// is the only required one; the rest are recommended and omitted when empty.
export const OKF_CORE_FIELDS = [
  "type",
  "title",
  "description",
  "resource",
  "tags",
  "timestamp",
] as const;
