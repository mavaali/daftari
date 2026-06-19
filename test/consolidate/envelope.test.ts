import { describe, expect, it } from "vitest";
import {
  type EndpointState,
  type EnvelopeCtx,
  evaluateEnvelope,
} from "../../src/consolidate/envelope.js";

const clean: EndpointState = {
  path: "a.md",
  provenanceKnown: true,
  decayBlocking: false,
  hasUnresolvedTension: false,
};

const base = (over: Partial<EnvelopeCtx> = {}): EnvelopeCtx => ({
  action: "edge-observe",
  endpoints: [clean, { ...clean, path: "b.md" }],
  impact: 0.1,
  budget: 1,
  ...over,
});

describe("evaluateEnvelope", () => {
  // --- Happy path ---
  it("admits a clean action with budget headroom", () => {
    const v = evaluateEnvelope(base(), 0);
    expect(v.admit).toBe(true);
    expect(v.gate).toBeNull();
    expect(v.reason).toBe("admitted");
    expect(v.impact).toBe(0.1);
  });

  // --- Invariants gate ---
  it("refuses a never-delete action (bogus action cast)", () => {
    const v = evaluateEnvelope(base({ action: "edge-delete" as unknown as "edge-observe" }), 0);
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
    expect(v.reason).toMatch(/never-delete/);
  });

  it("refuses when the 'from' endpoint has an unresolved tension", () => {
    const from: EndpointState = { ...clean, path: "from.md", hasUnresolvedTension: true };
    const v = evaluateEnvelope(base({ endpoints: [from, { ...clean, path: "b.md" }] }), 0);
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
    expect(v.reason).toMatch(/tension-respect/);
    expect(v.reason).toContain("from.md");
  });

  it("refuses when the 'to' endpoint has unknown provenance", () => {
    const to: EndpointState = { ...clean, path: "to.md", provenanceKnown: false };
    const v = evaluateEnvelope(base({ endpoints: [clean, to] }), 0);
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
    expect(v.reason).toMatch(/provenance-required/);
    expect(v.reason).toContain("to.md");
  });

  it("refuses when an endpoint has decayBlocking set", () => {
    const stale: EndpointState = { ...clean, path: "stale.md", decayBlocking: true };
    const v = evaluateEnvelope(base({ endpoints: [clean, stale] }), 0);
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
    expect(v.reason).toMatch(/premise-freshness/);
    expect(v.reason).toContain("stale.md");
  });

  // --- Budget gate ---
  it("admits when spent + impact === budget (strict >; boundary is admitted)", () => {
    // 3 + 7 === 10, not > 10 → should admit (integer arithmetic, no IEEE 754 drift)
    const v = evaluateEnvelope(base({ impact: 7, budget: 10 }), 3);
    expect(v.admit).toBe(true);
    expect(v.gate).toBeNull();
  });

  it("refuses when spent + impact just exceeds budget", () => {
    // 3 + 8 = 11 > 10 → should refuse
    const v = evaluateEnvelope(base({ impact: 8, budget: 10 }), 3);
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("budget");
    expect(v.reason).toMatch(/trust-budget exhausted/);
  });

  it("echoes the correct impact even on budget refusal", () => {
    const v = evaluateEnvelope(base({ impact: 0.5, budget: 1 }), 0.8);
    expect(v.admit).toBe(false);
    expect(v.impact).toBe(0.5);
  });

  // --- Invariants-before-budget precedence ---
  it("returns gate:invariants when both tension and budget are blown", () => {
    const from: EndpointState = { ...clean, path: "x.md", hasUnresolvedTension: true };
    // budget blown: 0.9 + 0.5 > 1.0
    const v = evaluateEnvelope(
      base({ endpoints: [from, { ...clean, path: "b.md" }], impact: 0.5, budget: 1 }),
      0.9,
    );
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
    expect(v.reason).toMatch(/tension-respect/);
  });

  // --- Numeric guard ---
  it("refuses when impact is NaN (guard prevents silent bypass)", () => {
    const v = evaluateEnvelope(base({ impact: NaN }), 0);
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
    expect(v.reason).toMatch(/precondition/);
  });

  it("refuses when spent is Infinity", () => {
    const v = evaluateEnvelope(base(), Infinity);
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
    expect(v.reason).toMatch(/precondition/);
  });

  it("refuses when budget is negative (precondition)", () => {
    const v = evaluateEnvelope(base({ budget: -1 }), 0);
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
    expect(v.reason).toMatch(/precondition/);
  });

  // --- Endpoint count guard ---
  it("refuses with empty endpoints (precondition)", () => {
    const v = evaluateEnvelope(base({ endpoints: [] }), 0);
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
    expect(v.reason).toMatch(/precondition.*expected 2 endpoints/);
    expect(v.reason).toContain("got 0");
  });

  it("refuses with only one endpoint (precondition)", () => {
    const v = evaluateEnvelope(base({ endpoints: [clean] }), 0);
    expect(v.admit).toBe(false);
    expect(v.gate).toBe("invariants");
    expect(v.reason).toMatch(/precondition.*expected 2 endpoints/);
    expect(v.reason).toContain("got 1");
  });

  // --- edge-contest is also a valid admitted action ---
  it("admits edge-contest with clean endpoints and headroom", () => {
    const v = evaluateEnvelope(base({ action: "edge-contest" }), 0);
    expect(v.admit).toBe(true);
    expect(v.gate).toBeNull();
  });
});
