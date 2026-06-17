// Shadow-aware wrappers around observeEdge / contestEdge for the consolidation
// loop (spec §5.3, brief item 5). When the vault runs `shadow_mode: true`,
// these factories route edge writes through `recordShadowAction` so the
// calibration log gains records but `.daftari/edges.jsonl` is untouched.
// When shadow is off, they fall through to the live store.
//
// The CLI (chunk 5) is the ONLY caller — birth.ts and revision.ts receive
// `observe` / `contest` via dependency injection and don't know which path
// they're on. That keeps the unit tests for those modules hermetic (no fs,
// no shadow config), and concentrates the live-vs-shadow branch here.

import {
  type ContestEdgeInput,
  contestEdge,
  type DerivesFromEdge,
  type ObserveEdgeInput,
  observeEdge,
} from "../curation/edges.js";
import { recordShadowAction } from "../curation/shadow.js";
import { ok, type Result } from "../frontmatter/types.js";

export interface EdgeWriteConfig {
  vaultRoot: string;
  shadowMode: boolean;
  // The authenticated server identity (spec §11.6). Optional because tests
  // and a non-RBAC vault may not set it; the live observe/contest tools don't
  // need it (provenance there comes from the caller-claimed `agent`).
  principal?: string;
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
    observations: 0,
    contestedAt: status === "revoked" ? at : null,
    contestReason,
  };
}

export function makeObserve(
  config: EdgeWriteConfig,
): (input: ObserveEdgeInput) => Promise<Result<DerivesFromEdge, Error>> {
  return async (input) => {
    if (!config.shadowMode) {
      return observeEdge(config.vaultRoot, input);
    }
    const shadowRes = await recordShadowAction(config.vaultRoot, {
      tool: "vault_edge_observe",
      action: "edge-observe",
      // targetPath drives the blast computation (downstream reach via reverse
      // link/source maps). The FROM doc is the right seed: strengthening
      // from→to could re-trigger anything downstream of `from`.
      targetPath: input.fromPath,
      touchedPaths: [input.fromPath, input.toPath],
      agent: input.observedBy,
      ...(config.principal ? { principal: config.principal } : {}),
      commitMessage: `[shadow] edge_observe ${input.fromPath} ← ${input.toPath}${input.note ? ` (${input.note})` : ""}`,
    });
    if (!shadowRes.ok) return shadowRes;
    return ok(stubEdge(input.fromPath, input.toPath, shadowRes.value.at, "candidate", null));
  };
}

export function makeContest(
  config: EdgeWriteConfig,
): (input: ContestEdgeInput) => Promise<Result<DerivesFromEdge, Error>> {
  return async (input) => {
    if (!config.shadowMode) {
      return contestEdge(config.vaultRoot, input);
    }
    const shadowRes = await recordShadowAction(config.vaultRoot, {
      tool: "vault_edge_contest",
      action: "edge-contest",
      targetPath: input.fromPath,
      touchedPaths: [input.fromPath, input.toPath],
      agent: input.contestedBy,
      ...(config.principal ? { principal: config.principal } : {}),
      commitMessage: `[shadow] edge_contest ${input.fromPath} ← ${input.toPath}: ${input.reason}`,
    });
    if (!shadowRes.ok) return shadowRes;
    return ok(stubEdge(input.fromPath, input.toPath, shadowRes.value.at, "revoked", input.reason));
  };
}
