// Independence-aware promotion — the would-be verdict, the shadow journal,
// and the needs-review tension body (2026-07-26 spec, Decisions 3-4).
//
// This module owns the SHADOW calibration surface only: `independenceVerdict`
// is pure math over evidence-class counts, `appendIndependenceShadow` /
// `listIndependenceShadow` manage the module's own per-collapse journal
// (`.daftari/independence-shadow.jsonl` — distinct from `shadow-actions.jsonl`,
// which coverage.ts already filters by action kind), and
// `needsReviewTensionInput` renders the class breakdown that surfaces to a
// human via the tension log — the needs-review outcome is NOT a staged
// action (ratifying one would dispatch nothing; see spec Decision 3).
//
// Wiring (src/consolidate/revision.ts, src/consolidate/index.ts) is a
// separate concern: this module has no I/O beyond its own journal file and no
// knowledge of the envelope, the panel loop, or config.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EDGE_INDEPENDENCE_RHO,
  EDGE_NEEDS_REVIEW_MIN_GAIN,
  FP_SENTINEL,
} from "../curation/edges.js";
import type { TensionInput } from "../curation/tension.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { CONSOLIDATE_AGENT } from "./constants.js";

export function independenceShadowPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "independence-shadow.jsonl");
}

// One row per revision panel, regardless of decision (including fails / tie /
// no-vote / gated — `wouldDecision: null` for those) so the calibration
// denominator (informative-panel rate, C5) is honest about every panel that
// ran, not just the ones that reached a verdict. `classes` is the PRE-panel
// class state (raw keys — this is a machine surface, unlike the tension
// body's human-readable rendering).
export interface IndependenceShadowRow {
  at: string;
  fromPath: string;
  toPath: string;
  kSurvived: number;
  kEff: number;
  strength: number;
  strengthIndependent: number;
  classes: Array<{ key: string; count: number }>;
  panelClassKeys: string[];
  marginalGain: number;
  wouldDecision: "would_accrue" | "would_needs_review" | null;
}

// Pure: applies the surviving votes' class keys sequentially against a copy
// of `preClasses` — the j-th occurrence within a class adds
// EDGE_INDEPENDENCE_RHO ** (occurrences already counted, pre- or within-panel)
// — and sums the marginal k_eff gain. `would_needs_review` iff that gain is
// STRICTLY below EDGE_NEEDS_REVIEW_MIN_GAIN (the boundary — a second vote in
// a count-1 class, gain exactly 0.5 — accrues).
export function independenceVerdict(
  preClasses: Map<string, number>,
  survivingClassKeys: string[],
): { marginalGain: number; wouldDecision: "would_accrue" | "would_needs_review" } {
  const working = new Map(preClasses);
  let marginalGain = 0;
  for (const key of survivingClassKeys) {
    const priorCount = working.get(key) ?? 0;
    marginalGain += EDGE_INDEPENDENCE_RHO ** priorCount;
    working.set(key, priorCount + 1);
  }
  const wouldDecision =
    marginalGain < EDGE_NEEDS_REVIEW_MIN_GAIN ? "would_needs_review" : "would_accrue";
  return { marginalGain, wouldDecision };
}

export async function appendIndependenceShadow(
  vaultRoot: string,
  row: IndependenceShadowRow,
): Promise<Result<void, Error>> {
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    appendFileSync(independenceShadowPath(vaultRoot), `${JSON.stringify(row)}\n`);
    return ok(undefined);
  } catch (e) {
    return err(
      new Error(
        `cannot record independence shadow row: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}

export async function listIndependenceShadow(
  vaultRoot: string,
): Promise<Result<IndependenceShadowRow[], Error>> {
  let raw: string;
  try {
    raw = readFileSync(independenceShadowPath(vaultRoot), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    return err(
      new Error(
        `cannot read independence shadow log: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
  const rows: IndependenceShadowRow[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as IndependenceShadowRow;
      if (
        typeof rec.at === "string" &&
        typeof rec.fromPath === "string" &&
        typeof rec.toPath === "string"
      ) {
        rows.push(rec);
      }
    } catch {
      // Skip a corrupt line; the log is append-only and best-effort.
    }
  }
  return ok(rows);
}

// --- the needs-review tension body (C6) --------------------------------

// Decodes one `evidenceClassKey` output (`${inputs}\n${principal}\n${model}`,
// src/curation/edges.ts) back into its three components, `∅` → null.
function decodeClassKey(key: string): {
  inputs: string | null;
  principal: string | null;
  model: string | null;
} {
  const [inputs, principal, model] = key.split("\n");
  return {
    inputs: inputs === FP_SENTINEL || inputs === undefined ? null : inputs,
    principal: principal === FP_SENTINEL || principal === undefined ? null : principal,
    model: model === FP_SENTINEL || model === undefined ? null : model,
  };
}

// Structured class descriptor for the tension body — one per equivalence
// class the edge's CURRENT trail carries, sorted by key for a deterministic,
// reviewable rendering.
export function classesForTension(
  classCounts: Map<string, number>,
): Array<{ inputs: string | null; principal: string | null; model: string | null; count: number }> {
  return [...classCounts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, count]) => ({ ...decodeClassKey(key), count }));
}

// Renders the needs-review interpretive tension (Decision 3). `classes` is a
// STRUCTURED breakdown (never raw `\n`-joined keys, which would break
// tensions.md's line-oriented round-trip — C6) — build it with
// `classesForTension` over the edge's current evidence classes. `claimA` is
// guaranteed single-line: `N classes over M counted votes — class 1 ×c₁:
// model=<id>, principal=<id>, inputs=<12-hex prefix>; …`, with `∅`
// components rendered `unfingerprinted`.
export function needsReviewTensionInput(
  fromPath: string,
  toPath: string,
  classes: Array<{
    inputs: string | null;
    principal: string | null;
    model: string | null;
    count: number;
  }>,
): TensionInput {
  const totalVotes = classes.reduce((n, c) => n + c.count, 0);
  const parts = classes.map((c, i) => {
    const model = c.model ?? "unfingerprinted";
    const principal = c.principal ?? "unfingerprinted";
    const inputs = c.inputs ? c.inputs.slice(0, 12) : "unfingerprinted";
    return `class ${i + 1} ×${c.count}: model=${model}, principal=${principal}, inputs=${inputs}`;
  });
  const claimA = `${classes.length} classes over ${totalVotes} counted votes — ${parts.join("; ")}`;
  return {
    title: `correlated-only survival: ${fromPath} derives_from ${toPath}`,
    kind: "interpretive",
    sourceA: fromPath,
    claimA,
    sourceB: toPath,
    claimB:
      "survives re-derivation only on already-counted evidence; supply an independent " +
      "re-derivation (vault_edge_observe with a fresh fingerprint) or contest the edge, " +
      "then resolve",
    loggedBy: CONSOLIDATE_AGENT,
  };
}
