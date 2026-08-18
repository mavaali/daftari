// reconcile.test.ts — TDD test suite for U4: Reconciliation engine.
//
// Tests are pure: all fixtures are constructed in-memory (Finding[] and
// Map<string, LedgerEvent[]>). No file I/O occurs here. This mirrors the
// pure-engine pattern from tension-triage.ts.
//
// Run with:
//   npx vitest run src/board/reconcile.test.ts

import { describe, expect, it } from "vitest";
import { IDENTITY_SCHEME_VERSION } from "./identity.js";
import { reconcile } from "./reconcile.js";
import type { BoardColumn, Finding, LedgerEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Fixture factories
// ---------------------------------------------------------------------------

let _findingSeq = 0;

/**
 * Build a minimal Finding with sensible defaults. Callers override only what
 * matters for the scenario under test.
 */
function makeFinding(overrides: Partial<Finding> & { identity_key?: string } = {}): Finding {
  const id = overrides.identity_key ?? `finding-${++_findingSeq}`;
  return {
    identity_key: id,
    source: "lint",
    check: "staleFiles",
    target: { kind: "lint", path: `path/to/file-${id}.md` },
    fingerprint: overrides.fingerprint ?? "fp-default",
    certainty: "medium",
    evidence: {},
    suggested_action: "review the file",
    verify_predicate: "re-run lint",
    owner: "alice",
    first_seen: "2024-01-01T00:00:00Z",
    last_seen: "2024-01-01T00:00:00Z",
    disposition: "new", // will be overwritten by reconcile
    history: [],
    ...overrides,
  };
}

/**
 * Build a fully-formed LedgerEvent. `identity_scheme_version` is always
 * stamped to IDENTITY_SCHEME_VERSION so tests reflect the real contract.
 */
function makeEvent(
  overrides: Partial<LedgerEvent> & {
    finding_id: string;
    event: LedgerEvent["event"];
  },
): LedgerEvent {
  return {
    finding_id: overrides.finding_id,
    event: overrides.event,
    by: overrides.by ?? "human:alice",
    principal_type: overrides.principal_type ?? "human",
    at: overrides.at ?? "2024-01-01T00:00:00Z",
    against_fingerprint: overrides.against_fingerprint ?? "fp-default",
    identity_scheme_version: IDENTITY_SCHEME_VERSION,
    ...(overrides.rationale !== undefined ? { rationale: overrides.rationale } : {}),
    ...(overrides.expiry !== undefined ? { expiry: overrides.expiry } : {}),
    ...(overrides.owner !== undefined ? { owner: overrides.owner } : {}),
  };
}

/**
 * Build a ledger map from an array of events. Groups by finding_id preserving
 * append order, exactly as loadLedger does.
 */
function buildLedger(events: LedgerEvent[]): Map<string, LedgerEvent[]> {
  const map = new Map<string, LedgerEvent[]>();
  for (const evt of events) {
    const existing = map.get(evt.finding_id);
    if (existing) {
      existing.push(evt);
    } else {
      map.set(evt.finding_id, [evt]);
    }
  }
  return map;
}

/** Convenience: apply emitted events back into the ledger map (simulates caller persisting). */
function applyEmits(
  ledger: Map<string, LedgerEvent[]>,
  emits: LedgerEvent[],
): Map<string, LedgerEvent[]> {
  // Clone to avoid mutating the original map between idempotency runs.
  const next = new Map<string, LedgerEvent[]>(
    Array.from(ledger.entries()).map(([k, v]) => [k, [...v]]),
  );
  for (const evt of emits) {
    const existing = next.get(evt.finding_id);
    if (existing) {
      existing.push(evt);
    } else {
      next.set(evt.finding_id, [evt]);
    }
  }
  return next;
}

const NOW = new Date("2024-06-01T12:00:00Z");

// ---------------------------------------------------------------------------
// CASE A — live finding, NO ledger events → column "new", no emit
// ---------------------------------------------------------------------------

describe("CASE A — live finding with no ledger events", () => {
  it("produces column 'new', no emitted events", () => {
    const finding = makeFinding({ identity_key: "f-a1", fingerprint: "fp-a1" });
    const ledger = new Map<string, LedgerEvent[]>();

    const { findings, emit } = reconcile([finding], ledger, NOW);

    expect(findings).toHaveLength(1);
    expect(findings[0]!.disposition).toBe<BoardColumn>("new");
    expect(findings[0]!.identity_key).toBe("f-a1");
    expect(emit).toHaveLength(0);
  });

  it("history is empty when no ledger events exist", () => {
    const finding = makeFinding({ identity_key: "f-a2" });
    const { findings } = reconcile([finding], new Map(), NOW);
    expect(findings[0]!.history).toHaveLength(0);
  });

  it("first_seen and last_seen come from the live finding when ledger is empty", () => {
    const finding = makeFinding({
      identity_key: "f-a3",
      first_seen: "2024-03-01T00:00:00Z",
      last_seen: "2024-03-15T00:00:00Z",
    });
    const { findings } = reconcile([finding], new Map(), NOW);
    expect(findings[0]!.first_seen).toBe("2024-03-01T00:00:00Z");
    expect(findings[0]!.last_seen).toBe("2024-03-15T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// CASE B — live finding WITH ledger events
// ---------------------------------------------------------------------------

describe("CASE B — accept → column 'accepted'", () => {
  it("accepted disposition maps to 'accepted' column", () => {
    const finding = makeFinding({ identity_key: "f-b1", fingerprint: "fp-b1" });
    const ledger = buildLedger([
      makeEvent({ finding_id: "f-b1", event: "new", against_fingerprint: "fp-b1" }),
      makeEvent({ finding_id: "f-b1", event: "accept", against_fingerprint: "fp-b1" }),
    ]);

    const { findings, emit } = reconcile([finding], ledger, NOW);

    expect(findings[0]!.disposition).toBe<BoardColumn>("accepted");
    expect(emit).toHaveLength(0);
  });

  it("history is populated from ledger events", () => {
    const finding = makeFinding({ identity_key: "f-b2", fingerprint: "fp-b2" });
    const events = [
      makeEvent({ finding_id: "f-b2", event: "new", against_fingerprint: "fp-b2" }),
      makeEvent({ finding_id: "f-b2", event: "accept", against_fingerprint: "fp-b2" }),
    ];
    const ledger = buildLedger(events);

    const { findings } = reconcile([finding], ledger, NOW);
    expect(findings[0]!.history).toHaveLength(2);
    expect(findings[0]!.history.map((e) => e.event)).toEqual(["new", "accept"]);
  });
});

describe("CASE B — defer → column 'waiting'", () => {
  it("active defer (unexpired) maps to 'waiting' column", () => {
    const finding = makeFinding({ identity_key: "f-b3", fingerprint: "fp-b3" });
    const futureExpiry = "2099-01-01T00:00:00Z";
    const ledger = buildLedger([
      makeEvent({
        finding_id: "f-b3",
        event: "defer",
        against_fingerprint: "fp-b3",
        expiry: futureExpiry,
      }),
    ]);

    const { findings, emit } = reconcile([finding], ledger, NOW);
    expect(findings[0]!.disposition).toBe<BoardColumn>("waiting");
    expect(emit).toHaveLength(0);
  });

  it("elapsed defer expiry → re-triage → column 'new' (R25)", () => {
    const finding = makeFinding({ identity_key: "f-b4", fingerprint: "fp-b4" });
    const pastExpiry = "2020-01-01T00:00:00Z"; // well before NOW
    const ledger = buildLedger([
      makeEvent({
        finding_id: "f-b4",
        event: "defer",
        against_fingerprint: "fp-b4",
        expiry: pastExpiry,
      }),
    ]);

    const { findings, emit } = reconcile([finding], ledger, NOW);
    expect(findings[0]!.disposition).toBe<BoardColumn>("new");
    expect(emit).toHaveLength(0);
  });

  it("defer with no expiry: active waiting, no expiry to check", () => {
    const finding = makeFinding({ identity_key: "f-b4b", fingerprint: "fp-b4b" });
    const ledger = buildLedger([
      makeEvent({ finding_id: "f-b4b", event: "defer", against_fingerprint: "fp-b4b" }),
    ]);
    const { findings } = reconcile([finding], ledger, NOW);
    // No expiry → not expired → stays waiting
    expect(findings[0]!.disposition).toBe<BoardColumn>("waiting");
  });
});

describe("CASE B — dismiss scenarios", () => {
  it("dismiss with matching fingerprint and no expiry → 'dismissed' column (R10)", () => {
    const finding = makeFinding({ identity_key: "f-b5", fingerprint: "fp-match" });
    const ledger = buildLedger([
      makeEvent({
        finding_id: "f-b5",
        event: "dismiss",
        against_fingerprint: "fp-match", // matches live fingerprint
      }),
    ]);

    const { findings, emit } = reconcile([finding], ledger, NOW);
    expect(findings[0]!.disposition).toBe<BoardColumn>("dismissed");
    expect(emit).toHaveLength(0);
  });

  it("dismiss with matching fingerprint and unexpired expiry → 'dismissed' column", () => {
    const finding = makeFinding({ identity_key: "f-b6", fingerprint: "fp-match2" });
    const futureExpiry = "2099-12-31T00:00:00Z";
    const ledger = buildLedger([
      makeEvent({
        finding_id: "f-b6",
        event: "dismiss",
        against_fingerprint: "fp-match2",
        expiry: futureExpiry,
      }),
    ]);

    const { findings, emit } = reconcile([finding], ledger, NOW);
    expect(findings[0]!.disposition).toBe<BoardColumn>("dismissed");
    expect(emit).toHaveLength(0);
  });

  it("dismiss with DRIFTED fingerprint → 're-triage' → column 'new', no duplicate card (R10)", () => {
    const finding = makeFinding({ identity_key: "f-b7", fingerprint: "fp-NEW" });
    const ledger = buildLedger([
      makeEvent({
        finding_id: "f-b7",
        event: "dismiss",
        against_fingerprint: "fp-OLD", // different from live fingerprint
      }),
    ]);

    const { findings, emit } = reconcile([finding], ledger, NOW);
    // Re-triage: column is new
    expect(findings[0]!.disposition).toBe<BoardColumn>("new");
    // No duplicate card — still exactly one finding
    expect(findings).toHaveLength(1);
    // No system event emitted for fingerprint drift
    expect(emit).toHaveLength(0);
    // History is preserved
    expect(findings[0]!.history).toHaveLength(1);
  });

  it("dismiss with ELAPSED expiry → column 'new' (R9)", () => {
    const finding = makeFinding({ identity_key: "f-b8", fingerprint: "fp-same" });
    const pastExpiry = "2020-01-01T00:00:00Z";
    const ledger = buildLedger([
      makeEvent({
        finding_id: "f-b8",
        event: "dismiss",
        against_fingerprint: "fp-same", // fingerprint matches
        expiry: pastExpiry, // but expiry has elapsed
      }),
    ]);

    const { findings, emit } = reconcile([finding], ledger, NOW);
    expect(findings[0]!.disposition).toBe<BoardColumn>("new");
    expect(emit).toHaveLength(0);
  });
});

describe("CASE B — resolved finding reappears in live set → reopened (R8)", () => {
  it("emits exactly one 'reopened' event; column reverts to prior human disposition", () => {
    const finding = makeFinding({ identity_key: "f-b9", fingerprint: "fp-b9" });
    const ledger = buildLedger([
      makeEvent({ finding_id: "f-b9", event: "new", against_fingerprint: "fp-b9" }),
      makeEvent({ finding_id: "f-b9", event: "accept", against_fingerprint: "fp-b9" }),
      makeEvent({
        finding_id: "f-b9",
        event: "resolved",
        against_fingerprint: "fp-b9",
        by: "system",
        principal_type: "system",
      }),
    ]);

    const { findings, emit } = reconcile([finding], ledger, NOW);

    // One reopened emitted
    expect(emit).toHaveLength(1);
    expect(emit[0]!.event).toBe("reopened");
    expect(emit[0]!.finding_id).toBe("f-b9");
    expect(emit[0]!.principal_type).toBe("system");
    expect(emit[0]!.by).toBe("system");
    expect(emit[0]!.against_fingerprint).toBe("fp-b9");
    expect(emit[0]!.identity_scheme_version).toBe(IDENTITY_SCHEME_VERSION);
    expect(emit[0]!.at).toBe(NOW.toISOString());

    // Column reverts to prior human disposition (accepted was the last human event)
    expect(findings[0]!.disposition).toBe<BoardColumn>("accepted");

    // History contains ledger events + the new reopened event
    const eventTypes = findings[0]!.history.map((e) => e.event);
    expect(eventTypes).toContain("new");
    expect(eventTypes).toContain("accept");
    expect(eventTypes).toContain("resolved");
    // The emitted reopened is NOT yet in history (caller hasn't persisted yet)
    // — this is the pure contract: history reflects ledger as-received.
  });

  it("column reverts to 'new' when there is no prior human disposition before resolved", () => {
    const finding = makeFinding({ identity_key: "f-b10", fingerprint: "fp-b10" });
    const ledger = buildLedger([
      makeEvent({
        finding_id: "f-b10",
        event: "resolved",
        against_fingerprint: "fp-b10",
        by: "system",
        principal_type: "system",
      }),
    ]);

    const { findings, emit } = reconcile([finding], ledger, NOW);
    expect(emit).toHaveLength(1);
    expect(emit[0]!.event).toBe("reopened");
    // No prior human event → reverts to new
    expect(findings[0]!.disposition).toBe<BoardColumn>("new");
  });

  it("already-reopened finding (latest is 'reopened') does NOT re-emit reopened", () => {
    // Scenario: reopened was already appended (second run after first run's emit was applied)
    const finding = makeFinding({ identity_key: "f-b11", fingerprint: "fp-b11" });
    const ledger = buildLedger([
      makeEvent({ finding_id: "f-b11", event: "accept", against_fingerprint: "fp-b11" }),
      makeEvent({
        finding_id: "f-b11",
        event: "resolved",
        against_fingerprint: "fp-b11",
        by: "system",
        principal_type: "system",
      }),
      makeEvent({
        finding_id: "f-b11",
        event: "reopened",
        against_fingerprint: "fp-b11",
        by: "system",
        principal_type: "system",
      }),
    ]);

    const { findings, emit } = reconcile([finding], ledger, NOW);
    // No second reopened
    expect(emit).toHaveLength(0);
    // Column is the disposition before reopened (accept → accepted)
    expect(findings[0]!.disposition).toBe<BoardColumn>("accepted");
  });
});

// ---------------------------------------------------------------------------
// CASE C — ledger events exist but finding is ABSENT from live set
// ---------------------------------------------------------------------------

describe("CASE C — accepted finding absent from live set → emit resolved", () => {
  it("emits exactly one 'resolved' event for an accepted-but-absent finding", () => {
    // No live findings — the finding disappeared
    const ledger = buildLedger([
      makeEvent({ finding_id: "f-c1", event: "new", against_fingerprint: "fp-c1" }),
      makeEvent({ finding_id: "f-c1", event: "accept", against_fingerprint: "fp-c1-v2" }),
    ]);

    const { findings, emit } = reconcile([], ledger, NOW);

    expect(emit).toHaveLength(1);
    expect(emit[0]!.event).toBe("resolved");
    expect(emit[0]!.finding_id).toBe("f-c1");
    expect(emit[0]!.principal_type).toBe("system");
    expect(emit[0]!.by).toBe("system");
    // against_fingerprint is the last known fingerprint from the ledger
    expect(emit[0]!.against_fingerprint).toBe("fp-c1-v2");
    expect(emit[0]!.identity_scheme_version).toBe(IDENTITY_SCHEME_VERSION);
    expect(emit[0]!.at).toBe(NOW.toISOString());

    // Resolved finding appears in findings with column 'resolved'
    const resolvedFindings = findings.filter((f) => f.disposition === "resolved");
    expect(resolvedFindings).toHaveLength(1);
    expect(resolvedFindings[0]!.identity_key).toBe("f-c1");
  });

  it("already-resolved and absent finding → no re-emit (idempotent, R6)", () => {
    // Simulates second run after resolved was already appended
    const ledger = buildLedger([
      makeEvent({ finding_id: "f-c2", event: "accept", against_fingerprint: "fp-c2" }),
      makeEvent({
        finding_id: "f-c2",
        event: "resolved",
        against_fingerprint: "fp-c2",
        by: "system",
        principal_type: "system",
      }),
    ]);

    const { emit } = reconcile([], ledger, NOW);
    expect(emit).toHaveLength(0);
  });

  it("dismissed-and-absent finding → no resolved emit, finding dropped", () => {
    // A dismissed finding that no longer reproduces is simply gone.
    const ledger = buildLedger([
      makeEvent({ finding_id: "f-c3", event: "dismiss", against_fingerprint: "fp-c3" }),
    ]);

    const { findings, emit } = reconcile([], ledger, NOW);
    expect(emit).toHaveLength(0);
    // Not included in findings (dismissed-and-gone is dropped per design decision)
    expect(findings.find((f) => f.identity_key === "f-c3")).toBeUndefined();
  });

  it("deferred-and-absent finding → no resolved emit, finding dropped", () => {
    const ledger = buildLedger([
      makeEvent({
        finding_id: "f-c4",
        event: "defer",
        against_fingerprint: "fp-c4",
        expiry: "2099-01-01T00:00:00Z",
      }),
    ]);

    const { findings, emit } = reconcile([], ledger, NOW);
    expect(emit).toHaveLength(0);
    expect(findings.find((f) => f.identity_key === "f-c4")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotency (R6 / R7) — two runs on unchanged inputs produce identical output
// ---------------------------------------------------------------------------

describe("Idempotency (R6 / R7)", () => {
  it("two runs with unchanged inputs produce identical findings and zero second-run emits", () => {
    // Scenario: accepted finding + resolved finding that reappears (reopened on first run)
    const liveFinding = makeFinding({ identity_key: "f-idem1", fingerprint: "fp-idem1" });
    const ledger = buildLedger([
      makeEvent({ finding_id: "f-idem1", event: "accept", against_fingerprint: "fp-idem1" }),
      makeEvent({
        finding_id: "f-idem1",
        event: "resolved",
        against_fingerprint: "fp-idem1",
        by: "system",
        principal_type: "system",
      }),
    ]);

    // First run
    const run1 = reconcile([liveFinding], ledger, NOW);
    expect(run1.emit).toHaveLength(1); // reopened emitted
    expect(run1.emit[0]!.event).toBe("reopened");

    // Apply emits (simulates caller persisting)
    const ledger2 = applyEmits(ledger, run1.emit);

    // Second run — same live findings, ledger now has the reopened event appended
    const run2 = reconcile([liveFinding], ledger2, NOW);
    expect(run2.emit).toHaveLength(0); // ZERO new emits
    expect(run2.findings).toHaveLength(run1.findings.length);
    expect(run2.findings[0]!.disposition).toBe(run1.findings[0]!.disposition);
    expect(run2.findings[0]!.identity_key).toBe(run1.findings[0]!.identity_key);
  });

  it("accepted-absent → resolve → second run: zero emits, same resolved output", () => {
    const ledger = buildLedger([
      makeEvent({ finding_id: "f-idem2", event: "accept", against_fingerprint: "fp-idem2" }),
    ]);

    // First run (no live findings → resolved emitted)
    const run1 = reconcile([], ledger, NOW);
    expect(run1.emit).toHaveLength(1);
    expect(run1.emit[0]!.event).toBe("resolved");

    const ledger2 = applyEmits(ledger, run1.emit);

    // Second run
    const run2 = reconcile([], ledger2, NOW);
    expect(run2.emit).toHaveLength(0);
    // Resolved finding still shows in findings (column resolved, no new emit)
    const resolvedFindings = run2.findings.filter((f) => f.disposition === "resolved");
    expect(resolvedFindings).toHaveLength(1);
    expect(resolvedFindings[0]!.identity_key).toBe("f-idem2");
  });

  it("two runs with completely unchanged inputs produce bit-identical findings", () => {
    const finding = makeFinding({ identity_key: "f-idem3", fingerprint: "fp-idem3" });
    const ledger = buildLedger([
      makeEvent({ finding_id: "f-idem3", event: "accept", against_fingerprint: "fp-idem3" }),
    ]);

    const run1 = reconcile([finding], ledger, NOW);
    const run2 = reconcile([finding], ledger, NOW);

    expect(JSON.stringify(run1.findings)).toBe(JSON.stringify(run2.findings));
    expect(JSON.stringify(run1.emit)).toBe(JSON.stringify(run2.emit));
  });
});

// ---------------------------------------------------------------------------
// Multiple findings — mix of cases in one call
// ---------------------------------------------------------------------------

describe("Multiple findings — mixed cases in one reconcile call", () => {
  it("handles new, accepted, dismissed, and resolved findings simultaneously", () => {
    const fNew = makeFinding({ identity_key: "f-mix-new", fingerprint: "fp-new" });
    const fAccepted = makeFinding({ identity_key: "f-mix-accepted", fingerprint: "fp-accepted" });
    const fDismissed = makeFinding({
      identity_key: "f-mix-dismissed",
      fingerprint: "fp-dismissed",
    });
    // f-mix-absent: accepted but not in live set → should emit resolved
    const ledger = buildLedger([
      makeEvent({
        finding_id: "f-mix-accepted",
        event: "accept",
        against_fingerprint: "fp-accepted",
      }),
      makeEvent({
        finding_id: "f-mix-dismissed",
        event: "dismiss",
        against_fingerprint: "fp-dismissed",
      }),
      makeEvent({
        finding_id: "f-mix-absent",
        event: "accept",
        against_fingerprint: "fp-absent",
      }),
    ]);

    const { findings, emit } = reconcile([fNew, fAccepted, fDismissed], ledger, NOW);

    const byKey = new Map(findings.map((f) => [f.identity_key, f]));
    expect(byKey.get("f-mix-new")!.disposition).toBe<BoardColumn>("new");
    expect(byKey.get("f-mix-accepted")!.disposition).toBe<BoardColumn>("accepted");
    expect(byKey.get("f-mix-dismissed")!.disposition).toBe<BoardColumn>("dismissed");

    // Resolved finding (absent from live) shows with column resolved
    expect(byKey.get("f-mix-absent")!.disposition).toBe<BoardColumn>("resolved");

    // One resolved event emitted for f-mix-absent
    expect(emit).toHaveLength(1);
    expect(emit[0]!.event).toBe("resolved");
    expect(emit[0]!.finding_id).toBe("f-mix-absent");
  });
});

// ---------------------------------------------------------------------------
// No duplicate cards on fingerprint drift (R10) — additional guard
// ---------------------------------------------------------------------------

describe("No duplicate cards on fingerprint drift (R10)", () => {
  it("drifted fingerprint does not produce a second card — still exactly one finding", () => {
    // Live finding has fingerprint fp-v2; ledger dismiss used fp-v1
    const finding = makeFinding({ identity_key: "f-drift", fingerprint: "fp-v2" });
    const ledger = buildLedger([
      makeEvent({ finding_id: "f-drift", event: "dismiss", against_fingerprint: "fp-v1" }),
    ]);

    const { findings } = reconcile([finding], ledger, NOW);
    const driftFindings = findings.filter((f) => f.identity_key === "f-drift");
    expect(driftFindings).toHaveLength(1);
    expect(driftFindings[0]!.disposition).toBe<BoardColumn>("new");
  });
});

// ---------------------------------------------------------------------------
// first_seen / last_seen — derived from ledger events when available
// ---------------------------------------------------------------------------

describe("first_seen / last_seen derivation", () => {
  it("uses min/max 'at' from ledger events when events exist", () => {
    const finding = makeFinding({ identity_key: "f-ts1", fingerprint: "fp-ts1" });
    const ledger = buildLedger([
      makeEvent({
        finding_id: "f-ts1",
        event: "new",
        at: "2024-02-01T00:00:00Z",
        against_fingerprint: "fp-ts1",
      }),
      makeEvent({
        finding_id: "f-ts1",
        event: "accept",
        at: "2024-04-15T00:00:00Z",
        against_fingerprint: "fp-ts1",
      }),
    ]);

    const { findings } = reconcile([finding], ledger, NOW);
    expect(findings[0]!.first_seen).toBe("2024-02-01T00:00:00Z");
    expect(findings[0]!.last_seen).toBe("2024-04-15T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// Emit event shape — fully-formed LedgerEvents
// ---------------------------------------------------------------------------

describe("Emitted event shape", () => {
  it("emitted 'reopened' event has all required LedgerEvent fields", () => {
    const finding = makeFinding({ identity_key: "f-shape-reopen", fingerprint: "fp-sr" });
    const ledger = buildLedger([
      makeEvent({
        finding_id: "f-shape-reopen",
        event: "accept",
        against_fingerprint: "fp-sr",
      }),
      makeEvent({
        finding_id: "f-shape-reopen",
        event: "resolved",
        against_fingerprint: "fp-sr",
        by: "system",
        principal_type: "system",
      }),
    ]);

    const { emit } = reconcile([finding], ledger, NOW);
    expect(emit).toHaveLength(1);
    const evt = emit[0]!;
    expect(evt.finding_id).toBe("f-shape-reopen");
    expect(evt.event).toBe("reopened");
    expect(typeof evt.by).toBe("string");
    expect(evt.principal_type).toBe("system");
    expect(typeof evt.at).toBe("string");
    expect(typeof evt.against_fingerprint).toBe("string");
    expect(evt.identity_scheme_version).toBe(IDENTITY_SCHEME_VERSION);
  });

  it("emitted 'resolved' event has all required LedgerEvent fields", () => {
    const ledger = buildLedger([
      makeEvent({
        finding_id: "f-shape-resolved",
        event: "accept",
        against_fingerprint: "fp-shape",
      }),
    ]);

    const { emit } = reconcile([], ledger, NOW);
    expect(emit).toHaveLength(1);
    const evt = emit[0]!;
    expect(evt.finding_id).toBe("f-shape-resolved");
    expect(evt.event).toBe("resolved");
    expect(evt.principal_type).toBe("system");
    expect(evt.by).toBe("system");
    expect(evt.at).toBe(NOW.toISOString());
    expect(evt.against_fingerprint).toBe("fp-shape");
    expect(evt.identity_scheme_version).toBe(IDENTITY_SCHEME_VERSION);
  });
});
