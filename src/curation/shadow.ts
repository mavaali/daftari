// Shadow-mode execution path (spec §11.5) — compute-but-don't-write.
//
// When a vault runs with `shadow_mode: true`, the doc-write tools compute
// everything a live write would (validation, RBAC, the new frontmatter, the
// diff, the commit message), then instead of touching disk they log the
// would-be do() here and return a shadow-flagged result. This is the
// calibration posture Decision 3 (§10.4) requires: the I-table and the trust
// budget get real data from day one WITHOUT acting in production.
//
// Store: .daftari/shadow-actions.jsonl — append-only, one JSON record per
// intercepted write, the same local-advisory posture as the staged-action and
// edge logs (git-ignored; never vault content).
//
// The numbers (§10.4, ALL PROVISIONAL — they are the thing being calibrated):
//
//   impact  I  = min(i_base + K_BLAST · (blast − 1)^1.5, 1)
//     - i_base per action type (table below) — the action's intrinsic weight
//     - blast = 1 + downstream docs reachable from the target through the
//       reverse link/source maps (the tension-blast engine). Convex (α = 1.5):
//       linear scaling under-prices high-blast actions.
//
//   budget  B₀ = min(B0_BASE + B0_PER_PENDING · pendingStagedActions,
//                    max(1, ln(docCount)))
//     - a vault-state function, not a constant: proportional to ratification
//       queue depth with a log(N) ceiling.
//
//   would_gate = spent_before + I > B₀
//     - `spent` is the §3.7 monotonic per-session budget scalar, shadow-only:
//       it accumulates per process per vault and records where exhaustion
//       WOULD have checkpointed the pass. It keeps accumulating past the
//       budget so the log shows everything after the would-be checkpoint as
//       gated, which is exactly the calibration signal.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { FrontmatterDiff } from "./provenance.js";
import { listStagedActions } from "./staged-actions.js";
import { buildReverseLinkMap, buildReverseSourceMap, computeBlast } from "./tension-blast.js";
import { loadDocuments } from "./vault-docs.js";

// --- calibration constants (provisional — §10.4; exported for the loop) -----

// Intrinsic impact per write action. A starting table to calibrate against,
// not a claim: shadow mode exists to find out where these are wrong.
export const SHADOW_I_BASE: Record<string, number> = {
  create: 0.1,
  append: 0.15,
  update: 0.2,
  "confidence-set": 0.2,
  promote: 0.3,
  deprecate: 0.4,
  supersede: 0.4,
  merge: 0.6,
};

// Convex blast scaling: I grows with (blast − 1)^1.5.
export const SHADOW_K_BLAST = 0.05;
export const SHADOW_BLAST_ALPHA = 1.5;

// Budget B₀ = min(base + per_pending · queueDepth, max(1, ln(N))).
export const SHADOW_B0_BASE = 0.5;
export const SHADOW_B0_PER_PENDING = 0.25;

export function shadowActionsPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "shadow-actions.jsonl");
}

// --- record shape ------------------------------------------------------------

export interface ShadowActionRecord {
  at: string;
  tool: string;
  action: string;
  // The written/target path; merge lists all touched paths.
  target_path: string;
  touched_paths?: string[];
  agent: string;
  i_base: number;
  blast: number;
  impact: number;
  budget: number;
  spent_before: number;
  would_gate: boolean;
  frontmatter_diff?: FrontmatterDiff;
  commit_message: string;
}

// --- impact / budget math ------------------------------------------------------

export function shadowImpact(action: string, blast: number): number {
  const iBase = SHADOW_I_BASE[action] ?? 0.2;
  const b = Math.max(1, blast);
  return Math.min(iBase + SHADOW_K_BLAST * (b - 1) ** SHADOW_BLAST_ALPHA, 1);
}

export function shadowBudget(pendingStagedActions: number, docCount: number): number {
  const ceiling = Math.max(1, Math.log(Math.max(1, docCount)));
  return Math.min(SHADOW_B0_BASE + SHADOW_B0_PER_PENDING * pendingStagedActions, ceiling);
}

// Canonical vault-relative form of a seed path. The reverse maps are keyed by
// the relPaths loadDocuments walked, so an aliased caller path (`./pricing/a.md`)
// would silently miss every key and under-count blast to 1 — the same aliasing
// class the merge and edge tools canonicalize against.
function canonicalSeed(vaultRoot: string, relPath: string): string {
  return relative(resolve(vaultRoot), resolve(vaultRoot, relPath.trim()));
}

// Downstream reach of the seed paths through reverse links + sources: how many
// other docs a change here could invalidate. 1 (the doc itself) + unique
// downstream entries (computeBlast never returns a seed as its own downstream).
// One full-vault doc load per shadowed write — shadow mode is a calibration
// posture, not a hot path.
function shadowBlastFromDocs(
  vaultRoot: string,
  seeds: string[],
  docs: Parameters<typeof buildReverseSourceMap>[0],
): number {
  const blast = computeBlast({
    seeds: seeds.map((s) => canonicalSeed(vaultRoot, s)),
    reverseSource: buildReverseSourceMap(docs),
    reverseLink: buildReverseLinkMap(docs),
  });
  return 1 + blast.downstream.length;
}

// --- per-process session spend (§3.7, shadow-only) ---------------------------
//
// A "session" here is the process lifetime — a coarse stand-in for §3.7's
// per-consolidation-session scalar until the loop exists to define real
// session boundaries. Under a long-lived server the spend is monotone while
// B₀ is ln(N)-capped, so the gated fraction saturates over a long calibration
// window; every record stores `spent_before` and `budget`, so sessions can be
// re-segmented offline when reading the calibration data. A session-boundary
// mechanism (idle-gap reset / loop-session reset) lands with the loop.

const spentByVault = new Map<string, number>();

export function shadowSpent(vaultRoot: string): number {
  return spentByVault.get(vaultRoot) ?? 0;
}

// Test hook: a "session" is the process lifetime; tests need fresh sessions.
export function resetShadowSession(vaultRoot: string): void {
  spentByVault.delete(vaultRoot);
}

// --- record / read ------------------------------------------------------------

export interface ShadowWriteInput {
  tool: string;
  action: string;
  targetPath: string;
  // All paths the write would touch (merge passes three); blast seeds.
  touchedPaths?: string[];
  agent: string;
  frontmatterDiff?: FrontmatterDiff;
  commitMessage: string;
}

// Computes blast/impact/budget for a would-be write, appends the shadow
// record, advances the session spend, and returns the record. This is the
// single entry point the write tools call when shadow mode is on.
export async function recordShadowAction(
  vaultRoot: string,
  input: ShadowWriteInput,
): Promise<Result<ShadowActionRecord, Error>> {
  const seeds =
    input.touchedPaths && input.touchedPaths.length > 0 ? input.touchedPaths : [input.targetPath];

  const docs = await loadDocuments(vaultRoot);
  if (!docs.ok) return docs;
  const blastValue = shadowBlastFromDocs(vaultRoot, seeds, docs.value);

  // Queue depth counts only LIVE pending actions: the expiry sweep runs inside
  // vault_lint, so between lints the raw pending list can carry TTL-dead
  // entries that would inflate B₀.
  const pending = await listStagedActions(vaultRoot, "pending");
  if (!pending.ok) return pending;
  const nowMs = Date.now();
  const livePending = pending.value.filter((a) => Date.parse(a.expiresAt) > nowMs).length;

  const impact = shadowImpact(input.action, blastValue);
  const budget = shadowBudget(livePending, docs.value.length);
  const spentBefore = shadowSpent(vaultRoot);

  const record: ShadowActionRecord = {
    at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    tool: input.tool,
    action: input.action,
    target_path: input.targetPath,
    ...(input.touchedPaths && input.touchedPaths.length > 0
      ? { touched_paths: input.touchedPaths }
      : {}),
    agent: input.agent,
    i_base: SHADOW_I_BASE[input.action] ?? 0.2,
    blast: blastValue,
    impact,
    budget,
    spent_before: spentBefore,
    would_gate: spentBefore + impact > budget,
    ...(input.frontmatterDiff && Object.keys(input.frontmatterDiff).length > 0
      ? { frontmatter_diff: input.frontmatterDiff }
      : {}),
    commit_message: input.commitMessage,
  };

  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    appendFileSync(shadowActionsPath(vaultRoot), `${JSON.stringify(record)}\n`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot record shadow action: ${reason}`));
  }

  spentByVault.set(vaultRoot, spentBefore + impact);
  return ok(record);
}

// Reads the shadow log back, oldest first. Missing log = nothing shadowed.
export async function listShadowActions(
  vaultRoot: string,
): Promise<Result<ShadowActionRecord[], Error>> {
  let raw: string;
  try {
    raw = readFileSync(shadowActionsPath(vaultRoot), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read shadow actions: ${reason}`));
  }
  const records: ShadowActionRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as ShadowActionRecord;
      if (typeof rec.at === "string" && typeof rec.action === "string") records.push(rec);
    } catch {
      // Skip a corrupt line; the log is append-only and best-effort.
    }
  }
  return ok(records);
}

// --- lint surface ("Would-have-gated actions") --------------------------------

export interface ShadowLintItem {
  at: string;
  tool: string;
  action: string;
  targetPath: string;
  agent: string;
  impact: number;
  budget: number;
}

export interface ShadowLintSummary {
  total: number;
  gated: number;
  // Most recent first; gated actions only — the section the operator reads.
  recentGated: ShadowLintItem[];
}

export const SHADOW_LINT_RECENT_LIMIT = 20;

export async function shadowLintSummary(
  vaultRoot: string,
): Promise<Result<ShadowLintSummary, Error>> {
  const all = await listShadowActions(vaultRoot);
  if (!all.ok) return all;
  const gated = all.value.filter((r) => r.would_gate);
  return ok({
    total: all.value.length,
    gated: gated.length,
    recentGated: gated
      .slice(-SHADOW_LINT_RECENT_LIMIT)
      .reverse()
      .map((r) => ({
        at: r.at,
        tool: r.tool,
        action: r.action,
        targetPath: r.target_path,
        agent: r.agent,
        impact: r.impact,
        budget: r.budget,
      })),
  });
}
