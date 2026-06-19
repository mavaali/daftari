// Staged-action queue — the "always-stage" tier of the cortex consolidation
// loop (spec §11.2). A staged action is a proposed change to the vault that
// waits for a human to ratify (approve) or reject it through `vault_ratify`.
// Unratified actions auto-expire after a TTL (default 14 days).
//
// Two stores, mirroring the rest of Daftari:
//
//   - Canonical: .daftari/staged-actions.jsonl — append-only, one JSON record
//     per line, the durable source of truth. A proposal is one record; its
//     later decision (ratify / reject / expire) is a SECOND record referencing
//     the same id. Collapsing the log to current state is this module's job.
//
//   - Index: the `staged_actions` table in .daftari/index.db. Like every table
//     there it is a derived cache: a reindex collapses the jsonl and
//     repopulates it (rebuildStagedActionsIndex / materializeStagedActions).
//     v1 read paths (list / ratify validation / lint) read the jsonl directly —
//     the same posture the tension log takes with tensions.md — so the
//     advisory/curation layer never has to open the embedding-backed index db
//     on a hot path. The sqlite index exists for the future loop's traversal
//     engine (§11.3+), which wants concurrent SQL reads.
//
// All file I/O here is synchronous on purpose: it lets `stageAction` allocate a
// monotonic id and append in one critical section with no intervening await, so
// two stagings in the same instant can never collide on an id. This guarantee
// is per-process; it is sufficient because Daftari enforces one process per
// vault (.daftari/process.lock — see CLAUDE.md), so there is never a second
// writer racing this one. It is NOT a cross-process file lock.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import { getProvider } from "../search/vector.js";
import {
  clearStagedActions,
  type IndexDb,
  openIndexDb,
  type StagedActionRow,
  upsertStagedAction,
} from "../storage/index-db.js";

// The action verbs the queue understands. Each dispatches to a write tool on
// ratify (§11.4 completed the set): promote → vault_promote, deprecate →
// vault_deprecate, supersede → vault_supersede, confidence-up →
// vault_set_confidence, merge → vault_merge.
export const STAGED_ACTION_TYPES = [
  "promote",
  "deprecate",
  "supersede",
  "merge",
  "confidence-up",
] as const;
export type StagedActionType = (typeof STAGED_ACTION_TYPES)[number];

export const DEFAULT_TTL_DAYS = 14;

// The lifecycle states a staged action moves through. `ratified-pending-tool`
// is a legacy terminal state from v1.17 (before §11.4 wired up the
// supersede/merge/confidence-up write tools); it is no longer produced but is
// kept here so a record written then still collapses to a known status.
export const STAGED_ACTION_STATUSES = [
  "pending",
  "ratified",
  "rejected",
  "expired",
  "ratified-pending-tool",
] as const;
export type StagedActionStatus = (typeof STAGED_ACTION_STATUSES)[number];

// The principal recorded as the actor when the lint sweep auto-expires an
// action. Mirrors the agent:/human: convention with a system: prefix.
export const SWEEP_PRINCIPAL = "system:lint-sweep";

// The public, parsed shape of a staged action (proposed_diff decoded). The
// sqlite-facing shape is StagedActionRow in storage/index-db.ts, which keeps
// proposed_diff JSON-encoded.
export interface StagedAction {
  id: string;
  actionType: string;
  targetPath: string;
  proposedBy: string;
  proposedAt: string;
  expiresAt: string;
  status: string;
  rationale: string;
  proposedDiff: unknown;
  ratifiedAt: string | null;
  ratifiedBy: string | null;
  ratificationReason: string | null;
  // The authenticated identity (access.user / §11.6 principal) that issued the
  // decision. Recorded in the JSONL decision record and carried on the in-memory
  // row. NOT stored in the sqlite staged_actions table (no schema bump needed).
  decidedByPrincipal: string | null;
}

export interface StageActionInput {
  actionType: StagedActionType;
  targetPath: string;
  proposedBy: string;
  rationale: string;
  proposedDiff: unknown;
  ttlDays?: number;
  // Override the proposal timestamp — only used by tests for deterministic
  // expiry math; production callers omit it and get the current clock.
  proposedAt?: string;
}

export interface DecisionInput {
  status: StagedActionStatus;
  ratifiedAt: string;
  ratifiedBy: string;
  reason?: string;
  // The authenticated identity that issued the decision (access.user, §11.6).
  // Optional — omitted when no AccessContext is present.
  decidedByPrincipal?: string;
}

export function stagedActionsPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "staged-actions.jsonl");
}

// --- time helpers ----------------------------------------------------------

// ISO 8601 to the second (YYYY-MM-DDTHH:MM:SSZ) — drops the millisecond field
// that toISOString() adds, matching the spec's record format.
function toSecondISO(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// Current instant as a second-resolution ISO string. Exported so the tool
// layer stamps ratify/reject decisions in the same format the log uses.
export function nowISO(): string {
  return toSecondISO(new Date());
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toSecondISO(d);
}

// Whole days between two instants, floored. Negative when `iso` is in the past
// relative to `now` (for daysUntil) or the future (for daysSince).
export function daysSince(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
}

export function daysUntil(iso: string, now: Date): number {
  return Math.floor((Date.parse(iso) - now.getTime()) / 86_400_000);
}

// --- jsonl read / collapse -------------------------------------------------

// A raw line from the log: a proposal carries `action_type`; a decision does
// not (it only updates status + ratification fields by id). The discriminator
// is the presence of `action_type`.
interface RawRecord {
  id: string;
  action_type?: string;
  target_path?: string;
  proposed_by?: string;
  proposed_at?: string;
  expires_at?: string;
  status?: string;
  rationale?: string;
  proposed_diff?: string;
  ratified_at?: string | null;
  ratified_by?: string | null;
  ratification_reason?: string | null;
  decided_by_principal?: string | null;
}

function readRawRecords(vaultRoot: string): RawRecord[] {
  let raw: string;
  try {
    raw = readFileSync(stagedActionsPath(vaultRoot), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const records: RawRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as RawRecord;
      if (typeof rec.id === "string") records.push(rec);
    } catch {
      // Skip a corrupt line; the log is append-only and best-effort.
    }
  }
  return records;
}

// Collapses the append-only log to one current row per id. Records are applied
// in file order: a proposal seeds the row, each later decision overwrites the
// status + ratification fields. A decision with no matching proposal is
// ignored (it cannot stand alone).
function collapse(records: RawRecord[]): Map<string, StagedActionRow> {
  const byId = new Map<string, StagedActionRow>();
  for (const rec of records) {
    if (rec.action_type !== undefined) {
      // Proposal record.
      byId.set(rec.id, {
        id: rec.id,
        action_type: rec.action_type,
        target_path: rec.target_path ?? "",
        proposed_by: rec.proposed_by ?? "",
        proposed_at: rec.proposed_at ?? "",
        expires_at: rec.expires_at ?? "",
        status: rec.status ?? "pending",
        rationale: rec.rationale ?? "",
        proposed_diff: rec.proposed_diff ?? "null",
        ratified_at: null,
        ratified_by: null,
        ratification_reason: null,
        decided_by_principal: null,
      });
    } else {
      // Decision record — only meaningful if the proposal was already seen.
      const existing = byId.get(rec.id);
      if (!existing) continue;
      existing.status = rec.status ?? existing.status;
      existing.ratified_at = rec.ratified_at ?? null;
      existing.ratified_by = rec.ratified_by ?? null;
      existing.ratification_reason = rec.ratification_reason ?? null;
      existing.decided_by_principal = rec.decided_by_principal ?? null;
    }
  }
  return byId;
}

function rowToStagedAction(row: StagedActionRow): StagedAction {
  let proposedDiff: unknown = null;
  try {
    proposedDiff = JSON.parse(row.proposed_diff);
  } catch {
    proposedDiff = row.proposed_diff;
  }
  return {
    id: row.id,
    actionType: row.action_type,
    targetPath: row.target_path,
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at,
    expiresAt: row.expires_at,
    status: row.status,
    rationale: row.rationale,
    proposedDiff,
    ratifiedAt: row.ratified_at,
    ratifiedBy: row.ratified_by,
    ratificationReason: row.ratification_reason,
    // NOTE: decided_by_principal is JSONL-only — no DDL column in staged_actions;
    // SQLite-backed reads (rebuildStagedActionsIndex) always yield null here.
    decidedByPrincipal: row.decided_by_principal ?? null,
  };
}

// Reads the log and returns current state as parsed actions, id order. A
// missing log is not an error — it just means nothing has been staged.
function currentRows(vaultRoot: string): StagedActionRow[] {
  return [...collapse(readRawRecords(vaultRoot)).values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
}

// --- id allocation ---------------------------------------------------------

// Next `stage-NNN` id: the highest numeric suffix ever seen across the whole
// log (proposals and decisions both carry the id) plus one. Scans every record
// so a decision-only collapse can't reset the counter.
function nextStagedId(records: RawRecord[]): string {
  let max = 0;
  for (const rec of records) {
    const m = rec.id.match(/^stage-(\d+)$/);
    if (!m) continue;
    const n = Number.parseInt(m[1] as string, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `stage-${String(max + 1).padStart(3, "0")}`;
}

// --- producer / consumer / sweep -------------------------------------------

// Stages a proposed action. Validation is defensive — the tool layer validates
// too — but this is the durable boundary, so it re-checks. The id-allocation +
// append run synchronously with no intervening await, so concurrent calls get
// distinct, monotonic ids.
export async function stageAction(
  vaultRoot: string,
  input: StageActionInput,
): Promise<Result<{ id: string; expires_at: string }, Error>> {
  if (!(STAGED_ACTION_TYPES as readonly string[]).includes(input.actionType)) {
    return err(
      new Error(`stageAction: action_type must be one of: ${STAGED_ACTION_TYPES.join(", ")}`),
    );
  }
  for (const field of ["targetPath", "proposedBy", "rationale"] as const) {
    const v = input[field];
    if (typeof v !== "string" || v.trim().length === 0) {
      return err(new Error(`stageAction requires a non-empty '${field}'`));
    }
  }
  if (input.proposedDiff === undefined || input.proposedDiff === null) {
    return err(new Error("stageAction requires a 'proposedDiff'"));
  }
  const ttlDays = input.ttlDays ?? DEFAULT_TTL_DAYS;
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    return err(new Error("stageAction 'ttlDays' must be a positive number"));
  }

  const proposedAt = input.proposedAt ?? nowISO();
  const expiresAt = addDaysISO(proposedAt, ttlDays);

  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    // Critical section: read max id and append in one synchronous breath so no
    // concurrent stageAction can observe the same max.
    const id = nextStagedId(readRawRecords(vaultRoot));
    const record = {
      id,
      action_type: input.actionType,
      target_path: input.targetPath.trim(),
      proposed_by: input.proposedBy.trim(),
      proposed_at: proposedAt,
      expires_at: expiresAt,
      status: "pending",
      rationale: input.rationale.trim(),
      proposed_diff: JSON.stringify(input.proposedDiff),
    };
    appendFileSync(stagedActionsPath(vaultRoot), `${JSON.stringify(record)}\n`);
    return ok({ id, expires_at: expiresAt });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot stage action: ${reason}`));
  }
}

// Appends a decision record (ratify / reject / expire) for an existing action
// and returns the collapsed result. Does NOT validate that the action is
// pending — the caller (vault_ratify, the sweep) owns that policy. Errors only
// if the id was never proposed.
export async function recordDecision(
  vaultRoot: string,
  id: string,
  decision: DecisionInput,
): Promise<Result<StagedAction, Error>> {
  try {
    const before = collapse(readRawRecords(vaultRoot));
    if (!before.has(id)) return err(new Error(`staged action not found: ${id}`));

    const record: RawRecord = {
      id,
      status: decision.status,
      ratified_at: decision.ratifiedAt,
      ratified_by: decision.ratifiedBy,
      ...(decision.reason ? { ratification_reason: decision.reason } : {}),
      ...(decision.decidedByPrincipal != null
        ? { decided_by_principal: decision.decidedByPrincipal }
        : {}),
    };
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    appendFileSync(stagedActionsPath(vaultRoot), `${JSON.stringify(record)}\n`);

    const after = collapse(readRawRecords(vaultRoot)).get(id);
    if (!after) return err(new Error(`staged action not found after write: ${id}`));
    return ok(rowToStagedAction(after));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot record decision: ${reason}`));
  }
}

// Returns current actions, optionally filtered to one status, id order.
export async function listStagedActions(
  vaultRoot: string,
  status?: string,
): Promise<Result<StagedAction[], Error>> {
  try {
    const rows = currentRows(vaultRoot);
    const actions = rows.map(rowToStagedAction);
    return ok(status ? actions.filter((a) => a.status === status) : actions);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read staged actions: ${reason}`));
  }
}

// One pending action as the lint surface presents it. `rationale` is trimmed
// to its first sentence; ages are whole days relative to `now`.
export interface StagedActionLintItem {
  id: string;
  actionType: string;
  targetPath: string;
  ageDays: number;
  expiresInDays: number;
  rationale: string;
}

// First sentence of a rationale: up to the first sentence-ending period
// followed by whitespace, else the whole trimmed string.
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^(.*?[.!?])(\s|$)/);
  return m ? (m[1] as string) : trimmed;
}

// Pending actions for the lint "Staged actions" section, soonest-to-expire
// first. Read-only — the sweep that expires stale actions is a separate step.
export async function listPendingForLint(
  vaultRoot: string,
  now: Date = new Date(),
): Promise<Result<StagedActionLintItem[], Error>> {
  try {
    const items = currentRows(vaultRoot)
      .filter((r) => r.status === "pending")
      .sort((a, b) => (a.expires_at < b.expires_at ? -1 : a.expires_at > b.expires_at ? 1 : 0))
      .map((r) => ({
        id: r.id,
        actionType: r.action_type,
        targetPath: r.target_path,
        ageDays: daysSince(r.proposed_at, now),
        expiresInDays: daysUntil(r.expires_at, now),
        rationale: firstSentence(r.rationale),
      }));
    return ok(items);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read staged actions: ${reason}`));
  }
}

export async function getStagedActionById(
  vaultRoot: string,
  id: string,
): Promise<Result<StagedAction | null, Error>> {
  try {
    const row = collapse(readRawRecords(vaultRoot)).get(id);
    return ok(row ? rowToStagedAction(row) : null);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read staged action: ${reason}`));
  }
}

// Sweeps every `pending` action whose expiry has passed into `expired`. One
// expiry decision record is appended per action. Returns the swept ids,
// soonest-expired first. Idempotent: an action already past expiry but not
// pending is left alone.
export async function sweepExpiredActions(
  vaultRoot: string,
  now: Date = new Date(),
): Promise<Result<{ expired: string[] }, Error>> {
  try {
    const rows = currentRows(vaultRoot);
    const stale = rows
      .filter((r) => r.status === "pending" && Date.parse(r.expires_at) < now.getTime())
      .sort((a, b) => (a.expires_at < b.expires_at ? -1 : a.expires_at > b.expires_at ? 1 : 0));
    const at = toSecondISO(now);
    const expired: string[] = [];
    if (stale.length > 0) mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    for (const row of stale) {
      const record: RawRecord = {
        id: row.id,
        status: "expired",
        ratified_at: at,
        ratified_by: SWEEP_PRINCIPAL,
      };
      appendFileSync(stagedActionsPath(vaultRoot), `${JSON.stringify(record)}\n`);
      expired.push(row.id);
    }
    return ok({ expired });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot sweep staged actions: ${reason}`));
  }
}

// --- sqlite index rebuild --------------------------------------------------

// Collapses the jsonl and repopulates the `staged_actions` table from scratch.
// Synchronous (better-sqlite3 + readFileSync). The upserts run in one
// transaction so a mid-rebuild failure rolls back rather than leaving a
// half-populated index, and any sqlite throw surfaces as an err Result instead
// of silently dropping rows.
export function rebuildStagedActionsIndex(
  db: IndexDb,
  vaultRoot: string,
): Result<{ count: number }, Error> {
  try {
    const rows = currentRows(vaultRoot);
    const write = db.transaction(() => {
      clearStagedActions(db);
      for (const row of rows) upsertStagedAction(db, row);
    });
    write();
    return ok({ count: rows.length });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot rebuild staged-actions index: ${reason}`));
  }
}

// Opens the index db at the active provider's dim, rebuilds the staged_actions
// table, and closes. Used at startup when a reindex isn't otherwise running
// (the fresh-index path); the reindex path calls rebuildStagedActionsIndex
// directly against its already-open handle. The provider dim matters: opening
// at the wrong dim would drop and recreate the embeddings_vec mirror.
export function materializeStagedActions(vaultRoot: string): Result<{ count: number }, Error> {
  const opened = openIndexDb(vaultRoot, getProvider().dim);
  if (!opened.ok) return opened;
  const db = opened.value;
  try {
    return rebuildStagedActionsIndex(db, vaultRoot);
  } finally {
    db.close();
  }
}
