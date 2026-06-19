// Shadow-aware wrappers around observeEdge / contestEdge for the consolidation
// loop (spec §5.3, brief item 5). When the vault runs `shadow_mode: true`,
// these factories return a synthetic stub edge and touch NOTHING — no edge
// store, no journal. When shadow is off, they fall through to the live store.
//
// Journaling used to live here (recordShadowAction). It moved out (Stage 3,
// decision D6): the calibration journal is now written by the CLI's admit
// wrapper, which owns the envelope's budget accounting. The loop must NOT
// advance the shared spentByVault, so edge-write must not record an action
// the way the live MCP tools do.
//
// The CLI is the ONLY caller — birth.ts and revision.ts receive `observe` /
// `contest` via dependency injection and don't know which path they're on.
// That keeps the unit tests for those modules hermetic (no fs, no shadow
// config), and concentrates the live-vs-shadow branch here.

import {
  type ContestEdgeInput,
  contestEdge,
  type DerivesFromEdge,
  type ObserveEdgeInput,
  observeEdge,
} from "../curation/edges.js";
import { ok, type Result } from "../frontmatter/types.js";

export interface EdgeWriteConfig {
  vaultRoot: string;
  shadowMode: boolean;
}

// In shadow mode we return a synthetic DerivesFromEdge so the caller's
// success/error branch (which only checks `ok` + counts) works the same.
// The fields are deliberately neutral: no real state advanced.
function stubEdge(
  fromPath: string,
  toPath: string,
  at: string,
  status: "candidate" | "revoked",
  contestReason: string | null,
): DerivesFromEdge {
  return {
    fromPath,
    toPath,
    strength: 0,
    kSurvived: 0,
    firstObserved: at,
    lastRederived: at,
    status,
    directionVerdict: "directed",
    observations: 0,
    contestedAt: status === "revoked" ? at : null,
    contestReason,
  };
}

// Shadow-mode timestamp for the synthetic stub. Matches the edge store's
// second-resolution ISO format so the stub is shape-compatible.
function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function makeObserve(
  config: EdgeWriteConfig,
): (input: ObserveEdgeInput) => Promise<Result<DerivesFromEdge, Error>> {
  return async (input) => {
    if (!config.shadowMode) {
      return observeEdge(config.vaultRoot, input);
    }
    // Shadow mode: advance nothing. Return the stub so the caller's success
    // branch (which keys on `ok` + counts, not the row contents) is satisfied.
    return ok(stubEdge(input.fromPath, input.toPath, nowIso(), "candidate", null));
  };
}

export function makeContest(
  config: EdgeWriteConfig,
): (input: ContestEdgeInput) => Promise<Result<DerivesFromEdge, Error>> {
  return async (input) => {
    if (!config.shadowMode) {
      return contestEdge(config.vaultRoot, input);
    }
    return ok(stubEdge(input.fromPath, input.toPath, nowIso(), "revoked", input.reason));
  };
}
