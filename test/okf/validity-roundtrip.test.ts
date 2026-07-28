// Valid time round-trips through OKF via the sidecar, with no new core field.
//
// OKF v0.2's `stale_after` is a review clock derived from ttl_days — it is
// transaction-time flavored, and overloading it with valid time would put the
// same collapse into the interchange format that the axis exists to prevent
// inside the vault. The sidecar already carries raw frontmatter verbatim, so
// the fields survive a Daftari→OKF→Daftari trip for free.
//
// A foreign OKF bundle has no sidecar and therefore no valid time. It imports
// with both fields null — unknown, which is the honest answer, not "always
// true".

import { describe, expect, it } from "vitest";
import type { Frontmatter } from "../../src/frontmatter/types.js";
import { daftariToOkf, okfToDaftari } from "../../src/okf/map.js";

function fm(over: Partial<Frontmatter> = {}): Frontmatter {
  return {
    title: "Plan Pro pricing",
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "high",
    created: "2026-01-01",
    updated: "2026-05-10",
    updated_by: "human:me",
    provenance: "direct",
    tier: null,
    sources: [],
    superseded_by: null,
    ttl_days: null,
    valid_from: null,
    valid_until: null,
    tags: [],
    describes: [],
    questions_answered: [],
    questions_raised: [],
    ...over,
  };
}

const CTX = {
  relPath: "pricing/plan-pro.md",
  today: "2026-07-26",
  updatedBy: "agent:okf-import",
};

describe("OKF — valid time round-trip", () => {
  it("preserves both endpoints through export and import", () => {
    const raw = {
      title: "Plan Pro pricing",
      collection: "pricing",
      valid_from: "2026-01-01",
      valid_until: "2026-03-31",
    };
    const okf = daftariToOkf(
      raw,
      fm({ valid_from: "2026-01-01", valid_until: "2026-03-31" }),
      "Plan Pro was 49 USD.",
    );
    const back = okfToDaftari(okf, CTX);
    expect(back.valid_from).toBe("2026-01-01");
    expect(back.valid_until).toBe("2026-03-31");
  });

  it("does not overload stale_after with valid time", () => {
    const okf = daftariToOkf(
      {},
      fm({ ttl_days: 45, valid_from: "2026-01-01", valid_until: "2026-03-31" }),
      "",
    );
    // stale_after stays the ttl_days-derived review clock, untouched by the
    // valid-time interval.
    expect(okf.stale_after).toBe("2026-06-24"); // 2026-05-10 + 45d
  });

  it("adds no core OKF field for validity", () => {
    const okf = daftariToOkf({}, fm({ valid_from: "2026-01-01" }), "");
    expect(okf).not.toHaveProperty("valid_from");
    expect(okf).not.toHaveProperty("valid_until");
    expect(okf).not.toHaveProperty("valid_time");
  });

  it("imports a foreign bundle with both fields absent", () => {
    // No sidecar: a bundle from some other tool. The vault was never told when
    // the claim held, and must not invent an answer.
    const foreign = {
      title: "Some foreign doc",
      type: "pricing",
      status: "stable",
    };
    const back = okfToDaftari(foreign, CTX);
    expect(back.valid_from ?? null).toBeNull();
    expect(back.valid_until ?? null).toBeNull();
  });
});
