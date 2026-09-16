// Federation tool classification (#297, spec 2026-08-15, Decision 5).
//
// The federated tools are a CLOSED allowlist; every other registered tool
// refuses an alias-prefixed target with exactly one of two uniform error
// strings. The classification is exhaustive and mutually exclusive — no
// wildcards — and enforced structurally: the registry guard test
// (test/federation/classification.test.ts) walks the tool registry and fails
// if any tool is neither allowlisted nor assigned a refusal class, so a new
// tool cannot ship with undefined federated-path behavior.
//
// Write locks and anchor/pin/repin are not separately registered tools —
// they are sub-operations of the write tools below, covered because their
// host tools refuse first.

import type { FederatedPath, MountRegistry } from "./mounts.js";
import { parseFederatedPath } from "./mounts.js";

// The six tools that understand `alias:path` addressing in v1. vault_search /
// vault_search_related / vault_index / vault_reindex acquire their federated
// behavior with the per-mount index (follow-up slice); being allowlisted
// here means the server layer does not refuse for them.
export const FEDERATED_TOOLS: ReadonlySet<string> = new Set([
  "vault_search",
  "vault_search_related",
  "vault_read",
  "vault_index",
  "vault_status",
  "vault_reindex",
]);

// Anything that mutates documents, vault state, or records a verdict.
// vault_tier2_verdict records verdicts and can log tensions — write-shaped
// despite the read-sounding name.
export const WRITE_SHAPED_TOOLS: ReadonlySet<string> = new Set([
  "vault_write",
  "vault_append",
  "vault_promote",
  "vault_deprecate",
  "vault_supersede",
  "vault_merge",
  "vault_set_confidence",
  "vault_set_tier",
  "vault_assert",
  "vault_consolidate",
  "vault_stage_action",
  "vault_ratify",
  "vault_tension_log",
  "vault_tension_resolve",
  "vault_edge_observe",
  "vault_edge_contest",
  "vault_tier2_verdict",
  "vault_board_dispose",
  "vault_board_resolve",
]);

// Anything that reads the referenced `.daftari/` state or curation/graph
// surfaces rather than documents. The v1 boundary: a mount exposes documents,
// not vault state.
export const STATE_READ_TOOLS: ReadonlySet<string> = new Set([
  "vault_provenance",
  "vault_edges",
  "vault_tension_clusters",
  "vault_tension_blast",
  "vault_tension_triage",
  "vault_positions",
  "vault_backlinks",
  "vault_themes",
  "vault_lint",
  "vault_canon",
  "vault_consumes",
  "vault_receipt",
  "vault_staleness",
  "vault_witness",
  "vault_tier1",
  "vault_tier2_queue",
  "vault_board_list",
]);

// The two uniform error strings. The copy is load-bearing (spec Decision 5).
export function readOnlyRefusal(path: string): string {
  return `federated mount is read-only: "${path}" — writes apply only to the local vault`;
}

export const STATE_REFUSAL =
  "vault state (tensions, edges, provenance, positions, curation and graph " +
  "surfaces) is not federated in v1 — mounts expose documents only";

// The refusal message for a non-allowlisted tool handed a federated path, or
// null for allowlisted tools (their handlers dispatch the path themselves).
export function federatedRefusal(toolName: string, path: string): string | null {
  if (FEDERATED_TOOLS.has(toolName)) return null;
  if (WRITE_SHAPED_TOOLS.has(toolName)) return readOnlyRefusal(path);
  return STATE_REFUSAL;
}

// Path-bearing argument keys, by convention across the registry: `path`,
// `*_path`, `paths`, `*_paths`, plus the edge tools' `from` / `to` and the
// tension tools' `source_a` / `source_b`. The scan runs only over these keys
// so content-bearing strings (a body that happens to start with
// "research: …") can never false-positive.
const PATH_KEY = /(^|_)paths?$/;
const EXTRA_PATH_KEYS: ReadonlySet<string> = new Set(["from", "to", "source_a", "source_b"]);

function isPathKey(key: string): boolean {
  return PATH_KEY.test(key) || EXTRA_PATH_KEYS.has(key);
}

// Finds the first alias-prefixed path among a call's path-bearing arguments.
// This single server-layer scan is both the refusal surface (uniform copy)
// and the write-time collision guard: a write tool can never create a
// canonical file at an alias-shadowing path because the path cannot even be
// addressed (vault_write's create branch and vault_merge's target_path both
// arrive through path-bearing keys).
export function scanArgsForFederatedPath(
  args: Record<string, unknown>,
  registry: MountRegistry,
): FederatedPath | null {
  for (const [key, value] of Object.entries(args)) {
    if (!isPathKey(key)) continue;
    if (typeof value === "string") {
      const fed = parseFederatedPath(value, registry);
      if (fed) return fed;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item !== "string") continue;
        const fed = parseFederatedPath(item, registry);
        if (fed) return fed;
      }
    }
  }
  return null;
}
