// reconcile.ts — U4: Reconciliation engine.
//
// PURE function: no filesystem access, no Date.now() calls, no side effects.
// Takes live findings + a ledger snapshot + a clock injection (`now`) and
// returns:
//   findings — reconciled board cards (stamped with disposition, history,
//              first_seen/last_seen). One card per distinct identity_key.
//   emit     — NEW system-authored LedgerEvents the CALLER must append to
//              the ledger. reconcile never writes; the caller persists emit.
//
// Follows the pure-engine + async-loader split from tension-triage.ts:
// all vault I/O lives in the board engine (U9); this module is pure logic.
//
// CASE C design decision (resolved-but-absent findings)
// -------------------------------------------------------
// When an accepted finding disappears from the live set, we emit a system
// "resolved" event and include a "skeleton" Finding in `findings` with
// column "resolved". The skeleton is reconstructed from the ledger's last
// known event data (finding_id, against_fingerprint, history). Fields that
// are only known to the source adapter (target, evidence, suggested_action,
// verify_predicate, certainty, source, check, owner) are filled with safe
// placeholder values so the type is satisfied and the board can render a
// Resolved column entry. U9 (the board engine) may enrich these skeletons
// from a persisted findings cache if one exists; for now the skeleton is the
// minimal representation. This is documented here so U9 knows to expect it.
//
// Dismissed-and-absent and deferred-and-absent findings are DROPPED from the
// output (not shown). Rationale: a dismissed finding that no longer reproduces
// has been vindicated — it needs no board presence. A deferred-and-absent
// finding is similarly gone; the defer was speculative. If U9 or a later unit
// needs to surface these, the ledger is the authoritative source.

import { IDENTITY_SCHEME_VERSION } from "./identity.js";
import { currentDisposition, eventTimestamps } from "./ledger.js";
import type { BoardColumn, Finding, FindingDescriptor, LedgerEvent } from "./types.js";

// ---------------------------------------------------------------------------
// ReconcileResult
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  /** Fully reconciled board findings. Each has disposition, history, timestamps. */
  findings: Finding[];
  /**
   * System-authored events to append. The caller (U9) must persist these
   * before the next reconcile call to preserve idempotency (R6/R7).
   */
  emit: LedgerEvent[];
}

// ---------------------------------------------------------------------------
// priorHumanDisposition
//
// Walks an event list (in append order) to find the latest HUMAN-authored
// disposition BEFORE the most recent "resolved" (or "reopened") event.
// Returns the BoardColumn that corresponds to that prior state, or "new"
// if no prior human event exists.
//
// Used for the reopen case: when a resolved finding reappears, the column
// reverts to whatever the human last decided before the resolution.
// ---------------------------------------------------------------------------

function priorHumanDisposition(events: LedgerEvent[]): BoardColumn {
  // Scan in reverse to find the latest "resolved" or "reopened" marker,
  // then keep scanning to find the human event before it.
  let passedMarker = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i]!;
    if (!passedMarker) {
      if (evt.event === "resolved" || evt.event === "reopened") {
        passedMarker = true;
      }
      continue;
    }
    // We are now looking at events before the marker.
    switch (evt.event) {
      case "accept":
        return "accepted";
      case "defer":
        return "waiting";
      case "dismiss":
        return "dismissed";
      // "new", "reopened", "resolved", "reassign" don't map to a stable human column.
    }
  }
  return "new";
}

// ---------------------------------------------------------------------------
// columnForLiveWithLedger
//
// Derives the BoardColumn for a live finding that HAS ledger events.
// Returns { column, shouldEmitReopen } — the caller handles emit assembly.
// ---------------------------------------------------------------------------

function columnForLiveWithLedger(
  finding: Finding,
  events: LedgerEvent[],
  now: Date,
): { column: BoardColumn; shouldEmitReopen: boolean } {
  const disp = currentDisposition(events, now);

  switch (disp.event) {
    case "accept":
      return { column: "accepted", shouldEmitReopen: false };

    case "defer": {
      // An elapsed defer expiry re-surfaces the finding for re-triage.
      if (disp.expired) {
        return { column: "new", shouldEmitReopen: false };
      }
      return { column: "waiting", shouldEmitReopen: false };
    }

    case "dismiss": {
      // Three-way check (R9, R10):
      //   1. Fingerprint drifted → re-triage (new), history preserved.
      //   2. Expiry elapsed → re-triage (new).
      //   3. Otherwise → dismissed.
      const fingerprintDrifted = disp.against_fingerprint !== finding.fingerprint;
      if (fingerprintDrifted || disp.expired) {
        return { column: "new", shouldEmitReopen: false };
      }
      return { column: "dismissed", shouldEmitReopen: false };
    }

    case "resolved":
      // Finding reproduced after being resolved → emit reopened (R8).
      return { column: priorHumanDisposition(events), shouldEmitReopen: true };

    case "reopened":
      // Already reopened (second run after first run persisted the event).
      // Don't re-emit. Column is the disposition before the reopened marker.
      return { column: priorHumanDisposition(events), shouldEmitReopen: false };

    case "new":
    case "reassign":
    default:
      // "new" system event or reassign as latest — treat as new for column.
      return { column: "new", shouldEmitReopen: false };
  }
}

// ---------------------------------------------------------------------------
// buildSystemEvent — factory for system-authored LedgerEvents.
// ---------------------------------------------------------------------------

function buildSystemEvent(
  finding_id: string,
  event: "resolved" | "reopened",
  against_fingerprint: string,
  now: Date,
  descriptor?: FindingDescriptor,
): LedgerEvent {
  return {
    finding_id,
    event,
    by: "system",
    principal_type: "system",
    at: now.toISOString(),
    against_fingerprint,
    identity_scheme_version: IDENTITY_SCHEME_VERSION,
    ...(descriptor !== undefined ? { descriptor } : {}),
  };
}

// ---------------------------------------------------------------------------
// latestDescriptor — walks events BACKWARD to find the latest descriptor.
//
// Returns the descriptor from the most recent event that carries one, or
// undefined if no event in the list has a descriptor. This is needed because
// U11 stamps descriptors on human disposition events; system events
// (new/resolved/reopened) may or may not carry one (they forward from the
// latest human-stamped event). Walk backward so we find the newest first.
// ---------------------------------------------------------------------------

function latestDescriptor(events: LedgerEvent[]): FindingDescriptor | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i]!;
    if (evt.descriptor !== undefined) {
      return evt.descriptor;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// skeletonFinding — minimal Finding for a resolved-but-absent finding.
//
// See CASE C design decision at the top of this file. When a descriptor is
// present on any ledger event, the real source/check/target/label are used.
// If NO event carries a descriptor (older/edge data), a sentinel source
// "staleness" is used (not "lint") so callers can detect the placeholder
// rather than assuming a misleading check category. U9 may enrich these
// skeletons from a persisted findings cache.
// ---------------------------------------------------------------------------

function skeletonFinding(identity_key: string, events: LedgerEvent[]): Finding {
  const ts = eventTimestamps(events);
  const lastEvent = events[events.length - 1]!;

  // Walk backward to find the latest owner from any reassign event, or fall
  // back to the last event's owner field.
  let owner: string | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i]!;
    if (evt.owner !== undefined) {
      owner = evt.owner;
      break;
    }
  }

  const desc = latestDescriptor(events);

  if (desc !== undefined) {
    return {
      identity_key,
      source: desc.source,
      check: desc.check,
      target: desc.target,
      fingerprint: lastEvent.against_fingerprint,
      certainty: "medium", // not stored in descriptor; placeholder is acceptable
      evidence: {},
      suggested_action: "",
      verify_predicate: "",
      owner: owner ?? "",
      first_seen: ts.first_seen,
      last_seen: ts.last_seen,
      disposition: "resolved",
      history: events,
    };
  }

  // No descriptor on any event (older/edge data). Use explicit sentinel values
  // so callers can distinguish "no descriptor available" from a real finding.
  // "staleness" is used as the sentinel source (NOT "lint") so it is visually
  // distinguishable and does not mislead renderers into treating the skeleton
  // as a lint finding. U9 may override these from a persisted findings cache.
  return {
    identity_key,
    source: "staleness", // sentinel — real source not recoverable; no descriptor on ledger
    check: "unknown", // placeholder — real check not recoverable without descriptor
    target: { kind: "staleness", path: identity_key }, // placeholder
    fingerprint: lastEvent.against_fingerprint,
    certainty: "medium", // placeholder
    evidence: {},
    suggested_action: "",
    verify_predicate: "",
    owner: owner ?? "",
    first_seen: ts.first_seen,
    last_seen: ts.last_seen,
    disposition: "resolved",
    history: events,
  };
}

// ---------------------------------------------------------------------------
// reconcile — the pure engine.
// ---------------------------------------------------------------------------

export function reconcile(
  liveFindings: Finding[],
  ledgerByIdentity: Map<string, LedgerEvent[]>,
  now: Date,
): ReconcileResult {
  const findings: Finding[] = [];
  const emit: LedgerEvent[] = [];

  // Index live findings by identity_key for O(1) lookup in CASE C.
  const liveByKey = new Map<string, Finding>(liveFindings.map((f) => [f.identity_key, f]));

  // --- CASE A + CASE B: iterate over live findings ---

  for (const finding of liveFindings) {
    const events = ledgerByIdentity.get(finding.identity_key);

    if (!events || events.length === 0) {
      // CASE A — no ledger history at all → column "new".
      findings.push({
        ...finding,
        disposition: "new",
        history: [],
      });
      continue;
    }

    // CASE B — live + ledger events.
    const ts = eventTimestamps(events);
    const { column, shouldEmitReopen } = columnForLiveWithLedger(finding, events, now);

    if (shouldEmitReopen) {
      // Carry the descriptor forward so the reopened card keeps its display identity.
      const desc = latestDescriptor(events);
      emit.push(buildSystemEvent(finding.identity_key, "reopened", finding.fingerprint, now, desc));
    }

    findings.push({
      ...finding,
      disposition: column,
      history: events,
      first_seen: ts.first_seen,
      last_seen: ts.last_seen,
    });
  }

  // --- CASE C: iterate over ledger keys NOT present in the live set ---

  for (const [identity_key, events] of ledgerByIdentity) {
    if (liveByKey.has(identity_key)) {
      // Already handled in CASE A/B above.
      continue;
    }

    // Finding is absent from the live set.
    const disp = currentDisposition(events, now);

    if (disp.event === "accept") {
      // Accepted finding no longer reproduces → emit resolved (CASE C, authorized-fix path).
      // Carry the descriptor forward so the resolved card can render its display identity.
      const desc = latestDescriptor(events);
      emit.push(buildSystemEvent(identity_key, "resolved", disp.against_fingerprint, now, desc));
      // Include a skeleton resolved finding so the board can show a Resolved column.
      findings.push(skeletonFinding(identity_key, events));
      continue;
    }

    if (disp.event === "resolved") {
      // Already resolved and still absent → idempotent, no re-emit (R6).
      // Still include it in findings so the Resolved column remains visible.
      findings.push(skeletonFinding(identity_key, events));
      continue;
    }

    // For "reopened" latest event + absent: the finding reproduced then disappeared.
    // Treat like accepted (the human intent was to fix it) → emit resolved.
    if (disp.event === "reopened") {
      // Carry the descriptor forward so the resolved card keeps its display identity.
      const desc = latestDescriptor(events);
      emit.push(buildSystemEvent(identity_key, "resolved", disp.against_fingerprint, now, desc));
      findings.push(skeletonFinding(identity_key, events));
    }

    // dismiss / defer / new / reassign — absent from live set → drop silently.
    // See CASE C design decision at the top of this file.
  }

  return { findings, emit };
}
