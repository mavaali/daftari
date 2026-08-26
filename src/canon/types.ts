// Canon resolver types — the belief layer output contract.
//
// A CanonResult is always pure data: no I/O, no side effects. The orchestrator
// (Task 4) loads documents and passes them in; this module only defines shapes.
// CanonFlags carries orchestrator-computed provenance inputs (partial_visibility,
// hidden_tension_count, unindexed) so callers can attach them without the
// resolver needing to know where they came from.

import type { GhostHolderWarning } from "../holders/types.js";

export interface CanonDoc {
  path: string;
  holder: string; // stamped identity string (pre-resolution)
  valid_from: string | null;
  valid_until: string | null;
  updated: string; // server-stamped record clock
  collection: string;
  // 6mf.3: the reader fingerprint that authored this belief, read from the
  // doc's raw frontmatter (reader_model + the `readers` parentage set). Both
  // OPTIONAL — undefined for docs (legacy or human-authored) with no reader
  // fields. Lets canon report which reader authored a canonized belief.
  readerModel?: string;
  readers?: string[];
  // 6mf.4 R9: append-only reader lineage entries, one per read op.
  // Optional — absent for docs with no reader_lineage field.
  readerLineage?: string[];
}

export interface SettledClaim {
  holder: string;
  citations: string[];
}

export interface TrajectoryNode {
  holder: string;
  path: string;
  valid_from: string | null;
  updated: string;
}

export interface ContestedTrajectory {
  trajectory: TrajectoryNode[];
  hint_ordering: "by_valid_from";
}

export interface CanonFlags {
  graph_completeness: "curated";
  partial_visibility: boolean;
  hidden_tension_count: number;
  unindexed: boolean;
  unindexed_paths: string[];
  ghost_holder_warning?: GhostHolderWarning;
}

export interface CanonResult {
  settled: SettledClaim[];
  contested: ContestedTrajectory[];
  flags: CanonFlags;
}
