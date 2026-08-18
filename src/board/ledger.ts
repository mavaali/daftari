// ledger.ts — U3: Disposition ledger.
//
// Durable append-only event store for board finding dispositions.
//
// Runtime file: .daftari/board-dispositions.jsonl
// One JSON object per line, appended on every disposition change.
// Never modified in place — append-only guarantees replay-from-start is always
// valid. A corrupt line is silently skipped so one bad write cannot destroy
// the history of every other finding.
//
// The three public shapes downstream consumes:
//
//   appendEvent(vaultRoot, event)
//     → accepts a LedgerEvent WITHOUT identity_scheme_version and stamps the
//       current IDENTITY_SCHEME_VERSION so callers cannot forget it.
//     → mirrors provenance.ts:72-98: mkdirSync(.daftari, recursive), appendFile.
//
//   loadLedger(vaultRoot)
//     → parses all lines, groups by finding_id preserving append order.
//     → returns { byFinding: Map<string, LedgerEvent[]>, flat: LedgerEvent[] }
//     → missing file is ok (empty result); corrupt lines are skipped.
//
//   currentDisposition(events, now?)
//     → faithful fold of one finding's ordered event list.
//     → returns the latest human/system event plus the derived
//       against_fingerprint, expiry, owner, and (when now provided) expired.
//     → does NOT do reconciliation or column mapping (that is U4).
//
//   eventTimestamps(events)
//     → { first_seen, last_seen } derived from min/max `at` values (R12).

import { mkdirSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../frontmatter/types.js";
import { IDENTITY_SCHEME_VERSION } from "./identity.js";
import type { LedgerEvent, LedgerEventType } from "./types.js";

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

export function boardDispositionsPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "board-dispositions.jsonl");
}

// ---------------------------------------------------------------------------
// appendEvent
//
// Callers supply a LedgerEvent without identity_scheme_version; this function
// stamps the current IDENTITY_SCHEME_VERSION before writing. This makes the
// scheme version mandatory-on-read while freeing callers from knowing the
// version string. The returned value is the fully-stamped event as it landed
// on disk.
// ---------------------------------------------------------------------------

export async function appendEvent(
  vaultRoot: string,
  event: Omit<LedgerEvent, "identity_scheme_version">,
): Promise<Result<LedgerEvent, Error>> {
  const full: LedgerEvent = {
    finding_id: event.finding_id,
    event: event.event,
    by: event.by,
    principal_type: event.principal_type,
    at: event.at,
    against_fingerprint: event.against_fingerprint,
    identity_scheme_version: IDENTITY_SCHEME_VERSION,
    ...(event.rationale !== undefined ? { rationale: event.rationale } : {}),
    ...(event.expiry !== undefined ? { expiry: event.expiry } : {}),
    ...(event.owner !== undefined ? { owner: event.owner } : {}),
  };
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    await appendFile(boardDispositionsPath(vaultRoot), `${JSON.stringify(full)}\n`);
    return ok(full);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot append to board dispositions: ${reason}`));
  }
}

// ---------------------------------------------------------------------------
// LedgerData — the shape loadLedger returns.
//
// byFinding   — events for each finding_id, in append order (the history).
// flat        — all events across all findings, in file order.
//
// U4 consumes byFinding for reconciliation (LEFT JOIN against live findings);
// flat is provided for bulk scans (e.g. "all events in window").
// ---------------------------------------------------------------------------

export interface LedgerData {
  byFinding: Map<string, LedgerEvent[]>;
  flat: LedgerEvent[];
}

// ---------------------------------------------------------------------------
// loadLedger
// ---------------------------------------------------------------------------

export async function loadLedger(vaultRoot: string): Promise<Result<LedgerData, Error>> {
  let raw: string;
  try {
    raw = await readFile(boardDispositionsPath(vaultRoot), "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return ok({ byFinding: new Map(), flat: [] });
    }
    const reason = e instanceof Error ? e.message : String(e);
    return err(new Error(`cannot read board dispositions: ${reason}`));
  }

  const byFinding = new Map<string, LedgerEvent[]>();
  const flat: LedgerEvent[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt: LedgerEvent;
    try {
      evt = JSON.parse(trimmed) as LedgerEvent;
    } catch {
      // Corrupt line — skip it, keep the rest (failure isolation).
      continue;
    }
    // Basic structural guard: a line without finding_id or event is not a
    // valid LedgerEvent; skip rather than propagating a broken object.
    if (typeof evt.finding_id !== "string" || typeof evt.event !== "string") {
      continue;
    }
    const existing = byFinding.get(evt.finding_id);
    if (existing) {
      existing.push(evt);
    } else {
      byFinding.set(evt.finding_id, [evt]);
    }
    flat.push(evt);
  }

  return ok({ byFinding, flat });
}

// ---------------------------------------------------------------------------
// CurrentDispositionResult — what currentDisposition returns.
//
// Deliberately minimal: exposes the fields U4 needs for reconciliation
// without duplicating the full event. U4 owns column mapping and reopen/
// resolve emission — this is a faithful fold, not the reconciler.
// ---------------------------------------------------------------------------

export interface CurrentDispositionResult {
  /** The event type of the latest disposition. */
  event: LedgerEventType;
  /** Fingerprint from the latest disposition event (R10). */
  against_fingerprint: string;
  /** Expiry from the latest event that carries one (defer / dismiss with expiry). */
  expiry?: string;
  /** Latest owner from the most recent reassign event, if any. */
  owner?: string;
  /**
   * Whether the expiry has elapsed. Only set when `now` is provided.
   * false when there is no expiry regardless of `now`.
   * Feeds R9 in U4 (stale-defer detection).
   */
  expired: boolean;
  /** The full latest event, for callers that need the rest of the fields. */
  latestEvent: LedgerEvent;
}

// ---------------------------------------------------------------------------
// currentDisposition
//
// Folds an ordered list of events for ONE finding into its current state.
// The latest human/system event (by position in the list) determines the
// current column-ish state. Owner is tracked across reassign events: each
// reassign replaces the prior owner, so the last one wins.
//
// `now` is optional: when provided, `expired` reflects whether the latest
// expiry has elapsed. When omitted, `expired` is always false.
// ---------------------------------------------------------------------------

export function currentDisposition(events: LedgerEvent[], now?: Date): CurrentDispositionResult {
  if (events.length === 0) {
    throw new Error("currentDisposition: events array must not be empty");
  }

  // The latest event determines current state. The list is in append order
  // so the last element is the most recent.
  const latest = events[events.length - 1]!;

  // Track the most recent owner across all reassign events.
  let owner: string | undefined;
  for (const evt of events) {
    if (evt.event === "reassign" && evt.owner !== undefined) {
      owner = evt.owner;
    }
  }

  const expiry = latest.expiry;
  const expired =
    expiry !== undefined && now !== undefined ? Date.parse(expiry) < now.getTime() : false;

  return {
    event: latest.event,
    against_fingerprint: latest.against_fingerprint,
    ...(expiry !== undefined ? { expiry } : {}),
    ...(owner !== undefined ? { owner } : {}),
    expired,
    latestEvent: latest,
  };
}

// ---------------------------------------------------------------------------
// eventTimestamps — R12
//
// Derives first_seen / last_seen from the min/max `at` timestamps across
// a finding's events. Provided as a helper so U4 can compute ledger-side
// observation windows without duplicating the fold.
//
// Note: a finding may have a live first-observation independent of the ledger
// (e.g. from a detection run). This covers only the ledger-derived side.
// ---------------------------------------------------------------------------

export interface EventTimestamps {
  /** ISO 8601 — earliest `at` across all events for this finding. */
  first_seen: string;
  /** ISO 8601 — latest `at` across all events for this finding. */
  last_seen: string;
}

export function eventTimestamps(events: LedgerEvent[]): EventTimestamps {
  if (events.length === 0) {
    throw new Error("eventTimestamps: events array must not be empty");
  }
  let first = events[0]!.at;
  let last = events[0]!.at;
  for (const evt of events) {
    if (evt.at < first) first = evt.at;
    if (evt.at > last) last = evt.at;
  }
  return { first_seen: first, last_seen: last };
}
