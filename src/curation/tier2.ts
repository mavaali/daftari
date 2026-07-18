// Tier 2 of tiered compatibility checking (#232) — the semantic residual,
// as a QUEUE the server prepares and a VERDICT the server records. The
// expensive judge itself is the CALLING AGENT: daftari has no LLM, by
// design. The pattern is the same as earned edges (observeEdge) and
// tension logging (vault_tension_log) — agents do the semantic work,
// the server types it, stores it, and derives consequences.
//
// The queue IS #234's pending-unchecked staleness class, minus pairs a
// recorded verdict already covers: declared and earned edges whose upstream
// changed but whose compatibility structure cannot decide — exactly what
// the through-line spec routes to "the expensive judges". Compiled edges
// never queue (tier 1 decides them mechanically, and a semantic opinion
// must not override mechanical certainty).
//
// Constrained input, per the #232 issue: not "do these two documents
// conflict" but (unit, dependent, edge class, per-field before/after since
// the edge's baseline, the dependent's usage span) — a specific claim
// against a specific usage. Output is typed per the existing tension
// taxonomy: a `broken` verdict names a LoggableTensionKind and is logged
// as a real tension through addTension; `still-valid` records the
// certified-compatible judgment.
//
// The verdict store (.daftari/tier2-verdicts.jsonl) is append-only local
// state, git-ignored — the tension log is the durable, caller-visible
// artifact of a break; the verdict log is what keeps the queue honest.
// Verdicts, unlike tier-1 classes, MUST be stored: they are expensive LLM
// judgments that cannot be recomputed at query time. Staleness protects
// them from going stale: a verdict covers a pair only up to the unit
// change it judged (judged_change_ts); a newer landed write to the unit
// re-queues the pair automatically.

import { mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import type { ProvenanceEntry } from "./provenance.js";
import type { LoggableTensionKind } from "./tension.js";
import type { Tier1EdgeClass } from "./tier1.js";

// Sentinel change timestamp for a unit with no provenance history at all: a
// verdict on such a pair judges "the dependency as it stands", and any
// later landed write to the unit (whose real timestamp is necessarily
// greater) re-queues it.
export const NO_CHANGE_TS = "1970-01-01T00:00:00.000Z";

export const TIER2_VERDICT_KINDS = ["still-valid", "broken"] as const;
export type Tier2VerdictKind = (typeof TIER2_VERDICT_KINDS)[number];

export interface Tier2Verdict {
  timestamp: string; // ISO 8601 — when the verdict was recorded
  artifact: string; // the dependent that was judged
  unit: string; // the changed upstream it was judged against
  edge_class: Exclude<Tier1EdgeClass, "compiled">; // only the residual queues
  // The unit's latest landed-write timestamp AT JUDGMENT TIME — the change
  // the judge actually saw. A later write to the unit makes this verdict
  // stale and the pair re-queues.
  judged_change_ts: string;
  verdict: Tier2VerdictKind;
  // Set on `broken`: the tension taxonomy kind and the id of the tension
  // that was logged for it.
  tension_kind?: LoggableTensionKind;
  tension_id?: string;
  reasoning: string;
  agent: string; // the judging agent's self-identification
  principal?: string; // the authenticated identity, when present (§11.6)
  run_id?: string;
}

export function tier2VerdictsPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "tier2-verdicts.jsonl");
}

export async function recordTier2Verdict(
  vaultRoot: string,
  entry: Omit<Tier2Verdict, "timestamp"> & { timestamp?: string },
): Promise<Result<Tier2Verdict, Error>> {
  const full: Tier2Verdict = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    artifact: entry.artifact,
    unit: entry.unit,
    edge_class: entry.edge_class,
    judged_change_ts: entry.judged_change_ts,
    verdict: entry.verdict,
    ...(entry.tension_kind ? { tension_kind: entry.tension_kind } : {}),
    ...(entry.tension_id ? { tension_id: entry.tension_id } : {}),
    reasoning: entry.reasoning,
    agent: entry.agent,
    ...(entry.principal ? { principal: entry.principal } : {}),
    ...(entry.run_id ? { run_id: entry.run_id } : {}),
  };
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    await appendFile(tier2VerdictsPath(vaultRoot), `${JSON.stringify(full)}\n`);
    return ok(full);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot append tier-2 verdict: ${reason}`));
  }
}

// Oldest first; missing log is empty; corrupt lines skipped.
export async function readTier2Verdicts(vaultRoot: string): Promise<Result<Tier2Verdict[], Error>> {
  let raw: string;
  try {
    raw = await readFile(tier2VerdictsPath(vaultRoot), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read tier-2 verdicts: ${reason}`));
  }
  const entries: Tier2Verdict[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Tier2Verdict;
      if (typeof parsed.artifact === "string" && typeof parsed.unit === "string") {
        entries.push(parsed);
      }
    } catch {
      // Skip a corrupt line; the log is append-only and best-effort.
    }
  }
  return ok(entries);
}

// The unit's latest landed content write — the change identity a verdict
// judges. Null when the unit has no provenance at all.
export function latestUnitChangeTs(provenance: ProvenanceEntry[], unit: string): string | null {
  let latest: string | null = null;
  for (const e of provenance) {
    if (e.file !== unit || e.action === "rejected_stale") continue;
    if (latest === null || e.timestamp > latest) latest = e.timestamp;
  }
  return latest;
}

// The verdict currently in force for a pair, if any: the newest recorded
// verdict whose judged_change_ts is not older than the unit's latest landed
// write. An older judgment (the unit changed again) covers nothing.
export function coveringVerdict(
  verdicts: Tier2Verdict[],
  input: { artifact: string; unit: string; edgeClass: Tier1EdgeClass; latestChangeTs: string },
): Tier2Verdict | null {
  let found: Tier2Verdict | null = null;
  for (const v of verdicts) {
    if (v.artifact !== input.artifact || v.unit !== input.unit) continue;
    if (v.edge_class !== input.edgeClass) continue;
    if (v.judged_change_ts < input.latestChangeTs) continue; // stale judgment
    if (found === null || v.timestamp > found.timestamp) found = v;
  }
  return found;
}

// Per-field before/after accumulated across the unit's landed writes since
// the baseline: the FIRST diff's before joined to the LAST diff's after —
// the net change the judge should see, not each intermediate hop. `body`
// has no stored before/after (the provenance log records only the flag);
// it appears with nulls and the tool ships the current body alongside.
export interface FieldChange {
  before: unknown;
  after: unknown;
}

export function accumulateFieldChanges(
  provenance: ProvenanceEntry[],
  unit: string,
  baseline: string,
): Record<string, FieldChange> {
  const changes: Record<string, FieldChange> = {};
  let bodyChanged = false;
  for (const e of provenance) {
    if (e.file !== unit || e.action === "rejected_stale" || e.timestamp <= baseline) continue;
    for (const [field, diff] of Object.entries(e.frontmatter_diff ?? {})) {
      const existing = changes[field];
      if (existing) existing.after = diff.after;
      else changes[field] = { before: diff.before, after: diff.after };
    }
    if (e.body_changed ?? (e.action === "create" || e.action === "update" || e.action === "append"))
      bodyChanged = true;
  }
  if (bodyChanged) changes.body = { before: null, after: null };
  return changes;
}

// Best-effort usage-span extraction: the lines of the dependent's body that
// mention the unit (by path, basename, or title), each with one line of
// context, capped. Null when nothing matches — the judge then reads the
// dependent in full via vault_read.
export function extractUsageSpan(
  artifactBody: string,
  unit: { path: string; title?: string },
): string | null {
  const needles = [unit.path, unit.path.split("/").pop() ?? "", unit.title ?? ""]
    .map((n) => n.trim().toLowerCase())
    .filter((n) => n.length > 2);
  if (needles.length === 0) return null;
  const lines = artifactBody.split("\n");
  const keep = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i]?.toLowerCase() ?? "";
    if (needles.some((n) => lower.includes(n))) {
      for (const j of [i - 1, i, i + 1]) {
        if (j >= 0 && j < lines.length) keep.add(j);
      }
    }
  }
  if (keep.size === 0) return null;
  const ordered = [...keep].sort((a, b) => a - b);
  const parts: string[] = [];
  let prev = -2;
  for (const i of ordered) {
    if (i > prev + 1 && parts.length > 0) parts.push("…");
    parts.push(lines[i] ?? "");
    prev = i;
  }
  const span = parts.join("\n");
  return span.length > 1200 ? `${span.slice(0, 1200)}…` : span;
}
