// Pure position logic for multi-principal contested beliefs (Slice 1).
//
// One claim doc carries a positions[] set (frontmatter/types.ts). This module
// owns id allocation, supersession, the R-1 conflict rule (assert × dispute;
// qualify conflicts with nothing), the contested derivation, and the
// foreign-position guard rule (LD-13). No I/O: the tools layer feeds it
// parsed frontmatter and writes the result back.

import {
  CONFIDENCES,
  type Confidence,
  type Position,
  type Provenance,
  type Stance,
} from "../frontmatter/types.js";

// Assigns the next sequential pos-NNN id. Scans EVERY entry (live and
// superseded — ids are never reused) for the highest numeric suffix,
// mirroring nextTensionId (tension.ts:139–150).
export function nextPositionId(existing: Position[]): string {
  let max = 0;
  for (const p of existing) {
    const m = p.id.match(/^pos-(\d+)$/);
    if (!m) continue;
    const n = Number.parseInt(m[1] as string, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `pos-${String(max + 1).padStart(3, "0")}`;
}

export function unsuperseded(positions: Position[]): Position[] {
  return positions.filter((p) => p.superseded_by == null);
}

// R-1 (locked): contested ⇔ the live set holds ≥1 assert AND ≥1 dispute.
// Stance-enum-only — no statement-text comparison anywhere in daftari.
export function isContested(positions: Position[]): boolean {
  const live = unsuperseded(positions);
  return live.some((p) => p.stance === "assert") && live.some((p) => p.stance === "dispute");
}

// The conflict pairs a (new) position forms: it against each LIVE position of
// the opposing stance. qualify opposes nothing. Pair order is (existing,
// incoming) so tension claims read chronologically.
export function conflictPairs(
  incoming: Position,
  positions: Position[],
): Array<{ a: Position; b: Position }> {
  const opposite: Stance | null =
    incoming.stance === "assert" ? "dispute" : incoming.stance === "dispute" ? "assert" : null;
  if (opposite === null) return [];
  return unsuperseded(positions)
    .filter((p) => p.id !== incoming.id && p.stance === opposite)
    .map((p) => ({ a: p, b: incoming }));
}

// LD-11 ordering: confidence desc (high first), created desc, id asc.
export function comparePositions(a: Position, b: Position): number {
  const conf = CONFIDENCES.indexOf(b.confidence) - CONFIDENCES.indexOf(a.confidence);
  if (conf !== 0) return conf;
  if (a.created !== b.created) return a.created < b.created ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface AssertInput {
  principal: string;
  stance: Stance;
  statement: string | null;
  confidence: Confidence;
  provenance: Provenance;
  valid_from: string | null;
  sources: string[];
  created: string; // YYYY-MM-DD, stamped by the calling tool
}

export interface AssertOutcome {
  positions: Position[];
  newPosition: Position;
  superseded: Position | null;
}

// R-4: append the caller's new position; set THEIR prior live position's
// superseded_by to it. Never edits or deletes any other principal's entry;
// never mutates its inputs.
export function applyAssert(positions: Position[] | null, input: AssertInput): AssertOutcome {
  const existing = positions ?? [];
  const id = nextPositionId(existing);
  const newPosition: Position = {
    id,
    principal: input.principal,
    stance: input.stance,
    statement: input.statement,
    confidence: input.confidence,
    provenance: input.provenance,
    valid_from: input.valid_from,
    superseded_by: null,
    created: input.created,
    sources: input.sources,
  };
  let superseded: Position | null = null;
  const next = existing.map((p) => {
    if (p.principal === input.principal && p.superseded_by == null) {
      superseded = { ...p, superseded_by: id };
      return superseded;
    }
    return p;
  });
  return { positions: [...next, newPosition], newPosition, superseded };
}

// LD-13 / R-12: the foreign-position guard rule, shared by vault_write's
// direct update path and its propose-only stage preview. Returns a human
// description of the first violation, or null when the update is legal.
//
// Violations: an existing entry whose principal !== user is REMOVED or
// ALTERED. One carve-out: an alteration whose ONLY delta is
// superseded_by null → the id of an incoming entry held by the SAME
// principal as the altered entry — a self-supersession replayed by a
// ratifier (vault_ratify dispatches staged writes under the ratifier's
// access). Appending entries — own or foreign — is deliberately NOT a
// violation (R-12 scopes to mutate/remove; ratify replay appends the
// proposer's new entry under the ratifier's identity).
export function foreignPositionViolation(
  before: Position[],
  after: Position[] | null,
  user: string,
): string | null {
  const incoming = after ?? [];
  const byId = new Map(incoming.map((p) => [p.id, p]));
  for (const old of before) {
    if (old.principal === user) continue;
    const next = byId.get(old.id);
    if (!next) {
      return `update removes position ${old.id} held by '${old.principal}'`;
    }
    if (samePosition(old, next)) continue;
    const onlySupersededByChanged = samePosition(old, {
      ...next,
      superseded_by: old.superseded_by,
    });
    const successor = next.superseded_by != null ? byId.get(next.superseded_by) : undefined;
    if (
      onlySupersededByChanged &&
      old.superseded_by == null &&
      successor !== undefined &&
      successor.principal === old.principal
    ) {
      continue;
    }
    return `update alters position ${old.id} held by '${old.principal}'`;
  }
  return null;
}

function samePosition(a: Position, b: Position): boolean {
  return (
    a.id === b.id &&
    a.principal === b.principal &&
    a.stance === b.stance &&
    a.statement === b.statement &&
    a.confidence === b.confidence &&
    a.provenance === b.provenance &&
    a.valid_from === b.valid_from &&
    a.superseded_by === b.superseded_by &&
    a.created === b.created &&
    a.sources.length === b.sources.length &&
    a.sources.every((s, i) => s === b.sources[i])
  );
}
