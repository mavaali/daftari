// The serve ops floor's pure mechanics: per-principal token buckets, the
// per-IP auth-failure penalty box, and the global in-flight gate. All clocks
// are injected (`nowMs`) — no timers, no sleeps (the locks.ts injectable-now
// precedent).

import { describe, expect, it } from "vitest";
import {
  chargePenalty,
  DEFAULT_LIMITS,
  makeBucket,
  makePenaltyBox,
  makeSlotGate,
  penaltyAllows,
  releaseSlot,
  tryAcquireSlot,
  tryTake,
} from "../../src/serve/limits.js";

const T0 = 1_000_000;

describe("per-principal token bucket", () => {
  it("allows `burst` immediate takes, then denies with a correct Retry-After", () => {
    const b = makeBucket(3, 60, T0); // capacity 3, 1 token/second
    for (let i = 0; i < 3; i++) {
      expect(tryTake(b, T0).allowed).toBe(true);
    }
    const denied = tryTake(b, T0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("accrues tokens at the refill rate and never exceeds capacity", () => {
    const b = makeBucket(2, 60, T0); // 1 token/second
    expect(tryTake(b, T0).allowed).toBe(true);
    expect(tryTake(b, T0).allowed).toBe(true);
    expect(tryTake(b, T0).allowed).toBe(false);
    // One second later: exactly one token back.
    expect(tryTake(b, T0 + 1000).allowed).toBe(true);
    expect(tryTake(b, T0 + 1000).allowed).toBe(false);
    // A long idle period never overfills past capacity.
    expect(tryTake(b, T0 + 3_600_000).allowed).toBe(true);
    expect(tryTake(b, T0 + 3_600_000).allowed).toBe(true);
    expect(tryTake(b, T0 + 3_600_000).allowed).toBe(false);
  });
});

describe("auth-failure penalty box", () => {
  it("allows until the failure burst is spent, then denies pre-auth", () => {
    const box = makePenaltyBox(2, 6); // 2 failures, then ~10s per retry
    expect(penaltyAllows(box, "203.0.113.9", T0).allowed).toBe(true);
    chargePenalty(box, "203.0.113.9", T0);
    expect(penaltyAllows(box, "203.0.113.9", T0).allowed).toBe(true);
    chargePenalty(box, "203.0.113.9", T0);
    const denied = penaltyAllows(box, "203.0.113.9", T0);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    // A different client is unaffected.
    expect(penaltyAllows(box, "203.0.113.10", T0).allowed).toBe(true);
    // Failures refill: after ten seconds one retry is allowed again.
    expect(penaltyAllows(box, "203.0.113.9", T0 + 10_000).allowed).toBe(true);
  });

  it("sweeps only full (informationally absent) buckets past the entry cap", () => {
    const box = makePenaltyBox(2, 6, 3); // maxEntries 3 for the test
    chargePenalty(box, "a", T0); // partially drained — must survive the sweep
    chargePenalty(box, "b", T0);
    chargePenalty(box, "b", T0); // fully drained — must survive
    // Touch entries that immediately refill to full, then exceed the cap.
    chargePenalty(box, "c", T0);
    expect(penaltyAllows(box, "c", T0 + 3_600_000).allowed).toBe(true); // c refills to full
    chargePenalty(box, "d", T0 + 3_600_000);
    chargePenalty(box, "e", T0 + 3_600_000);
    // The sweep never drops a drained bucket: "b" is still denied.
    chargePenalty(box, "b", T0 + 3_600_000);
    chargePenalty(box, "b", T0 + 3_600_000);
    expect(penaltyAllows(box, "b", T0 + 3_600_000).allowed).toBe(false);
  });
});

describe("in-flight slot gate", () => {
  it("admits to the ceiling, rejects past it, and releases without going negative", () => {
    const gate = makeSlotGate(2);
    expect(tryAcquireSlot(gate)).toBe(true);
    expect(tryAcquireSlot(gate)).toBe(true);
    expect(tryAcquireSlot(gate)).toBe(false);
    releaseSlot(gate);
    expect(tryAcquireSlot(gate)).toBe(true);
    releaseSlot(gate);
    releaseSlot(gate);
    releaseSlot(gate); // over-release clamps at zero
    expect(tryAcquireSlot(gate)).toBe(true);
    expect(tryAcquireSlot(gate)).toBe(true);
    expect(tryAcquireSlot(gate)).toBe(false);
  });
});

describe("defaults", () => {
  it("ships the documented 10-user-team defaults", () => {
    expect(DEFAULT_LIMITS).toEqual({
      ratePerMinute: 120,
      burst: 40,
      authFailureBurst: 10,
      authFailuresPerMinute: 6,
      maxInFlight: 32,
    });
  });
});
