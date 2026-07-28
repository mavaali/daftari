// derives_from edge store — the earned re-derivation graph (spec §11.3).
//
// An edge `from --derives_from--> to` asserts that `from`'s content derives
// from `to`. Edges are never declared into trust: they are *earned* through
// independent re-derivations (design doc §3.5 / §5.2). An edge's strength is
// recomputed from its observation trail, never kept as a mutable counter
// (strength-Q2), and it ages with time since the last independent re-test
// (§5.3.1(b)) so entrenchment is structurally impossible.
//
// Two stores, mirroring the staged-action queue:
//
//   - Canonical: .daftari/edges.jsonl — append-only, one JSON record per
//     line. An `observe` record is a (re-)derivation sighting the edge; a
//     `contest` record is a case-2 contradiction (re-derivation failed with
//     no upstream change → contest-and-revoke, strength-Q4). Collapsing the
//     log to current edge state is this module's job.
//
//   - Index: the `derives_from_edges` table in .daftari/index.db — a derived
//     cache rebuilt from the jsonl on reindex (rebuildEdgesIndex /
//     materializeEdges) and, since #236, the AUTHORITATIVE read path:
//     listEdges/getEdge query the table, never the jsonl. Coherence is kept
//     two ways: every edge write re-materializes the table (write-through),
//     and every read first compares a stat marker of the jsonl against the
//     one recorded at the last materialization, rebuilding on mismatch — so
//     an external append (or a lost write-through) self-heals on the next
//     read. Live strength/status are ALWAYS recomputed from the row's
//     (k_survived, last_rederived) at read time; the stored status is at most
//     a conservative prefilter (see listEdges), because it is frozen at
//     `last_age_decay` while real strength keeps aging.
//
// Collapse rules (the strength model, locked Q1–Q4 + §5.3.1):
//   - The first observe in a cycle SEEDS the edge: k_survived = 0. Birth is
//     not a survival — the graph is earned into existence, not free.
//   - A later observe is a qualifying vote iff blind === true AND it varied
//     at least one Q3 axis (prompt | input-neighborhood | model), recorded.
//     Qualifying: k_survived += 1 (cap K_CAP) and the aging clock resets. A
//     vote at cap still resets the clock — a real independent re-test
//     refreshes freshness even when k is saturated.
//   - A non-qualifying observe is kept in the trail but moves nothing:
//     correlated sightings must not keep an edge warm (anti-cramming, C-Q4).
//   - A contest revokes the edge; the caller logs a tension (surface, don't
//     silently decrement). An observe AFTER a contest re-seeds a fresh cycle
//     — revocation is reversible by re-derivation only.
//
// All file I/O is synchronous on purpose, like staged-actions: append runs in
// one critical section with no intervening await. The guarantee is
// per-process, which suffices under the one-daftari-per-vault process lock.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import { getProvider, getQuantize } from "../search/vector.js";
import {
  clearDerivesFromEdges,
  type DerivesFromEdgeRow,
  getDerivesFromEdgePair,
  getMeta,
  type IndexDb,
  listDerivesFromEdgeRows,
  openIndexDb,
  setMeta,
  upsertDerivesFromEdge,
} from "../storage/index-db.js";
import { toSecondISO } from "../utils/dates.js";

// --- calibration constants (provisional — open decision §12/#8) -------------
//
// These three numbers are the v1 defaults of the strength model, exported so
// the future scheduler reads the same values the store does. They are
// PROVISIONAL pending compute-budget calibration; changing them re-derives
// every edge's strength/status on the next collapse (nothing is baked into
// the log).

// Q2: flat independent-vote count, capped.
export const EDGE_K_CAP = 5;

// §5.3.1(b): strength halves per this many days since the last qualifying
// re-derivation. Gentle by design — aging asserts only "the last test is
// old", never "the edge is wrong".
export const EDGE_HALF_LIFE_DAYS = 90;

// An edge bears triggers (C may propagate through it) while its aged strength
// is at or above this floor. With the defaults, k=1 holds for one half-life
// (~90d) and k=5 for ~300d — nothing stays trusted forever without re-test.
export const EDGE_TRIGGER_STRENGTH = 0.5;

// Minimum gap before the SAME (observer, axis) attestation counts as a fresh
// vote (C-Q4: the inter-session gap is what makes a repeat re-derivation an
// independent vote; a same-sitting replay is cramming). A new (observer, axis)
// pair counts immediately — two different models voting in one sitting ARE
// independent.
export const EDGE_REPLAY_GAP_DAYS = 1;

// Q3: the axes a re-derivation can vary to count as an independent vote.
export const EDGE_AXES = ["prompt", "input-neighborhood", "model"] as const;
export type EdgeAxis = (typeof EDGE_AXES)[number];

// --- independence-aware promotion calibration constants (2026-07-26 spec) --
//
// Same posture as EDGE_K_CAP above: PROVISIONAL, exported so the shadow
// calibration reads (src/consolidate/independence.ts,
// src/curation/independence-calibration.ts) and the revision loop share the
// exact values the store uses.

// Correlation discount applied to the j-th vote within an evidence
// equivalence class (Decision 2). k_eff = Σ_classes Σ_{j=1..n} ρ^(j−1).
export const EDGE_INDEPENDENCE_RHO = 0.5;

// Marginal k_eff gain floor a panel's surviving votes must clear to accrue
// (Decision 3, spec amendment 2026-07-26 PR-2.5): survives-independent iff
// the surviving votes' marginal gain is >= this value; correlated-only
// survival (needs-review) iff strictly below it. A second vote landing in an
// already-count-1 class gains exactly EDGE_INDEPENDENCE_RHO ** 1 = 0.5 — "one
// half-fresh vote" — and so accrues (the boundary is inclusive of accrual).
export const EDGE_NEEDS_REVIEW_MIN_GAIN = 0.5;

// Sentinel for an absent fingerprint component. Matches only itself: an
// all-legacy (no-fp) trail collapses into a single class, never accidentally
// split from a genuinely fingerprinted one.
const FP_SENTINEL = "∅";

// The loop's authenticated principal — mirrors CONSOLIDATE_AGENT
// (src/consolidate/constants.ts), duplicated here as a literal rather than
// imported: consolidate/ imports curation/ (never the reverse), so importing
// it here would create a module cycle. A cross-check test
// (test/curation/independence-calibration.test.ts) asserts the two stay
// equal.
const LOOP_PRINCIPAL = "agent:curation-loop";

// One vote's evidence fingerprint (spec Decision 1). All components are
// optional — an absent component reads as the sentinel class. `prompt`
// travels with the record but is deliberately EXCLUDED from the class key
// (Decision 2: the v1 decorrelation verdict measured prompt-framing lift at
// ~0, so prompt variation alone never buys a fresh class).
export interface EdgeFingerprint {
  inputs?: string;
  principal?: string;
  model?: string;
  prompt?: string;
}

// sha256 hex over the sorted `${path}\0${sha256(text)}` lines, joined by
// "\n". Deterministic and independent of the caller's entry order — two
// votes that read the same (path, bytes) set hash identically.
export function computeInputsFingerprint(entries: Array<{ path: string; text: string }>): string {
  const lines = entries
    .map((e) => `${e.path}\0${createHash("sha256").update(e.text).digest("hex")}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// The equivalence-class key for one fingerprint (Decision 2): two votes share
// a class iff they agree on ALL of (inputs, principal, model). `prompt` never
// participates. A missing component is the sentinel `∅`, and `∅` matches only
// `∅` — an all-legacy trail collapses to one class (conservative: votes that
// cannot demonstrate independence get no credit for it).
export function evidenceClassKey(fp: EdgeFingerprint | undefined): string {
  return `${fp?.inputs ?? FP_SENTINEL}\n${fp?.principal ?? FP_SENTINEL}\n${fp?.model ?? FP_SENTINEL}`;
}

// k_eff = Σ_classes Σ_{j=1..n} ρ^(j−1) — geometric discount within each class
// (repeated votes in one class are worth geometrically less), full credit
// across classes. Pure; shared by the store, the revision verdict
// (independenceVerdict, src/consolidate/independence.ts), and the
// calibration reads.
export function effectiveK(classCounts: Iterable<number>): number {
  let total = 0;
  for (const n of classCounts) {
    let classSum = 0;
    let term = 1;
    for (let j = 0; j < n; j++) {
      classSum += term;
      term *= EDGE_INDEPENDENCE_RHO;
    }
    total += classSum;
  }
  return total;
}

export const EDGE_STATUSES = ["candidate", "trigger-bearing", "revoked"] as const;
export type EdgeStatus = (typeof EDGE_STATUSES)[number];

// Which endpoint an observation judged the load-bearing premise. "to" is the
// normal directed case (birth orients premise on `to`); a "from"/"to" split or
// an explicit "symmetric" collapses the edge's direction to unconfirmed.
export const PREMISE_VOTES = ["from", "to", "symmetric"] as const;
export type PremiseVote = (typeof PREMISE_VOTES)[number];

// Derived per-edge direction (like `status`): "directed" when premise votes are
// unanimous (or absent — legacy edges); "symmetric" on any disagreement or an
// explicit symmetric vote. Symmetric edges stay visible as an undirected
// relationship but do not propagate triggers (clocks.ts).
export type DirectionVerdict = "directed" | "symmetric";

// --- public shapes -----------------------------------------------------------

// One collapsed edge with its strength computed as of `asOf` (the timestamp
// the caller collapsed at). `strength` is the aged value; `k_survived` is the
// raw vote count the aging applies to.
export interface DerivesFromEdge {
  fromPath: string;
  toPath: string;
  strength: number;
  kSurvived: number;
  // Independence-aware promotion (Decision 1/2, shadow-only — CLAUDE.md: live
  // strength/status keep using raw kSurvived). kEff discounts votes that land
  // in an already-present evidence class; strengthIndependent is the aged
  // value agedStrength would compute from kEff instead of kSurvived.
  kEff: number;
  strengthIndependent: number;
  firstObserved: string;
  lastRederived: string;
  status: EdgeStatus;
  // Derived direction (collapse of the cycle's premise votes). Defaults to
  // "directed" when no observation carried a vote (legacy edges).
  directionVerdict: DirectionVerdict;
  // Trail extras, useful to callers and tests; not part of the sqlite row.
  observations: number;
  contestedAt: string | null;
  contestReason: string | null;
}

export interface ObserveEdgeInput {
  fromPath: string;
  toPath: string;
  observedBy: string;
  blind: boolean;
  axis?: EdgeAxis;
  note?: string;
  // Which endpoint this observation judged the premise (foundational ordering).
  // Optional: legacy/unscored observes omit it and don't affect directionVerdict.
  premiseVote?: PremiseVote;
  // Evidence fingerprint (Decision 1). Optional — a missing component (or a
  // missing fp entirely) is the sentinel class `∅`. Each present component
  // must be a non-empty string with no newline (the class-key separator).
  fp?: EdgeFingerprint;
  // Test-only timestamp override for deterministic aging math.
  at?: string;
}

export interface ContestEdgeInput {
  fromPath: string;
  toPath: string;
  contestedBy: string;
  reason: string;
  // Test-only timestamp override.
  at?: string;
}

export function edgesPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "edges.jsonl");
}

// --- jsonl freshness marker ---------------------------------------------------

// Meta key recording the stat of edges.jsonl at the last materialization. A
// read whose current stat differs knows the table is stale and rebuilds first.
const EDGES_LOG_STAT_META_KEY = "edges_log_stat";

// Size + mtime identify the jsonl version cheaply. The log is append-only, so
// size alone almost suffices; mtime guards a same-size replacement.
function edgesLogStatMarker(vaultRoot: string): string {
  try {
    const st = statSync(edgesPath(vaultRoot));
    return `${st.size}:${st.mtimeMs}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
}

// --- time helpers ------------------------------------------------------------

export function edgeNowISO(): string {
  return toSecondISO(new Date());
}

// Fractional days between two instants; negative if `iso` is in the future.
function daysBetween(iso: string, now: Date): number {
  return (now.getTime() - Date.parse(iso)) / 86_400_000;
}

// §5.3.1(b): aged strength. Exported so the scheduler and the lint surface
// compute the exact same value the store materializes.
export function agedStrength(kSurvived: number, lastRederived: string, now: Date): number {
  const k = Math.min(Math.max(kSurvived, 0), EDGE_K_CAP);
  if (k === 0) return 0;
  const age = Math.max(0, daysBetween(lastRederived, now));
  return k * 0.5 ** (age / EDGE_HALF_LIFE_DAYS);
}

// --- jsonl read / collapse ---------------------------------------------------

interface RawEdgeRecord {
  kind?: string; // "observe" | "contest"
  from?: string;
  to?: string;
  at?: string;
  by?: string;
  blind?: boolean;
  axis?: string | null;
  note?: string;
  reason?: string;
  premiseVote?: string;
  // Read defensively (Decision 1): a non-string / newline-bearing component
  // is treated as absent (∅), never thrown on.
  fp?: { inputs?: unknown; principal?: unknown; model?: unknown; prompt?: unknown };
}

// A present fp component must be a non-empty string with no newline (the
// class-key line separator) — anything else reads as absent (∅).
function sanitizeFpComponent(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 && !v.includes("\n") ? v : undefined;
}

function readFingerprint(raw: RawEdgeRecord["fp"]): EdgeFingerprint | undefined {
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  return {
    inputs: sanitizeFpComponent(raw.inputs),
    principal: sanitizeFpComponent(raw.principal),
    model: sanitizeFpComponent(raw.model),
    prompt: sanitizeFpComponent(raw.prompt),
  };
}

// Only defined components are serialized onto the JSONL record — old lines
// stay valid, the log stays append-only, no backfill.
function fpForWrite(fp: EdgeFingerprint): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (fp.inputs !== undefined) out.inputs = fp.inputs;
  if (fp.principal !== undefined) out.principal = fp.principal;
  if (fp.model !== undefined) out.model = fp.model;
  if (fp.prompt !== undefined) out.prompt = fp.prompt;
  return Object.keys(out).length > 0 ? out : undefined;
}

function hasAnyFpComponent(fp: EdgeFingerprint | undefined): boolean {
  return (
    fp !== undefined &&
    (fp.inputs !== undefined ||
      fp.principal !== undefined ||
      fp.model !== undefined ||
      fp.prompt !== undefined)
  );
}

function readRawRecords(vaultRoot: string): RawEdgeRecord[] {
  let raw: string;
  try {
    raw = readFileSync(edgesPath(vaultRoot), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const records: RawEdgeRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as RawEdgeRecord;
      // `at` must parse to a real instant: an unparseable timestamp would turn
      // into NaN strength downstream (Date.parse → NaN → 0.5 ** NaN), silently
      // poisoning the materialized row and the sort. Such a line is corrupt,
      // same as bad JSON — skip it.
      if (
        (rec.kind === "observe" || rec.kind === "contest") &&
        typeof rec.from === "string" &&
        typeof rec.to === "string" &&
        typeof rec.at === "string" &&
        Number.isFinite(Date.parse(rec.at))
      ) {
        records.push(rec);
      }
    } catch {
      // Skip a corrupt line; the log is append-only and best-effort.
    }
  }
  return records;
}

function edgeKey(from: string, to: string): string {
  // Paths are vault-relative and never contain a newline; "\n" cannot collide.
  return `${from}\n${to}`;
}

// The DURABLE key is canonical (sorted), so the two orientations of a pair —
// `(x,y)` and `(y,x)` — collapse to ONE edge. Direction is then a derived
// property of the premise votes, not of key order: this is what makes a
// post-edit orientation flip a from/to *split* (⇒ symmetric) instead of a
// second contradictory directed twin. Output orientation is re-derived in
// deriveEdge.
function canonPair(from: string, to: string): [string, string] {
  return from <= to ? [from, to] : [to, from];
}

// Mutable per-edge state the collapse accumulates, before strength/status are
// derived at the end.
interface EdgeState {
  // Canonical (sorted) endpoints — the durable identity of the pair.
  fromPath: string;
  toPath: string;
  // The seed observe's ORIGINAL orientation (from=dependent, to=premise by the
  // store convention). Used to preserve direction for legacy edges that carry no
  // premise vote; directed-with-votes re-derives orientation from the votes.
  seedFrom: string;
  seedTo: string;
  kSurvived: number;
  firstObserved: string;
  lastRederived: string;
  observations: number;
  revoked: boolean;
  contestedAt: string | null;
  contestReason: string | null;
  // (observer, axis) pairs already counted as votes this cycle — the dedup
  // set behind the replay guard below. Reset on re-seed.
  votedPairs: Set<string>;
  // Distinct premise votes seen this cycle (reset on re-seed). The direction
  // verdict is derived from this set: unanimous (or empty) ⇒ directed; any
  // split, or an explicit symmetric ⇒ symmetric.
  premiseVotes: Set<PremiseVote>;
  // Independence-aware promotion (Decision 1/2): evidence-class key → counted
  // -vote count, accumulated ONLY for counted votes (never the seed). Reset
  // on re-seed after a contest, like votedPairs.
  classCounts: Map<string, number>;
  // Counted votes whose record carried no fp component at all — the
  // legacy-∅ lint fraction (Decision 4).
  unfingerprintedCountedVotes: number;
  // Counted votes whose fp.principal is present and differs from the loop's
  // own principal — how much of the class structure is operator-attested
  // rather than loop-computed (C3).
  nonLoopFingerprintedCountedVotes: number;
}

// Collapse the cycle's premise votes into a direction verdict (review C1):
// empty (legacy) or unanimous from/to ⇒ directed; a from/to split or any
// explicit symmetric vote ⇒ symmetric.
function directionVerdictOf(votes: Set<PremiseVote>): DirectionVerdict {
  if (votes.has("symmetric")) return "symmetric";
  if (votes.has("from") && votes.has("to")) return "symmetric";
  return "directed";
}

function validPremiseVote(v: unknown): PremiseVote | null {
  return typeof v === "string" && (PREMISE_VOTES as readonly string[]).includes(v)
    ? (v as PremiseVote)
    : null;
}

// Collapses the append-only log to one current state per (from, to), applying
// the strength-model rules in FILE order (the order events were appended —
// the tools only ever append at the current instant, so file order is time
// order; an out-of-order `at` is only reachable through the test-only
// override). Strength and status are derived afterward (deriveEdge) so they
// are always recomputed, never carried.
//
// Trust boundary: `blind` and `axis` are unverifiable attestations — the
// store cannot check that a pass really was blind or really varied the axis
// it claims. Enforcement of genuine independence (and §10.5's multi-pass
// agreement for contests) is the LOOP's job, not the store's. What the store
// does guard, mechanically (the §5.2 hazard: correlated re-derivations
// defeating both gates): a REPLAYED attestation — the same (observer, axis)
// pair voting again — counts only after EDGE_REPLAY_GAP_DAYS since the last
// counted vote, so a single caller cannot pump k to the cap in one sitting,
// while a genuine later re-derivation by the same pass (the quarterly loop)
// still restores aged strength (§5.3.1 reversibility). A new (observer, axis)
// pair counts immediately.
function collapse(records: RawEdgeRecord[]): Map<string, EdgeState> {
  const byKey = new Map<string, EdgeState>();
  for (const rec of records) {
    const from = rec.from as string;
    const to = rec.to as string;
    const at = rec.at as string;
    const [cFrom, cTo] = canonPair(from, to);
    const key = edgeKey(cFrom, cTo);
    const existing = byKey.get(key);

    // Resolve this record's premise vote (relative to the record's own from/to)
    // to a CANONICAL endpoint vote: "from" = canonical-first is the premise,
    // "to" = canonical-second is the premise. Opposite orientations of the same
    // pair therefore vote on the same canonical axis and a flip becomes a split.
    const rawVote = validPremiseVote(rec.premiseVote);
    let canonVote: PremiseVote | null = null;
    if (rawVote === "symmetric") {
      canonVote = "symmetric";
    } else if (rawVote === "from" || rawVote === "to") {
      const premisePath = rawVote === "to" ? to : from;
      canonVote = premisePath === cFrom ? "from" : "to";
    }

    if (rec.kind === "contest") {
      // A contest of an edge that was never observed cannot stand alone.
      if (!existing || existing.revoked) continue;
      existing.revoked = true;
      existing.contestedAt = at;
      existing.contestReason = rec.reason ?? null;
      continue;
    }

    // observe
    if (!existing || existing.revoked) {
      // Seed (or re-seed after a contest): a fresh earning cycle. Birth is not
      // a survival, so k starts at 0; the aging clock starts at birth. The
      // seed's own (observer, axis) attestation IS registered, so the seeder
      // repeating the identical claim a second later is a replay (gap-gated),
      // not an instant first vote — otherwise one caller could reach
      // trigger-bearing in a single sitting with one repeated assertion.
      const seedPair =
        rec.blind === true &&
        typeof rec.axis === "string" &&
        (EDGE_AXES as readonly string[]).includes(rec.axis) &&
        typeof rec.by === "string" &&
        rec.by.length > 0
          ? [`${rec.by}\n${rec.axis}`]
          : [];
      byKey.set(key, {
        fromPath: cFrom,
        toPath: cTo,
        seedFrom: from,
        seedTo: to,
        kSurvived: 0,
        firstObserved: at,
        lastRederived: at,
        observations: 1,
        revoked: false,
        contestedAt: null,
        contestReason: null,
        votedPairs: new Set(seedPair),
        premiseVotes: new Set(canonVote ? [canonVote] : []),
        classCounts: new Map(),
        unfingerprintedCountedVotes: 0,
        nonLoopFingerprintedCountedVotes: 0,
      });
      continue;
    }

    existing.observations += 1;
    if (canonVote) existing.premiseVotes.add(canonVote);
    const qualifying =
      rec.blind === true &&
      typeof rec.axis === "string" &&
      (EDGE_AXES as readonly string[]).includes(rec.axis) &&
      typeof rec.by === "string" &&
      rec.by.length > 0;
    if (qualifying) {
      const pair = `${rec.by}\n${rec.axis}`;
      const isReplay = existing.votedPairs.has(pair);
      const gapDays = (Date.parse(at) - Date.parse(existing.lastRederived)) / 86_400_000;
      if (!isReplay || gapDays >= EDGE_REPLAY_GAP_DAYS) {
        existing.votedPairs.add(pair);
        existing.kSurvived = Math.min(existing.kSurvived + 1, EDGE_K_CAP);
        // A counted vote at cap still refreshes the clock: it is a real
        // independent re-test even when k is saturated.
        existing.lastRederived = at;

        // Independence-aware promotion (Decision 1/2): register this counted
        // vote's evidence class. Exactly this branch, matching kSurvived's
        // own accrual — the seed observe above never reaches here.
        const fp = readFingerprint(rec.fp);
        const classKey = evidenceClassKey(fp);
        existing.classCounts.set(classKey, (existing.classCounts.get(classKey) ?? 0) + 1);
        if (!hasAnyFpComponent(fp)) existing.unfingerprintedCountedVotes += 1;
        if (fp?.principal !== undefined && fp.principal !== LOOP_PRINCIPAL) {
          existing.nonLoopFingerprintedCountedVotes += 1;
        }
      }
    }
    // Non-qualifying and same-sitting-replayed observes move nothing —
    // correlated sightings must not keep an edge warm.
  }
  return byKey;
}

function deriveEdge(state: EdgeState, now: Date): DerivesFromEdge {
  const strength = state.revoked ? 0 : agedStrength(state.kSurvived, state.lastRederived, now);
  // Independence-aware promotion (Decision 2/4, shadow-only): k_eff and its
  // aged strength are computed alongside the live values but never gate
  // status — status below still derives from raw `strength`.
  const kEff = effectiveK(state.classCounts.values());
  const strengthIndependent = state.revoked ? 0 : agedStrength(kEff, state.lastRederived, now);
  const status: EdgeStatus = state.revoked
    ? "revoked"
    : strength >= EDGE_TRIGGER_STRENGTH
      ? "trigger-bearing"
      : "candidate";

  // Re-derive the OUTPUT orientation (from=dependent, to=premise). The state's
  // fromPath/toPath are canonical; direction lives in the votes:
  //   - symmetric ⇒ keep canonical order (direction unconfirmed, won't propagate)
  //   - directed with votes ⇒ premise = the voted canonical endpoint
  //   - directed without votes (legacy) ⇒ preserve the seed's original orientation
  const verdict = directionVerdictOf(state.premiseVotes);
  let fromPath = state.fromPath;
  let toPath = state.toPath;
  if (verdict === "directed") {
    if (state.premiseVotes.size === 0) {
      fromPath = state.seedFrom;
      toPath = state.seedTo;
    } else {
      const premiseIsFrom = state.premiseVotes.has("from"); // unanimous when directed
      fromPath = premiseIsFrom ? state.toPath : state.fromPath; // dependent
      toPath = premiseIsFrom ? state.fromPath : state.toPath; // premise
    }
  }

  return {
    fromPath,
    toPath,
    strength,
    kSurvived: state.kSurvived,
    kEff,
    strengthIndependent,
    firstObserved: state.firstObserved,
    lastRederived: state.lastRederived,
    status,
    directionVerdict: verdict,
    observations: state.observations,
    contestedAt: state.contestedAt,
    contestReason: state.contestReason,
  };
}

// --- producer / consumer -----------------------------------------------------

// Write-through: re-materialize the table after a jsonl append. A full rebuild
// rather than a row upsert because a new observation can FLIP the stored
// output orientation (premise votes), which a keyed upsert would leave as a
// stale twin. Best-effort by design: the append above is the canonical write,
// and a failure here leaves the marker stale, so the next read self-heals via
// ensureFreshEdgesIndex — the cache can be behind, never wrong.
//
// Returns the collapsed states so the caller can read the after-state of its
// own append without collapsing the log a second time. Null only when the
// log itself could not be read.
function writeThroughEdgesIndex(vaultRoot: string): Map<string, EdgeState> | null {
  try {
    // Stat BEFORE reading — same marker discipline as rebuildEdgesIndex.
    const marker = edgesLogStatMarker(vaultRoot);
    const states = collapse(readRawRecords(vaultRoot));
    const opened = openIndexDb(vaultRoot, getProvider().dim, getQuantize());
    if (opened.ok) {
      const db = opened.value;
      try {
        rebuildEdgesIndexFromStates(db, states, marker);
      } finally {
        db.close();
      }
    }
    return states;
  } catch {
    // Self-heal on the next read.
    return null;
  }
}

// Records a (re-)derivation observation. Validation is defensive — the tool
// layer validates too — but this is the durable boundary, so it re-checks.
export async function observeEdge(
  vaultRoot: string,
  input: ObserveEdgeInput,
): Promise<Result<DerivesFromEdge, Error>> {
  for (const field of ["fromPath", "toPath", "observedBy"] as const) {
    const v = input[field];
    if (typeof v !== "string" || v.trim().length === 0) {
      return err(new Error(`observeEdge requires a non-empty '${field}'`));
    }
  }
  if (input.fromPath.trim() === input.toPath.trim()) {
    return err(new Error("observeEdge: a document cannot derive from itself"));
  }
  if (typeof input.blind !== "boolean") {
    return err(new Error("observeEdge requires a boolean 'blind'"));
  }
  if (input.axis !== undefined && !(EDGE_AXES as readonly string[]).includes(input.axis)) {
    return err(new Error(`observeEdge 'axis' must be one of: ${EDGE_AXES.join(", ")}`));
  }
  if (input.at !== undefined && !Number.isFinite(Date.parse(input.at))) {
    return err(new Error("observeEdge 'at' must be a parseable timestamp"));
  }
  if (
    input.premiseVote !== undefined &&
    !(PREMISE_VOTES as readonly string[]).includes(input.premiseVote)
  ) {
    return err(new Error(`observeEdge 'premiseVote' must be one of: ${PREMISE_VOTES.join(", ")}`));
  }
  if (input.fp !== undefined) {
    for (const [key, v] of Object.entries(input.fp)) {
      if (v === undefined) continue;
      if (typeof v !== "string" || v.length === 0 || v.includes("\n")) {
        return err(new Error(`observeEdge 'fp.${key}' must be a non-empty string with no newline`));
      }
    }
  }

  const fpOut = input.fp ? fpForWrite(input.fp) : undefined;
  const record = {
    kind: "observe",
    from: input.fromPath.trim(),
    to: input.toPath.trim(),
    at: input.at ?? edgeNowISO(),
    by: input.observedBy.trim(),
    blind: input.blind,
    axis: input.axis ?? null,
    ...(input.note ? { note: input.note } : {}),
    ...(input.premiseVote ? { premiseVote: input.premiseVote } : {}),
    ...(fpOut ? { fp: fpOut } : {}),
  };

  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    appendFileSync(edgesPath(vaultRoot), `${JSON.stringify(record)}\n`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot record edge observation: ${reason}`));
  }

  const states = writeThroughEdgesIndex(vaultRoot) ?? collapse(readRawRecords(vaultRoot));
  const after = states.get(edgeKey(...canonPair(record.from, record.to)));
  if (!after) return err(new Error("edge not found after write"));
  return ok(deriveEdge(after, new Date()));
}

// Records a case-2 contest (re-derivation failed with no upstream change):
// the edge drops to `revoked`. The TOOL layer pairs this with a tension entry
// (surface, don't silently decrement) — the store records what happened, the
// tension log says so out loud.
export async function contestEdge(
  vaultRoot: string,
  input: ContestEdgeInput,
): Promise<Result<DerivesFromEdge, Error>> {
  for (const field of ["fromPath", "toPath", "contestedBy", "reason"] as const) {
    const v = input[field];
    if (typeof v !== "string" || v.trim().length === 0) {
      return err(new Error(`contestEdge requires a non-empty '${field}'`));
    }
  }
  if (input.at !== undefined && !Number.isFinite(Date.parse(input.at))) {
    return err(new Error("contestEdge 'at' must be a parseable timestamp"));
  }

  const from = input.fromPath.trim();
  const to = input.toPath.trim();
  const current = collapse(readRawRecords(vaultRoot)).get(edgeKey(...canonPair(from, to)));
  if (!current) {
    return err(new Error(`contestEdge: no such edge: ${from} derives_from ${to}`));
  }
  if (current.revoked) {
    return err(new Error(`contestEdge: edge already revoked: ${from} derives_from ${to}`));
  }

  const record = {
    kind: "contest",
    from,
    to,
    at: input.at ?? edgeNowISO(),
    by: input.contestedBy.trim(),
    reason: input.reason.trim(),
  };

  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    appendFileSync(edgesPath(vaultRoot), `${JSON.stringify(record)}\n`);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot record edge contest: ${reason}`));
  }

  const states = writeThroughEdgesIndex(vaultRoot) ?? collapse(readRawRecords(vaultRoot));
  const after = states.get(edgeKey(...canonPair(from, to)));
  if (!after) return err(new Error("edge not found after write"));
  return ok(deriveEdge(after, new Date()));
}

export interface ListEdgesFilter {
  fromPath?: string;
  toPath?: string;
  status?: EdgeStatus;
}

// Rehydrates the public edge shape from a materialized row, recomputing live
// strength/status at `now`. The stored strength/status are frozen at
// `last_age_decay`; only (k_survived, last_rederived) — which no amount of
// aging changes — plus the revoked flag are trusted from the row.
function deriveEdgeFromRow(row: DerivesFromEdgeRow, now: Date): DerivesFromEdge {
  const revoked = row.status === "revoked";
  const strength = revoked ? 0 : agedStrength(row.k_survived, row.last_rederived, now);
  const strengthIndependent = revoked ? 0 : agedStrength(row.k_eff, row.last_rederived, now);
  const status: EdgeStatus = revoked
    ? "revoked"
    : strength >= EDGE_TRIGGER_STRENGTH
      ? "trigger-bearing"
      : "candidate";
  return {
    fromPath: row.from_path,
    toPath: row.to_path,
    strength,
    kSurvived: row.k_survived,
    kEff: row.k_eff,
    strengthIndependent,
    firstObserved: row.first_observed,
    lastRederived: row.last_rederived,
    status,
    directionVerdict: row.direction_verdict as DirectionVerdict,
    observations: row.observations,
    contestedAt: row.contested_at,
    contestReason: row.contest_reason,
  };
}

// Rebuilds the table iff the jsonl's stat no longer matches the marker stored
// at the last materialization. This is what lets reads trust the table: an
// external append, a manual log edit, or a lost write-through all surface as
// a marker mismatch and heal here before the query runs.
function ensureFreshEdgesIndex(db: IndexDb, vaultRoot: string): Result<void, Error> {
  if (getMeta(db, EDGES_LOG_STAT_META_KEY) === edgesLogStatMarker(vaultRoot)) return ok(undefined);
  const rebuilt = rebuildEdgesIndex(db, vaultRoot);
  return rebuilt.ok ? ok(undefined) : rebuilt;
}

// Degraded read path: collapse the canonical jsonl directly. Used only when
// the index db cannot be OPENED (e.g. a read-only .daftari, where sqlite
// cannot create WAL sidecars) — the jsonl is the canonical store, so falling
// back costs performance, never correctness.
function listEdgesFromLog(
  vaultRoot: string,
  filter: ListEdgesFilter,
  now: Date,
): Result<DerivesFromEdge[], Error> {
  try {
    let edges = [...collapse(readRawRecords(vaultRoot)).values()].map((s) => deriveEdge(s, now));
    if (filter.fromPath) edges = edges.filter((e) => e.fromPath === filter.fromPath);
    if (filter.toPath) edges = edges.filter((e) => e.toPath === filter.toPath);
    if (filter.status) edges = edges.filter((e) => e.status === filter.status);
    edges.sort(
      (a, b) =>
        b.strength - a.strength ||
        a.fromPath.localeCompare(b.fromPath) ||
        a.toPath.localeCompare(b.toPath),
    );
    return ok(edges);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read edges: ${reason}`));
  }
}

// Materialized edges with live aged strength, strongest first (ties by key for
// a stable order). An empty/missing log is not an error — nothing observed.
export async function listEdges(
  vaultRoot: string,
  filter: ListEdgesFilter = {},
  now: Date = new Date(),
): Promise<Result<DerivesFromEdge[], Error>> {
  const opened = openIndexDb(vaultRoot, getProvider().dim, getQuantize());
  if (!opened.ok) return listEdgesFromLog(vaultRoot, filter, now);
  const db = opened.value;
  try {
    const fresh = ensureFreshEdgesIndex(db, vaultRoot);
    if (!fresh.ok) return err(new Error(`cannot read edges: ${fresh.error.message}`));
    // Status PREFILTER on the stored column. "revoked" is exact (a write-only
    // flag, and writes re-materialize). The two live statuses are a function
    // of aging strength, so either may have drifted since materialization —
    // fetch both and let the recomputed status decide.
    const statusIn =
      filter.status === undefined
        ? undefined
        : filter.status === "revoked"
          ? ["revoked"]
          : ["candidate", "trigger-bearing"];
    let edges = listDerivesFromEdgeRows(db, {
      fromPath: filter.fromPath,
      toPath: filter.toPath,
      statusIn,
    }).map((row) => deriveEdgeFromRow(row, now));
    if (filter.status) edges = edges.filter((e) => e.status === filter.status);
    edges.sort(
      (a, b) =>
        b.strength - a.strength ||
        a.fromPath.localeCompare(b.fromPath) ||
        a.toPath.localeCompare(b.toPath),
    );
    return ok(edges);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read edges: ${reason}`));
  } finally {
    db.close();
  }
}

export async function getEdge(
  vaultRoot: string,
  fromPath: string,
  toPath: string,
  now: Date = new Date(),
): Promise<Result<DerivesFromEdge | null, Error>> {
  const opened = openIndexDb(vaultRoot, getProvider().dim, getQuantize());
  if (!opened.ok) {
    // Same degraded posture as listEdgesFromLog: canonical store, no cache.
    try {
      const state = collapse(readRawRecords(vaultRoot)).get(
        edgeKey(...canonPair(fromPath, toPath)),
      );
      return ok(state ? deriveEdge(state, now) : null);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return err(new Error(`cannot read edge: ${reason}`));
    }
  }
  const db = opened.value;
  try {
    const fresh = ensureFreshEdgesIndex(db, vaultRoot);
    if (!fresh.ok) return err(new Error(`cannot read edge: ${fresh.error.message}`));
    const row = getDerivesFromEdgePair(db, fromPath, toPath);
    return ok(row ? deriveEdgeFromRow(row, now) : null);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read edge: ${reason}`));
  } finally {
    db.close();
  }
}

// --- sqlite index rebuild ----------------------------------------------------

// Collapses the jsonl and repopulates the `derives_from_edges` table from
// scratch. `strength` and `status` are materialized as of `now`, and
// `last_age_decay` records that instant — the row's strength is exact as of
// that timestamp and ages from there (live readers recompute via
// agedStrength). One transaction, so a mid-rebuild failure rolls back.
export function rebuildEdgesIndex(
  db: IndexDb,
  vaultRoot: string,
  now: Date = new Date(),
): Result<{ count: number }, Error> {
  try {
    // Stat BEFORE reading: if the log grows between the stat and the read, the
    // marker undercounts and the next read harmlessly rebuilds again. Statting
    // after would risk marking content the collapse never saw as fresh.
    const marker = edgesLogStatMarker(vaultRoot);
    const states = collapse(readRawRecords(vaultRoot));
    return rebuildEdgesIndexFromStates(db, states, marker, now);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot rebuild derives_from index: ${reason}`));
  }
}

// Table repopulation from an already-collapsed state map. Split out so the
// write-through path (which needs the collapsed states for its own after-state
// read) collapses the log exactly once per append.
function rebuildEdgesIndexFromStates(
  db: IndexDb,
  states: Map<string, EdgeState>,
  marker: string,
  now: Date = new Date(),
): Result<{ count: number }, Error> {
  try {
    const edges = [...states.values()].map((s) => deriveEdge(s, now));
    const at = toSecondISO(now);
    const rows: DerivesFromEdgeRow[] = edges.map((e) => ({
      from_path: e.fromPath,
      to_path: e.toPath,
      strength: e.strength,
      k_survived: e.kSurvived,
      k_eff: e.kEff,
      first_observed: e.firstObserved,
      last_rederived: e.lastRederived,
      last_age_decay: at,
      status: e.status,
      direction_verdict: e.directionVerdict,
      observations: e.observations,
      contested_at: e.contestedAt,
      contest_reason: e.contestReason,
    }));
    const write = db.transaction(() => {
      clearDerivesFromEdges(db);
      for (const row of rows) upsertDerivesFromEdge(db, row);
      setMeta(db, EDGES_LOG_STAT_META_KEY, marker);
    });
    write();
    return ok({ count: rows.length });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot rebuild derives_from index: ${reason}`));
  }
}

// Opens the index db at the active provider's dim, rebuilds the
// derives_from_edges table, and closes. Startup path when no reindex is
// otherwise running; the reindex path calls rebuildEdgesIndex directly.
export function materializeEdges(vaultRoot: string): Result<{ count: number }, Error> {
  const opened = openIndexDb(vaultRoot, getProvider().dim, getQuantize());
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    return rebuildEdgesIndex(db, vaultRoot);
  } finally {
    db.close();
  }
}

// --- independence-aware promotion: on-demand log collapse (Decision 1-4) ----

// The current cycle's evidence-class counts for one edge, collapsed directly
// from the canonical jsonl (no sqlite dependency — class detail is never
// materialized). Empty when the edge is absent or revoked. Consumers: the
// revision loop (src/consolidate/independence.ts) and the needs-review
// tension body.
export function edgeEvidenceClasses(
  vaultRoot: string,
  fromPath: string,
  toPath: string,
): Result<Map<string, number>, Error> {
  try {
    const state = collapse(readRawRecords(vaultRoot)).get(edgeKey(...canonPair(fromPath, toPath)));
    if (!state || state.revoked) return ok(new Map());
    return ok(new Map(state.classCounts));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read edge evidence classes: ${reason}`));
  }
}

// Per-edge calibration row for the lint surface (src/curation/independence-
// calibration.ts). Counts and aggregates only — class KEYS are not exported
// here, matching the vault-global-counts-only posture the lint section takes.
export interface EdgeIndependenceRow {
  fromPath: string;
  toPath: string;
  kSurvived: number;
  kEff: number;
  strength: number;
  strengthIndependent: number;
  classCount: number;
  countedVotes: number;
  unfingerprintedCountedVotes: number;
  nonLoopFingerprintedCountedVotes: number;
  status: EdgeStatus;
}

// One collapse pass over the whole log, live-derived per edge — the
// independenceCalibration lint section's source of truth.
export function independenceCalibrationView(
  vaultRoot: string,
  now: Date = new Date(),
): Result<EdgeIndependenceRow[], Error> {
  try {
    const states = collapse(readRawRecords(vaultRoot));
    const rows: EdgeIndependenceRow[] = [];
    for (const state of states.values()) {
      const edge = deriveEdge(state, now);
      let countedVotes = 0;
      for (const n of state.classCounts.values()) countedVotes += n;
      rows.push({
        fromPath: edge.fromPath,
        toPath: edge.toPath,
        kSurvived: edge.kSurvived,
        kEff: edge.kEff,
        strength: edge.strength,
        strengthIndependent: edge.strengthIndependent,
        classCount: state.classCounts.size,
        countedVotes,
        unfingerprintedCountedVotes: state.unfingerprintedCountedVotes,
        nonLoopFingerprintedCountedVotes: state.nonLoopFingerprintedCountedVotes,
        status: edge.status,
      });
    }
    return ok(rows);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot compute independence calibration view: ${reason}`));
  }
}

// Exported so a test can cross-check it against consolidate/constants.ts's
// CONSOLIDATE_AGENT without creating a curation→consolidate import.
export const EDGE_CALIBRATION_LOOP_PRINCIPAL = LOOP_PRINCIPAL;
