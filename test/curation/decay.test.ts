import { describe, expect, it } from "vitest";
import { computeDecay, type DecayInput } from "../../src/curation/decay.js";

const NOW = new Date("2026-05-17T00:00:00Z");

// A healthy, recently-updated document with a long TTL.
function healthy(): DecayInput {
  return {
    status: "canonical",
    confidence: "high",
    updated: "2026-05-10",
    created: "2026-05-01",
    ttl_days: 120,
    superseded_by: null,
  };
}

describe("computeDecay", () => {
  it("returns null for a healthy document", () => {
    expect(computeDecay(healthy(), NOW)).toBeNull();
  });

  it("flags a document past its TTL as warn with a banner", () => {
    const d = computeDecay({ ...healthy(), updated: "2026-01-01", ttl_days: 30 }, NOW);
    expect(d?.level).toBe("warn");
    expect(d?.banner).toContain("STALE");
    expect(d?.reasons.join(" ")).toContain("past its 30d TTL");
  });

  it("flags an aging document but emits no banner (scarcity rule)", () => {
    // 70 days since update against a 120d TTL => score ~0.58, not expired.
    const d = computeDecay({ ...healthy(), updated: "2026-03-08", ttl_days: 120 }, NOW);
    expect(d?.level).toBe("aging");
    expect(d?.banner).toBeNull();
  });

  it("flags a deprecated document with the loudest banner", () => {
    const d = computeDecay({ ...healthy(), status: "deprecated" }, NOW);
    expect(d?.level).toBe("deprecated");
    expect(d?.banner).toContain("DEPRECATED");
  });

  it("flags an old draft", () => {
    const d = computeDecay(
      { ...healthy(), status: "draft", created: "2026-01-01", ttl_days: null },
      NOW,
    );
    expect(d?.level).toBe("warn");
    expect(d?.reasons.join(" ")).toContain("draft");
  });

  it("flags stagnant low-confidence", () => {
    const d = computeDecay(
      { ...healthy(), confidence: "low", updated: "2026-01-01", ttl_days: null },
      NOW,
    );
    expect(d?.level).toBe("warn");
    expect(d?.reasons.join(" ")).toContain("low confidence");
  });

  it("is total: empty updated and null ttl_days yield null, never throws", () => {
    expect(computeDecay({ ...healthy(), updated: "", ttl_days: null }, NOW)).toBeNull();
  });

  it("deprecated outranks an also-stale document", () => {
    const d = computeDecay(
      { ...healthy(), status: "deprecated", updated: "2026-01-01", ttl_days: 30 },
      NOW,
    );
    expect(d?.level).toBe("deprecated");
  });
});
