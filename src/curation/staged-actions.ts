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
//
// Decisions are different (8i1l): an approve spans many awaits (gates, the
// dispatched write, its commit), so a synchronous section cannot cover it.
// Every decision on one action — approve, reject, expire, interrupted-approval
// resolution — runs under withStagedActionDecision: an in-process chain keyed
// by (vault, id) plus a locks.db lease on stagedActionLockKey(id), which holds
// across processes. recordDecision then re-checks the collapsed status before
// it appends, so even a writer that skipped the lock cannot record a second
// disposition. An approve writes an `applying` record before it dispatches and
// its terminal record after; an approve interrupted in between stays
// `applying`, which every decision path refuses until a human resolves it
// (vault_ratify resolve_interrupted). See docs/architecture.md, "Staged
// actions".

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  acquireLock,
  type LockDb,
  mintLeaseHolder,
  openLockDb,
  releaseLock,
} from "../access/locks.js";
import { err, ok, type Result } from "../frontmatter/types.js";
import { getProvider } from "../search/vector.js";
import {
  clearStagedActions,
  type IndexDb,
  openIndexDb,
  type StagedActionRow,
  upsertStagedAction,
} from "../storage/index-db.js";
import { toSecondISO } from "../utils/dates.js";
import { appendReviewEvents, type DecidedByKind, principalKindForVault } from "./review-log.js";
import { addTension } from "./tension.js";

// The action verbs the queue understands. Each dispatches to a write tool on
// ratify (§11.4 completed the set): promote → vault_promote, deprecate →
// vault_deprecate, supersede → vault_supersede, unsupersede →
// vault_unsupersede, confidence-up → vault_set_confidence, merge →
// vault_merge. `write` (#235) carries full
// content — proposed_diff = { frontmatter, body } — and dispatches to
// vault_write; unlike the lifecycle verbs its target may be a new document.
export const STAGED_ACTION_TYPES = [
  "promote",
  "deprecate",
  "supersede",
  "unsupersede",
  "merge",
  "confidence-up",
  "write",
  "repin",
] as const;
export type StagedActionType = (typeof STAGED_ACTION_TYPES)[number];

export const DEFAULT_TTL_DAYS = 14;

// The lifecycle states a staged action moves through. `ratified-pending-tool`
// is a legacy terminal state from v1.17 (before §11.4 wired up the
// supersede/merge/confidence-up write tools); it is no longer produced but is
// kept here so a record written then still collapses to a known status.
// `applying` (8i1l) is the in-flight marker an approve writes before it
// dispatches: it ends in `ratified`, or back in `pending` when the dispatch
// fails. Left behind by a crash, it means "the write may have landed" and is
// resolved by hand. A daftari that predates it reads it as a non-pending
// status, so it neither re-applies nor expires the action either.
export const STAGED_ACTION_STATUSES = [
  "pending",
  "applying",
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
  // Bead 9mpe: who decided, as a kind — derived from decidedByPrincipal (the
  // authenticated identity), never from ratifiedBy (the caller's claim).
  // "unknown" for pending rows and for decision records that predate it.
  decidedByKind: DecidedByKind;
  // Caller-supplied trace/run identifier stamped at stage time (#235). Like
  // decidedByPrincipal, JSONL-only — not in the sqlite staged_actions table.
  runId: string | null;
  // LD-13: the target document's contentHash (sha256, the same
  // token vault_read returns as `version`) at the moment the proposal was
  // computed — NOT at stage-append time in general, but at the moment the
  // caller last read the document to derive proposedDiff. Only producers whose
  // proposed_diff carries a full-field snapshot (vault_assert's propose-only
  // branch, vault_write's propose-only branch) set this; other staged action
  // types (promote/deprecate/supersede/confidence-up/merge/repin) recompute
  // their mutation from a FRESH load at ratify-dispatch time, so a stage-time
  // base_version would not protect anything and is deliberately not captured
  // for them. Optional and JSONL-only (no sqlite column, same as
  // decidedByPrincipal/runId): an OLD proposal record written before this
  // field existed collapses with baseVersion null, and ratify dispatch skips
  // the staleness check for it exactly as it does today (backward compat —
  // last-write-wins, unchanged).
  baseVersion: string | null;
}

export interface StageActionInput {
  actionType: StagedActionType;
  targetPath: string;
  proposedBy: string;
  rationale: string;
  proposedDiff: unknown;
  ttlDays?: number;
  // Trace/run identifier of the proposing run (#235). Optional free text,
  // recorded on the proposal record and echoed into provenance on ratify.
  runId?: string;
  // Override the proposal timestamp — only used by tests for deterministic
  // expiry math; production callers omit it and get the current clock.
  proposedAt?: string;
  // The target document's contentHash at the moment proposedDiff was computed
  // (see StagedAction.baseVersion doc comment for who should set this and
  // why). Threaded onto the ratify dispatch as vaultWrite's base_version so a
  // proposal replayed against a document that changed since staging fails
  // loudly as a stale write instead of silently overwriting the change.
  baseVersion?: string;
}

export interface DecisionInput {
  status: StagedActionStatus;
  ratifiedAt: string;
  ratifiedBy: string;
  reason?: string;
  // The authenticated identity that issued the decision (access.user, §11.6).
  // Optional — omitted when no AccessContext is present.
  decidedByPrincipal?: string;
  // Override for decisions Daftari makes itself (the expiry sweep). When
  // absent, the kind is derived from decidedByPrincipal via the vault config.
  decidedByKind?: DecidedByKind;
}

export function stagedActionsPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "staged-actions.jsonl");
}

// --- time helpers ----------------------------------------------------------

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
  decided_by_kind?: string | null;
  run_id?: string | null;
  base_version?: string | null;
  // Forensic note on a reopening `pending` record (8i1l); collapse ignores it.
  reopen_reason?: string;
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
        decided_by_kind: null,
        run_id: rec.run_id ?? null,
        base_version: rec.base_version ?? null,
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
      existing.decided_by_kind = rec.decided_by_kind ?? null;
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
    // NOTE: decided_by_principal and run_id are JSONL-only — no DDL column in
    // staged_actions; SQLite-backed reads (rebuildStagedActionsIndex) always
    // yield null here.
    decidedByPrincipal: row.decided_by_principal ?? null,
    decidedByKind: asKind(row.decided_by_kind),
    runId: row.run_id ?? null,
    baseVersion: row.base_version ?? null,
  };
}

function asKind(v: string | null | undefined): DecidedByKind {
  return v === "human" || v === "agent" ? v : "unknown";
}

// Terminal dispositions — the ones a reviewer (or the sweep) made. `applying`
// and a reopening `pending` are bookkeeping, not decisions.
function isTerminal(status: string): boolean {
  return (
    status === "ratified" ||
    status === "rejected" ||
    status === "expired" ||
    status === "ratified-pending-tool"
  );
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

// Shared stage-input validation — the durable boundary re-checks what the
// tool layer already validated. Returns the resolved ttlDays.
function validateStageInput(input: StageActionInput): Result<number, Error> {
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
  return ok(ttlDays);
}

// Allocates the next id from the already-read records and appends the
// proposal — synchronous, so a caller that read the records in the same
// breath gets the critical-section guarantee. Throws on I/O failure (callers
// wrap in try/catch and convert to err).
function appendProposalRecord(
  vaultRoot: string,
  input: StageActionInput,
  records: RawRecord[],
  ttlDays: number,
): { id: string; expires_at: string } {
  const proposedAt = input.proposedAt ?? nowISO();
  const expiresAt = addDaysISO(proposedAt, ttlDays);
  const id = nextStagedId(records);
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
    ...(input.runId && input.runId.trim().length > 0 ? { run_id: input.runId.trim() } : {}),
    ...(input.baseVersion && input.baseVersion.length > 0
      ? { base_version: input.baseVersion }
      : {}),
  };
  appendFileSync(stagedActionsPath(vaultRoot), `${JSON.stringify(record)}\n`);
  return { id, expires_at: expiresAt };
}

// Stages a proposed action. The read + id-allocation + append run
// synchronously with no intervening await, so concurrent calls get distinct,
// monotonic ids.
export async function stageAction(
  vaultRoot: string,
  input: StageActionInput,
): Promise<Result<{ id: string; expires_at: string }, Error>> {
  const ttlDays = validateStageInput(input);
  if (!ttlDays.ok) return ttlDays;
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    return ok(appendProposalRecord(vaultRoot, input, readRawRecords(vaultRoot), ttlDays.value));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot stage action: ${reason}`));
  }
}

// The stage outcome when conflict detection runs: the staged id/expiry plus
// any pending proposals already contesting the same target and the id of the
// inter-proposal tension logged for them.
export interface StageOutcome {
  id: string;
  expires_at: string;
  conflicts_with: string[];
  tension_id: string | null;
  // Set when the proposal staged durably but the inter-proposal tension could
  // not be written. This is deliberately an `ok` field, not an err: the
  // append already happened, so an error Result would invite a retry that
  // duplicates the proposal, and the staged id would only be recoverable by
  // parsing message text. The conflict itself is still surfaced via
  // conflicts_with — nothing is silent.
  tension_error?: string;
}

// Stages a proposal AND runs the inter-proposal check (#235): if other
// pending proposals already target the same path, the new one still lands —
// both stay pending, neither is promoted — and a tension of kind
// `inter-proposal` is logged as a self-tension on the target, its claims
// naming the competing proposal ids. Deterministic and loud: never
// last-write-wins, never silent. This is the producer every staging surface
// should use (vault_stage_action, and vault_write's propose-only coercion).
export async function stageActionWithConflictCheck(
  vaultRoot: string,
  input: StageActionInput,
): Promise<Result<StageOutcome, Error>> {
  const ttlDays = validateStageInput(input);
  if (!ttlDays.ok) return ttlDays;

  // One read serves both the contender snapshot and id allocation, and the
  // whole read → snapshot → append sequence is synchronous — no yield point
  // between the snapshot and the append, so the new proposal is never its
  // own conflict and concurrent stagings see each other (module header).
  let contenders: StagedActionRow[];
  let staged: { id: string; expires_at: string };
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    const records = readRawRecords(vaultRoot);
    contenders = [...collapse(records).values()].filter(
      (r) => r.status === "pending" && r.target_path === input.targetPath.trim(),
    );
    staged = appendProposalRecord(vaultRoot, input, records, ttlDays.value);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot stage action: ${reason}`));
  }

  if (contenders.length === 0) {
    return ok({ ...staged, conflicts_with: [], tension_id: null });
  }

  const target = input.targetPath.trim();
  const tension = await addTension(vaultRoot, {
    title: `Competing proposals on ${target}`,
    kind: "inter-proposal",
    sourceA: target,
    claimA: contenders
      .map((r) => `pending ${r.id} (${r.action_type}): ${firstSentence(r.rationale)}`)
      .join(" | "),
    sourceB: target,
    claimB: `new ${staged.id} (${input.actionType}): ${firstSentence(input.rationale)}`,
    loggedBy: input.proposedBy.trim(),
  });
  if (!tension.ok) {
    // The proposal IS durably staged at this point — see the tension_error
    // doc comment for why this is a structured ok, not an err.
    return ok({
      ...staged,
      conflicts_with: contenders.map((r) => r.id),
      tension_id: null,
      tension_error: tension.error.message,
    });
  }
  return ok({
    ...staged,
    conflicts_with: contenders.map((r) => r.id),
    tension_id: tension.value.id ?? null,
  });
}

// --- decision exclusivity (8i1l) ---------------------------------------------

// The locks.db key for one action's decision lease. The double-underscore
// prefix (same convention as the tension log's `__tensions__`) cannot collide
// with a vault-relative document path.
export function stagedActionLockKey(id: string): string {
  return `__staged_action__:${id}`;
}

// In-process serialization of decisions on one action — the same promise-chain
// shape as git.ts's withCommitLock. The stored link always settles resolved,
// so a failed decision never wedges the chain; entries self-remove once idle.
const decisionChains = new Map<string, Promise<unknown>>();

function chainDecision<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = decisionChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const link = run.catch(() => undefined);
  decisionChains.set(key, link);
  void link.then(() => {
    if (decisionChains.get(key) === link) decisionChains.delete(key);
  });
  return run;
}

// Runs `fn` as the only decider of action `id`. Within this process, callers
// queue on a chain keyed by (resolved vault, id) — a queued caller runs after
// the first finishes and re-reads the status itself. Across processes, the
// decider holds a locks.db lease on stagedActionLockKey(id); a lease already
// held by another process is refused, never waited on, so two processes can
// never interleave check and decision. The lease has the usual 60s TTL, and a
// crashed decider's lease on this host is purged as soon as its pid is dead
// (54pq, locks.ts); whatever it left half-done is visible as an `applying`
// status.
export function withStagedActionDecision<T>(
  vaultRoot: string,
  id: string,
  agent: string,
  fn: () => Promise<Result<T, Error>>,
): Promise<Result<T, Error>> {
  return chainDecision(`${resolve(vaultRoot)}\0${id}`, async () => {
    const opened = openLockDb(vaultRoot);
    if (!opened.ok) return opened;
    const db = opened.value;
    const holder = mintLeaseHolder(agent);
    try {
      const lease = acquireLock(db, stagedActionLockKey(id), holder);
      if (!lease.ok) {
        return err(
          new Error(
            `staged action ${id} is being decided by another process — ` +
              `retry once that decision finishes (${lease.error.message})`,
          ),
        );
      }
      try {
        return await fn();
      } finally {
        releaseLock(db, stagedActionLockKey(id), holder);
      }
    } finally {
      db.close();
    }
  });
}

export interface RecordDecisionOptions {
  // The status the action must currently have for this decision to land.
  // Default `pending`. The approve that wrote an `applying` marker passes
  // `applying` to complete or release it; so does the interrupted-approval
  // resolution.
  expect?: StagedActionStatus;
}

// Appends one decision record after re-checking the collapsed status, in one
// synchronous breath (no await between the read and the append). A `pending`
// decision reopens an action: it carries no ratification fields, so the row
// collapses back to a clean pending row.
function appendDecisionChecked(
  vaultRoot: string,
  id: string,
  decision: DecisionInput,
  expected: StagedActionStatus,
): Result<StagedActionRow, Error> {
  // Collapse the pre-existing log ONCE. The decision we are about to write is
  // fully known, so rather than re-reading + re-collapsing the whole file a
  // second time to learn the post-write state, we apply this one decision to
  // the collapsed map in memory — identical to collapse()'s decision branch.
  const collapsed = collapse(readRawRecords(vaultRoot));
  const existing = collapsed.get(id);
  if (!existing) return err(new Error(`staged action not found: ${id}`));
  // Defense in depth (8i1l): never record a second disposition, whatever the
  // caller checked earlier. The log stays single-disposition even for a
  // writer that bypassed withStagedActionDecision.
  if (existing.status !== expected) {
    return err(
      new Error(
        `staged action ${id} is '${existing.status}', not '${expected}' — ` +
          `refusing to record '${decision.status}' over it`,
      ),
    );
  }

  const terminal = isTerminal(decision.status);
  const kind: DecidedByKind | null = terminal
    ? (decision.decidedByKind ?? principalKindForVault(vaultRoot, decision.decidedByPrincipal))
    : null;
  const record: RawRecord =
    decision.status === "pending"
      ? { id, status: "pending", ...(decision.reason ? { reopen_reason: decision.reason } : {}) }
      : {
          id,
          status: decision.status,
          ratified_at: decision.ratifiedAt,
          ratified_by: decision.ratifiedBy,
          ...(decision.reason ? { ratification_reason: decision.reason } : {}),
          ...(decision.decidedByPrincipal != null
            ? { decided_by_principal: decision.decidedByPrincipal }
            : {}),
          ...(kind !== null ? { decided_by_kind: kind } : {}),
        };
  mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
  appendFileSync(stagedActionsPath(vaultRoot), `${JSON.stringify(record)}\n`);
  if (kind !== null) {
    // A `ratified` record lands only after the dispatched write applied (a
    // failed or shadow dispatch reopens to pending), so ratified ⇔ changed.
    appendReviewEvents(vaultRoot, [
      {
        ev: "decision",
        surface: "staged",
        item: id,
        action: decision.status,
        decided_by_kind: kind,
        changed_anything: decision.status === "ratified",
        at: decision.ratifiedAt,
      },
    ]);
  }

  // Mirror the append onto the in-memory row (same field mapping collapse()
  // applies to a decision record) so the returned row is the post-write state.
  existing.status = record.status ?? existing.status;
  existing.ratified_at = record.ratified_at ?? null;
  existing.ratified_by = record.ratified_by ?? null;
  existing.ratification_reason = record.ratification_reason ?? null;
  existing.decided_by_principal = record.decided_by_principal ?? null;
  existing.decided_by_kind = record.decided_by_kind ?? null;
  return ok(existing);
}

// Appends a decision record (ratify / reject / expire / applying / reopen) for
// an existing action and returns the collapsed result. Refuses unless the
// action's current status is `opts.expect` (default `pending`) — a decided
// action keeps exactly one disposition (8i1l). Callers that decide on a user's
// behalf also run under withStagedActionDecision, so the check and the act are
// exclusive; this re-check is the backstop.
export async function recordDecision(
  vaultRoot: string,
  id: string,
  decision: DecisionInput,
  opts: RecordDecisionOptions = {},
): Promise<Result<StagedAction, Error>> {
  try {
    const row = appendDecisionChecked(vaultRoot, id, decision, opts.expect ?? "pending");
    if (!row.ok) return row;
    return ok(rowToStagedAction(row.value));
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
  // 8i1l: true for an approval interrupted between its write and its
  // decision (status `applying`) — it needs a human to settle it with
  // vault_ratify resolve_interrupted. Absent on ordinary pending items.
  interrupted?: true;
}

// First sentence of a rationale: up to the first sentence-ending period
// followed by whitespace, else the whole trimmed string.
function firstSentence(text: string): string {
  const trimmed = text.trim();
  const m = trimmed.match(/^(.*?[.!?])(\s|$)/);
  return m ? (m[1] as string) : trimmed;
}

// Pending actions for the lint "Staged actions" section, soonest-to-expire
// first, with interrupted approvals (`applying`, 8i1l) ahead of them all and
// flagged: they no longer read as pending, and must not drop out of sight.
// Pure — the lint path derives this from an already-read action list instead
// of collapsing the log a second time.
export function pendingLintItems(actions: StagedAction[], now: Date): StagedActionLintItem[] {
  const byExpiry = (a: StagedAction, b: StagedAction): number =>
    a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : 0;
  const item = (a: StagedAction): StagedActionLintItem => ({
    id: a.id,
    actionType: a.actionType,
    targetPath: a.targetPath,
    ageDays: daysSince(a.proposedAt, now),
    expiresInDays: daysUntil(a.expiresAt, now),
    rationale: firstSentence(a.rationale),
    ...(a.status === "applying" ? { interrupted: true as const } : {}),
  });
  return [
    ...actions.filter((a) => a.status === "applying").sort(byExpiry),
    ...actions.filter((a) => a.status === "pending").sort(byExpiry),
  ].map(item);
}

// Read-only — the sweep that expires stale actions is a separate step.
export async function listPendingForLint(
  vaultRoot: string,
  now: Date = new Date(),
): Promise<Result<StagedActionLintItem[], Error>> {
  const actions = await listStagedActions(vaultRoot);
  if (!actions.ok) return actions;
  return ok(pendingLintItems(actions.value, now));
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
    if (stale.length === 0) return ok({ expired });
    // 8i1l: each expiry is a decision like any other. It takes the action's
    // decision lease (skipping an action someone is deciding right now — the
    // next sweep gets it if it is still pending) and re-checks `pending`
    // under the lease, so an expiry never lands on top of an approval.
    const opened = openLockDb(vaultRoot);
    if (!opened.ok) return opened;
    const db: LockDb = opened.value;
    const holder = mintLeaseHolder(SWEEP_PRINCIPAL);
    try {
      for (const row of stale) {
        if (!acquireLock(db, stagedActionLockKey(row.id), holder).ok) continue;
        try {
          const decided = appendDecisionChecked(
            vaultRoot,
            row.id,
            {
              status: "expired",
              ratifiedAt: at,
              ratifiedBy: SWEEP_PRINCIPAL,
              decidedByKind: "agent",
            },
            "pending",
          );
          if (decided.ok) expired.push(row.id);
        } finally {
          releaseLock(db, stagedActionLockKey(row.id), holder);
        }
      }
    } finally {
      db.close();
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
