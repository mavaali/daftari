// Types for `daftari backfill` (§11.1) — git-driven frontmatter migration.
//
// The plan is the staging surface: a `--plan` run derives proposed frontmatter
// for every non-conformant doc and writes one PlanEntry per line to
// .daftari/backfill-plan.jsonl. A later `--apply --scope <folder>` reads the
// plan back and writes the proposals under that folder only. The plan format
// is intentionally minimal and separate from the general-purpose staging queue
// (§11.2) so backfill does not block on it.

import type { Frontmatter } from "../frontmatter/types.js";

// One frontmatter field-name collision (#116): a present field whose name is a
// built-in ENUM field but whose value is outside that field's enum — foreign
// vocabulary that backfill must not launder into a Daftari default.
export interface Collision {
  field: string; // built-in enum field name, e.g. "status"
  value: string; // the author's value, stringified for display
  expected: readonly string[]; // the built-in enum, e.g. STATUSES
}

// Per-field record of HOW each proposed value was arrived at, surfaced in the
// plan and on stdout so a human ratifying a folder can see what is preserved
// from existing frontmatter versus derived. Values are short source labels,
// e.g. "preserved", "git-first-commit", "parent-folder", "default".
export type DerivationMap = Record<string, string>;

// One document the plan proposes to backfill. Conformant docs (those whose
// existing frontmatter already validates) produce no entry.
export interface PlanEntry {
  // Vault-relative POSIX path of the markdown file.
  path: string;
  // The document's current frontmatter exactly as parsed from YAML — `{}` for
  // a frontmatter-less doc.
  current: Record<string, unknown>;
  // The full frontmatter the apply step will write: derived defaults with every
  // currently-present field preserved.
  proposed: Frontmatter;
  // Per-field provenance of `proposed`.
  derivation: DerivationMap;
  // First path component — the folder this entry is ratified under. `--apply
  // --scope <folder>` writes only entries whose scope matches.
  scope: string;
  // Field-name collisions on this doc (#116): present built-in fields whose
  // value is foreign vocabulary. Empty when none.
  collisions: Collision[];
}

// Whether a document needs backfilling, and how much.
//   conformant — existing frontmatter already validates; no plan entry
//   partial    — some frontmatter present, missing fields filled
//   missing    — no frontmatter at all
export type DocClassification = "conformant" | "partial" | "missing";

// Stdout summary of a `--plan` run.
export interface BackfillSummary {
  missing: number;
  partial: number;
  conformant: number;
  // Docs skipped because they sit at the vault root with no collection folder
  // (collection is derived from the first path component). Backfill is
  // folder-scoped, so these are not addressable by `--apply --scope`.
  rootSkipped: number;
  // Per-folder (scope) count of entries written to the plan.
  byScope: Record<string, number>;
  // Total entries written (missing + partial).
  planned: number;
}
