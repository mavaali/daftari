// Canon resolver types — the belief layer output contract.
//
// A CanonResult is always pure data: no I/O, no side effects. The orchestrator
// (Task 4) loads documents and passes them in; this module only defines shapes.
// CanonFlags carries orchestrator-computed provenance inputs (partial_visibility,
// hidden_tension_count, unindexed) so callers can attach them without the
// resolver needing to know where they came from.

export interface CanonDoc {
  path: string;
  holder: string; // stamped identity string (pre-resolution)
  valid_from: string | null;
  valid_until: string | null;
  updated: string; // server-stamped record clock
  collection: string;
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
  ghost_holder_warning?: { count: number; strings: string[] };
}

export interface CanonResult {
  settled: SettledClaim[];
  contested: ContestedTrajectory[];
  flags: CanonFlags;
}
