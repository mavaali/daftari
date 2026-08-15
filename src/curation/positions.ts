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
  type Frontmatter,
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

// U-12 / LD-22: system-authored snapshot of a legacy doc's prior belief,
// minted by the first vault_assert on a doc whose typed positions is null.
// `principal: "unknown"` is a reserved, unforgeable identity — the tools
// layer rejects any live caller from claiming it (C-2 guard 1). Pure, no I/O.
export function legacySnapshot(
  fm: Pick<Frontmatter, "confidence" | "provenance" | "valid_from" | "updated">,
): Position {
  return {
    id: "pos-000",
    principal: "unknown",
    stance: "assert",
    statement: null,
    confidence: fm.confidence,
    provenance: fm.provenance,
    valid_from: fm.valid_from,
    superseded_by: null,
    created: fm.updated,
    sources: [],
  };
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

// LD-18: the dissent a ratified org stance carries — ids of unsuperseded
// positions whose stance opposes the ratified one under the R-1 rule
// (assert<->dispute; qualify opposes nothing). Computed by vault_consolidate
// at ratify time, LD-11 ordered — never hand-supplied.
export function dissentIds(positions: Position[], stance: Stance): string[] {
  const opposite: Stance | null =
    stance === "assert" ? "dispute" : stance === "dispute" ? "assert" : null;
  if (opposite === null) return [];
  return unsuperseded(positions)
    .filter((p) => p.stance === opposite)
    .sort(comparePositions)
    .map((p) => p.id);
}

// Minimal structural view of a positional tension, so the tools and lint can
// share the predicates below without importing the tension module.
export interface PositionalTensionRef {
  id?: string;
  resolved: boolean;
  resolutionKind?: string;
  positionA: string;
  positionB: string;
}

// Follow a position's self-supersession chain to its unsuperseded end.
// Sound because position supersession is always same-principal self-revision
// (applyAssert + the foreign-position guard). Returns null on an unknown id,
// a dangling link, or a cycle — corrupt shapes lint owns.
export function chainEnd(byId: Map<string, Position>, id: string): Position | null {
  let cur = byId.get(id);
  if (!cur) return null;
  const seen = new Set([cur.id]);
  while (cur.superseded_by) {
    const next = byId.get(cur.superseded_by);
    if (!next || seen.has(next.id)) return null;
    cur = next;
    seen.add(cur.id);
  }
  return cur;
}

// The open positional tensions a ratification at `stance` adjudicates: both
// chain ends resolve, exactly one end holds the ratified stance, and the
// OTHER end's id is in the server-computed dissent. Moot pairs (a flip made
// the ends same-stance or qualify) are deliberately NOT included — the
// ratification did not adjudicate them, and consolidate must only record
// what the ratification actually did.
export function qualifyingDissentTensions(
  positions: Position[],
  stance: Stance,
  dissent: string[],
  tensions: PositionalTensionRef[],
): string[] {
  const byId = new Map(positions.map((p) => [p.id, p]));
  const dissentSet = new Set(dissent);
  const out: string[] = [];
  for (const t of tensions) {
    if (t.resolved || t.id === undefined) continue;
    const ea = chainEnd(byId, t.positionA);
    const eb = chainEnd(byId, t.positionB);
    if (!ea || !eb) continue;
    const aligned = [ea, eb].filter((p) => p.stance === stance);
    if (aligned.length !== 1) continue;
    const other = ea.stance === stance ? eb : ea;
    if (dissentSet.has(other.id)) out.push(t.id);
  }
  return out;
}

// The live conflicting pairs (unsuperseded assert x dispute) with NO record:
// no open positional tension names the pair, and no resolution of kinds
// `accepted` (standing dissent the org chose to keep) or `consolidated`
// (adjudicated by a ratification) covers it. `corrected`/`superseded`/
// `invalid` resolutions predict the conflict dissolves — if both positions
// are still live and opposed, the pair is uncovered again. The recovery
// surface for vault_assert's silent tension_error.
export function uncoveredConflictPairs(
  positions: Position[],
  tensions: PositionalTensionRef[],
): Array<{ a: Position; b: Position; resolvedKinds: string[] }> {
  const live = unsuperseded(positions);
  const asserts = live.filter((p) => p.stance === "assert");
  const disputes = live.filter((p) => p.stance === "dispute");
  const covering = (a: string, b: string): PositionalTensionRef[] =>
    tensions.filter(
      (t) => (t.positionA === a && t.positionB === b) || (t.positionA === b && t.positionB === a),
    );
  const out: Array<{ a: Position; b: Position; resolvedKinds: string[] }> = [];
  for (const a of asserts) {
    for (const d of disputes) {
      const named = covering(a.id, d.id);
      const covered = named.some(
        (t) =>
          !t.resolved || t.resolutionKind === "accepted" || t.resolutionKind === "consolidated",
      );
      if (covered) continue;
      out.push({
        a,
        b: d,
        resolvedKinds: named
          .map((t) => t.resolutionKind)
          .filter((k): k is string => k !== undefined),
      });
    }
  }
  return out;
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
