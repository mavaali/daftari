// ledger.test.ts — TDD test suite for U3: Disposition ledger.
//
// All scenarios from the plan are covered below. Tests use real file I/O via a
// temp directory so the full round-trip (write → new load call → identical
// state) is exercised, proving restart survival.
//
// Run with:
//   npx vitest run src/board/ledger.test.ts

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDENTITY_SCHEME_VERSION } from "./identity.js";
import {
  appendEvent,
  boardDispositionsPath,
  currentDisposition,
  eventTimestamps,
  loadLedger,
} from "./ledger.js";
import type { LedgerEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(
  overrides: Partial<LedgerEvent> & { finding_id: string; event: LedgerEvent["event"] },
): Omit<LedgerEvent, "identity_scheme_version"> {
  return {
    finding_id: overrides.finding_id,
    event: overrides.event,
    by: overrides.by ?? "human:alice",
    principal_type: overrides.principal_type ?? "human",
    at: overrides.at ?? new Date().toISOString(),
    against_fingerprint: overrides.against_fingerprint ?? "fp-abc123",
    ...(overrides.rationale !== undefined ? { rationale: overrides.rationale } : {}),
    ...(overrides.expiry !== undefined ? { expiry: overrides.expiry } : {}),
    ...(overrides.owner !== undefined ? { owner: overrides.owner } : {}),
  };
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let vaultRoot: string;

beforeEach(() => {
  vaultRoot = mkdtempSync(join(tmpdir(), "daftari-ledger-"));
});

afterEach(() => {
  rmSync(vaultRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. boardDispositionsPath — path helper
// ---------------------------------------------------------------------------

describe("boardDispositionsPath", () => {
  it("returns .daftari/board-dispositions.jsonl under vaultRoot", () => {
    expect(boardDispositionsPath("/vault")).toBe("/vault/.daftari/board-dispositions.jsonl");
  });
});

// ---------------------------------------------------------------------------
// 2. appendEvent — stamps identity_scheme_version; round-trips through disk
// ---------------------------------------------------------------------------

describe("appendEvent + loadLedger — basic round-trip", () => {
  it("appends one event; loadLedger returns it with identity_scheme_version stamped", async () => {
    const input = makeEvent({ finding_id: "finding-001", event: "new" });
    const result = await appendEvent(vaultRoot, input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.identity_scheme_version).toBe(IDENTITY_SCHEME_VERSION);
    expect(result.value.finding_id).toBe("finding-001");
    expect(result.value.event).toBe("new");

    // Reload from disk — simulates process restart
    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("finding-001");
    expect(events).toBeDefined();
    expect(events).toHaveLength(1);
    const evt = events![0]!;
    expect(evt.identity_scheme_version).toBe(IDENTITY_SCHEME_VERSION);
    expect(evt.event).toBe("new");
    expect(evt.against_fingerprint).toBe("fp-abc123");
  });

  it("appends multiple events for one finding; order is preserved", async () => {
    const e1 = makeEvent({ finding_id: "f-1", event: "new", at: "2024-01-01T00:00:00Z" });
    const e2 = makeEvent({ finding_id: "f-1", event: "accept", at: "2024-01-02T00:00:00Z" });
    const e3 = makeEvent({ finding_id: "f-1", event: "dismiss", at: "2024-01-03T00:00:00Z" });

    await appendEvent(vaultRoot, e1);
    await appendEvent(vaultRoot, e2);
    await appendEvent(vaultRoot, e3);

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-1");
    expect(events).toHaveLength(3);
    expect(events!.map((e) => e.event)).toEqual(["new", "accept", "dismiss"]);
  });

  it("appends events for multiple findings; each finding's list is independent", async () => {
    await appendEvent(vaultRoot, makeEvent({ finding_id: "f-A", event: "new" }));
    await appendEvent(vaultRoot, makeEvent({ finding_id: "f-B", event: "new" }));
    await appendEvent(vaultRoot, makeEvent({ finding_id: "f-A", event: "accept" }));

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.byFinding.get("f-A")).toHaveLength(2);
    expect(loaded.value.byFinding.get("f-B")).toHaveLength(1);
  });

  it("missing log file is not an error — returns empty map", async () => {
    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.byFinding.size).toBe(0);
    expect(loaded.value.flat).toHaveLength(0);
  });

  it("flat list in loadLedger contains all events in append order", async () => {
    await appendEvent(vaultRoot, makeEvent({ finding_id: "f-A", event: "new" }));
    await appendEvent(vaultRoot, makeEvent({ finding_id: "f-B", event: "new" }));
    await appendEvent(vaultRoot, makeEvent({ finding_id: "f-A", event: "accept" }));

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.flat).toHaveLength(3);
    expect(loaded.value.flat.map((e) => e.finding_id)).toEqual(["f-A", "f-B", "f-A"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Restart survival — write then load in a fresh call (R30)
// ---------------------------------------------------------------------------

describe("restart survival (R30)", () => {
  it("reload from disk after write yields identical state", async () => {
    const events = [
      makeEvent({
        finding_id: "r30",
        event: "new",
        at: "2024-06-01T10:00:00Z",
        against_fingerprint: "fp-v1",
      }),
      makeEvent({
        finding_id: "r30",
        event: "accept",
        at: "2024-06-01T11:00:00Z",
        against_fingerprint: "fp-v1",
        rationale: "looks good",
      }),
      makeEvent({
        finding_id: "r30",
        event: "defer",
        at: "2024-06-01T12:00:00Z",
        against_fingerprint: "fp-v1",
        expiry: "2024-07-01T00:00:00Z",
      }),
    ];

    for (const e of events) {
      await appendEvent(vaultRoot, e);
    }

    // First load
    const load1 = await loadLedger(vaultRoot);
    expect(load1.ok).toBe(true);
    if (!load1.ok) return;
    const firstEvents = load1.value.byFinding.get("r30");

    // Second load — simulates process restart
    const load2 = await loadLedger(vaultRoot);
    expect(load2.ok).toBe(true);
    if (!load2.ok) return;
    const secondEvents = load2.value.byFinding.get("r30");

    expect(JSON.stringify(secondEvents)).toBe(JSON.stringify(firstEvents));
  });
});

// ---------------------------------------------------------------------------
// 4. currentDisposition — fold history to latest state
// ---------------------------------------------------------------------------

describe("currentDisposition — accept → defer → dismiss folds to dismissed (R30)", () => {
  it("returns dismissed after accept → defer → dismiss sequence", async () => {
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-seq",
        event: "new",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-seq",
        event: "accept",
        at: "2024-01-02T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-seq",
        event: "defer",
        at: "2024-01-03T00:00:00Z",
        against_fingerprint: "fp-1",
        expiry: "2024-06-01T00:00:00Z",
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-seq",
        event: "dismiss",
        at: "2024-01-04T00:00:00Z",
        against_fingerprint: "fp-2",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-seq")!;
    const disp = currentDisposition(events);

    expect(disp.event).toBe("dismiss");
    expect(disp.against_fingerprint).toBe("fp-2");
    // A plain dismiss (no expiry field) establishes a new disposition with no timer:
    // it REPLACES the prior defer's standing expiry — permanent dismissal carries no timer.
    expect(disp.expiry).toBeUndefined();
  });

  it("full ordered history is preserved — same state survives reload (R30)", async () => {
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-reload",
        event: "new",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-0",
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-reload",
        event: "accept",
        at: "2024-01-02T00:00:00Z",
        against_fingerprint: "fp-0",
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-reload",
        event: "dismiss",
        at: "2024-01-03T00:00:00Z",
        against_fingerprint: "fp-0",
      }),
    );

    // Reload (restart simulation) and fold again
    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-reload")!;
    expect(events).toHaveLength(3);
    const disp = currentDisposition(events);
    expect(disp.event).toBe("dismiss");
  });
});

describe("currentDisposition — against_fingerprint comes from latest event (R10)", () => {
  it("carries the fingerprint from the most recent disposition event", async () => {
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-fp",
        event: "new",
        against_fingerprint: "fp-v1",
        at: "2024-01-01T00:00:00Z",
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-fp",
        event: "accept",
        against_fingerprint: "fp-v2",
        at: "2024-01-02T00:00:00Z",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-fp")!;
    const disp = currentDisposition(events);
    expect(disp.against_fingerprint).toBe("fp-v2");
  });
});

describe("currentDisposition — expiry exposure", () => {
  it("expiry from defer is exposed on currentDisposition", async () => {
    const expiry = "2025-12-31T23:59:59Z";
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-exp",
        event: "new",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-exp",
        event: "defer",
        at: "2024-01-02T00:00:00Z",
        against_fingerprint: "fp-1",
        expiry,
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-exp")!;
    const disp = currentDisposition(events);
    expect(disp.event).toBe("defer");
    expect(disp.expiry).toBe(expiry);
  });

  it("dismiss with past-dated expiry: expired flag is true (R9 feed)", async () => {
    const pastExpiry = "2020-01-01T00:00:00Z";
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-past",
        event: "dismiss",
        at: "2019-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
        expiry: pastExpiry,
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-past")!;
    const now = new Date("2024-06-01T00:00:00Z");
    const disp = currentDisposition(events, now);
    expect(disp.expiry).toBe(pastExpiry);
    expect(disp.expired).toBe(true);
  });

  it("defer with future expiry: expired flag is false", async () => {
    const futureExpiry = "2099-01-01T00:00:00Z";
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-future",
        event: "defer",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
        expiry: futureExpiry,
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-future")!;
    const now = new Date("2024-06-01T00:00:00Z");
    const disp = currentDisposition(events, now);
    expect(disp.expired).toBe(false);
  });

  it("no expiry on event: expired is false", async () => {
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-noexp",
        event: "accept",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-noexp")!;
    const disp = currentDisposition(events, new Date());
    expect(disp.expired).toBe(false);
  });
});

describe("currentDisposition — owner tracking", () => {
  it("carries owner from latest reassign event", async () => {
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-own",
        event: "new",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-own",
        event: "reassign",
        at: "2024-01-02T00:00:00Z",
        against_fingerprint: "fp-1",
        owner: "bob",
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-own",
        event: "reassign",
        at: "2024-01-03T00:00:00Z",
        against_fingerprint: "fp-1",
        owner: "carol",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-own")!;
    const disp = currentDisposition(events);
    expect(disp.owner).toBe("carol");
  });

  it("no reassign event: owner is undefined", async () => {
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-noown",
        event: "new",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-noown")!;
    const disp = currentDisposition(events);
    expect(disp.owner).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Corrupt line isolation — other events still load
// ---------------------------------------------------------------------------

describe("corrupt line isolation", () => {
  it("one malformed JSONL line → other events still load correctly", async () => {
    // Write two valid events, then inject a corrupt line, then a third valid event
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-good1",
        event: "new",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-good2",
        event: "new",
        at: "2024-01-02T00:00:00Z",
        against_fingerprint: "fp-2",
      }),
    );

    // Directly append a corrupt line to the file
    const { appendFileSync } = await import("node:fs");
    const filePath = boardDispositionsPath(vaultRoot);
    appendFileSync(filePath, "THIS IS NOT JSON\n");

    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-good3",
        event: "accept",
        at: "2024-01-03T00:00:00Z",
        against_fingerprint: "fp-3",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // All three valid findings should be present; corrupt line is silently skipped
    expect(loaded.value.byFinding.has("f-good1")).toBe(true);
    expect(loaded.value.byFinding.has("f-good2")).toBe(true);
    expect(loaded.value.byFinding.has("f-good3")).toBe(true);
    // Flat list has exactly 3 events (corrupt line dropped)
    expect(loaded.value.flat).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 6. eventTimestamps — first_seen / last_seen derivable from events (R12)
// ---------------------------------------------------------------------------

describe("eventTimestamps — first_seen and last_seen (R12)", () => {
  it("returns min/max timestamps from a finding's events", async () => {
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-ts",
        event: "new",
        at: "2024-03-01T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-ts",
        event: "accept",
        at: "2024-04-01T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-ts",
        event: "dismiss",
        at: "2024-05-01T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-ts")!;
    const ts = eventTimestamps(events);
    expect(ts.first_seen).toBe("2024-03-01T00:00:00Z");
    expect(ts.last_seen).toBe("2024-05-01T00:00:00Z");
  });

  it("single event: first_seen === last_seen", async () => {
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-one",
        event: "new",
        at: "2024-06-15T12:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-one")!;
    const ts = eventTimestamps(events);
    expect(ts.first_seen).toBe("2024-06-15T12:00:00Z");
    expect(ts.last_seen).toBe("2024-06-15T12:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// 7. appendEvent — .daftari dir is created if absent
// ---------------------------------------------------------------------------

describe("appendEvent — creates .daftari dir idempotently", () => {
  it("succeeds even if .daftari does not exist yet", async () => {
    // vaultRoot is fresh — no .daftari subdir
    const result = await appendEvent(
      vaultRoot,
      makeEvent({ finding_id: "f-dir", event: "new", against_fingerprint: "fp-1" }),
    );
    expect(result.ok).toBe(true);
  });

  it("append is idempotent wrt dir creation — second append also succeeds", async () => {
    await appendEvent(
      vaultRoot,
      makeEvent({ finding_id: "f-dir2", event: "new", against_fingerprint: "fp-1" }),
    );
    const r2 = await appendEvent(
      vaultRoot,
      makeEvent({ finding_id: "f-dir2", event: "accept", against_fingerprint: "fp-1" }),
    );
    expect(r2.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. appendEvent — preserves optional fields faithfully
// ---------------------------------------------------------------------------

describe("appendEvent — optional field preservation", () => {
  it("rationale and expiry round-trip through the file", async () => {
    const input = makeEvent({
      finding_id: "f-opts",
      event: "defer",
      rationale: "waiting on upstream fix",
      expiry: "2025-03-01T00:00:00Z",
      against_fingerprint: "fp-x",
    });
    await appendEvent(vaultRoot, input);

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-opts")!;
    expect(events[0]!.rationale).toBe("waiting on upstream fix");
    expect(events[0]!.expiry).toBe("2025-03-01T00:00:00Z");
  });
});

// ---------------------------------------------------------------------------
// 9. loadLedger — structural guard: lines missing against_fingerprint or at
//    are skipped; other valid events in the same file still load.
// ---------------------------------------------------------------------------

describe("loadLedger — structural guard for against_fingerprint and at", () => {
  it("a valid-JSON line missing against_fingerprint is skipped; other events load", async () => {
    const { appendFileSync, mkdirSync: mkdirSyncFs } = await import("node:fs");
    const { join: joinPath } = await import("node:path");
    const filePath = boardDispositionsPath(vaultRoot);

    // Manually ensure .daftari dir exists
    mkdirSyncFs(joinPath(vaultRoot, ".daftari"), { recursive: true });

    // Write a valid event first via appendEvent
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-guard-good1",
        event: "new",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-ok",
      }),
    );

    // Inject a JSON line that parses but has no against_fingerprint
    appendFileSync(
      filePath,
      JSON.stringify({
        finding_id: "f-guard-bad1",
        event: "new",
        by: "human:alice",
        principal_type: "human",
        at: "2024-01-02T00:00:00Z",
        // against_fingerprint intentionally omitted
        identity_scheme_version: "v1",
      }) + "\n",
    );

    // Write another valid event after the bad line
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-guard-good2",
        event: "accept",
        at: "2024-01-03T00:00:00Z",
        against_fingerprint: "fp-ok2",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    // The line missing against_fingerprint must be skipped
    expect(loaded.value.byFinding.has("f-guard-bad1")).toBe(false);
    // Valid events still present
    expect(loaded.value.byFinding.has("f-guard-good1")).toBe(true);
    expect(loaded.value.byFinding.has("f-guard-good2")).toBe(true);
    // Flat list has exactly 2 events (bad line dropped)
    expect(loaded.value.flat).toHaveLength(2);
  });

  it("a valid-JSON line missing at is skipped; other events load", async () => {
    const { appendFileSync } = await import("node:fs");
    const filePath = boardDispositionsPath(vaultRoot);

    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-guard-at-good",
        event: "new",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-ok",
      }),
    );

    // Inject a JSON line that parses but has no at field
    appendFileSync(
      filePath,
      JSON.stringify({
        finding_id: "f-guard-at-bad",
        event: "new",
        by: "human:alice",
        principal_type: "human",
        // at intentionally omitted
        against_fingerprint: "fp-missing-at",
        identity_scheme_version: "v1",
      }) + "\n",
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.byFinding.has("f-guard-at-bad")).toBe(false);
    expect(loaded.value.byFinding.has("f-guard-at-good")).toBe(true);
    expect(loaded.value.flat).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 10. currentDisposition — standing-expiry fold semantics
//
// Definitive rules (U3 correction, #455):
//   - defer or dismiss UNCONDITIONALLY sets the standing expiry to that event's
//     expiry field (present → that value; absent → undefined / cleared).
//     A new defer/dismiss is a fresh disposition; it owns its own timer.
//   - accept or resolved CLEARS the standing expiry.
//   - reassign, reopened, and new do NOT change the standing expiry.
// ---------------------------------------------------------------------------

describe("currentDisposition — standing-expiry fold semantics", () => {
  it("defer(expiry) → reassign: expiry survives (reassign does not un-defer)", async () => {
    const expiry = "2099-06-01T00:00:00Z";
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-a",
        event: "new",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-a",
        event: "defer",
        at: "2024-01-02T00:00:00Z",
        against_fingerprint: "fp-1",
        expiry,
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-a",
        event: "reassign",
        at: "2024-01-03T00:00:00Z",
        against_fingerprint: "fp-1",
        owner: "bob",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-stand-a")!;
    const disp = currentDisposition(events);
    // Expiry set by defer must survive the subsequent reassign
    expect(disp.expiry).toBe(expiry);
  });

  it("defer(expiry) → accept: expiry is cleared", async () => {
    const expiry = "2099-06-01T00:00:00Z";
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-b",
        event: "defer",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
        expiry,
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-b",
        event: "accept",
        at: "2024-01-02T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-stand-b")!;
    const disp = currentDisposition(events);
    // accept must clear the expiry from the prior defer
    expect(disp.expiry).toBeUndefined();
  });

  it("dismiss(expiry) → reopened: expiry survives (reopened does not clear)", async () => {
    const expiry = "2099-12-31T00:00:00Z";
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-c",
        event: "dismiss",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
        expiry,
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-c",
        event: "reopened",
        at: "2024-01-02T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-stand-c")!;
    const disp = currentDisposition(events);
    // reopened must NOT clear the standing expiry from dismiss
    expect(disp.expiry).toBe(expiry);
  });

  it("defer(expiry) → resolved: expiry is cleared", async () => {
    const expiry = "2099-06-01T00:00:00Z";
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-d",
        event: "defer",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
        expiry,
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-d",
        event: "resolved",
        at: "2024-01-02T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-stand-d")!;
    const disp = currentDisposition(events);
    // resolved must clear the standing expiry
    expect(disp.expiry).toBeUndefined();
  });

  // --- New tests for the #455 unconditional-replace rule ---

  it("defer(expiry) → dismiss(NO expiry): standing expiry is undefined — permanent dismiss (R9)", async () => {
    // A plain dismiss with no expiry field must REPLACE (clear) the prior defer's expiry.
    // This is the key R9 invariant: a permanent dismissal must not inherit a prior defer timer.
    const deferExpiry = "2099-06-01T00:00:00Z";
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-e",
        event: "defer",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
        expiry: deferExpiry,
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-e",
        event: "dismiss",
        at: "2024-01-02T00:00:00Z",
        against_fingerprint: "fp-1",
        // No expiry field — permanent dismissal
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-stand-e")!;
    const disp = currentDisposition(events, new Date("2099-07-01T00:00:00Z"));
    // dismiss with no expiry must unconditionally replace — standing expiry is now undefined
    expect(disp.expiry).toBeUndefined();
    // and therefore not expired (no timer to expire)
    expect(disp.expired).toBe(false);
  });

  it("defer(expiry1) → dismiss(expiry2): standing expiry is expiry2", async () => {
    const expiry1 = "2099-06-01T00:00:00Z";
    const expiry2 = "2099-12-31T00:00:00Z";
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-f",
        event: "defer",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
        expiry: expiry1,
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-f",
        event: "dismiss",
        at: "2024-01-02T00:00:00Z",
        against_fingerprint: "fp-1",
        expiry: expiry2,
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-stand-f")!;
    const disp = currentDisposition(events);
    // dismiss's expiry must replace the defer's expiry
    expect(disp.expiry).toBe(expiry2);
  });

  it("defer(expiry) → reassign: expiry survives (reassign does not touch the timer)", async () => {
    // Already covered in f-stand-a above, but explicit here for the new rule suite.
    const expiry = "2099-06-01T00:00:00Z";
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-g",
        event: "defer",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
        expiry,
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-g",
        event: "reassign",
        at: "2024-01-02T00:00:00Z",
        against_fingerprint: "fp-1",
        owner: "dave",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-stand-g")!;
    const disp = currentDisposition(events);
    expect(disp.expiry).toBe(expiry);
  });

  it("defer(expiry) → accept: expiry is cleared (accept closes the disposition)", async () => {
    // Mirror of f-stand-b above; kept here so the new rule suite is self-contained.
    const expiry = "2099-06-01T00:00:00Z";
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-h",
        event: "defer",
        at: "2024-01-01T00:00:00Z",
        against_fingerprint: "fp-1",
        expiry,
      }),
    );
    await appendEvent(
      vaultRoot,
      makeEvent({
        finding_id: "f-stand-h",
        event: "accept",
        at: "2024-01-02T00:00:00Z",
        against_fingerprint: "fp-1",
      }),
    );

    const loaded = await loadLedger(vaultRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const events = loaded.value.byFinding.get("f-stand-h")!;
    const disp = currentDisposition(events);
    expect(disp.expiry).toBeUndefined();
  });
});
