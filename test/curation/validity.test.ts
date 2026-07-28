import { describe, expect, it } from "vitest";
import { computeValidity, validityConflicts } from "../../src/curation/validity.js";
import type { LoadedDoc } from "../../src/curation/vault-docs.js";
import type { Frontmatter } from "../../src/frontmatter/types.js";

describe("computeValidity", () => {
  it("returns null when both endpoints are absent — nothing to say", () => {
    // The pre-adoption state of every document. Distinct from "always valid".
    expect(computeValidity({ valid_from: null, valid_until: null }, "2026-07-26")).toBeNull();
  });

  it("reports in-window inside the interval", () => {
    const r = computeValidity(
      { valid_from: "2026-01-01", valid_until: "2026-04-01" },
      "2026-02-15",
    );
    expect(r?.state).toBe("in-window");
    expect(r?.banner).toBeNull();
  });

  // The half-open contract: [from, until). The lower endpoint is IN, the upper
  // endpoint is OUT. Getting this backwards is the whole class of bug the
  // convention exists to prevent.
  it("includes the lower endpoint", () => {
    const input = { valid_from: "2026-01-01", valid_until: "2026-04-01" };
    expect(computeValidity(input, "2026-01-01")?.state).toBe("in-window");
  });

  it("EXCLUDES the upper endpoint — valid_until is the first day it did not hold", () => {
    const input = { valid_from: "2026-01-01", valid_until: "2026-04-01" };
    expect(computeValidity(input, "2026-03-31")?.state).toBe("in-window");
    expect(computeValidity(input, "2026-04-01")?.state).toBe("expired");
  });

  it("makes a handoff share no day — successor.from === predecessor.until", () => {
    // The property that makes the boundary write arithmetic-free. Q1 hands to
    // Q2 on 2026-04-01: exactly one of them covers any given day.
    const q1 = { valid_from: "2026-01-01", valid_until: "2026-04-01" };
    const q2 = { valid_from: "2026-04-01", valid_until: "2026-07-01" };
    for (const day of ["2026-03-31", "2026-04-01", "2026-04-02"]) {
      const inQ1 = computeValidity(q1, day)?.state === "in-window";
      const inQ2 = computeValidity(q2, day)?.state === "in-window";
      expect(inQ1 !== inQ2).toBe(true); // exactly one, never both, never neither
    }
  });

  it("reports not-yet before the lower endpoint", () => {
    const r = computeValidity({ valid_from: "2026-04-01", valid_until: null }, "2026-03-31");
    expect(r?.state).toBe("not-yet");
    expect(r?.banner).toBeNull();
  });

  it("treats a null upper endpoint as open-ended, not unknown-end", () => {
    const r = computeValidity({ valid_from: "2026-01-01", valid_until: null }, "2030-01-01");
    expect(r?.state).toBe("in-window");
  });

  it("treats a null lower endpoint as open-start", () => {
    const r = computeValidity({ valid_from: null, valid_until: "2026-12-31" }, "1999-01-01");
    expect(r?.state).toBe("in-window");
  });

  it("carries the raw authored endpoints verbatim", () => {
    const r = computeValidity({ valid_from: "January 2026", valid_until: null }, "2026-07-26");
    expect(r?.from).toBe("January 2026");
  });

  it("reports unknown when an endpoint cannot be normalized", () => {
    // A malformed endpoint must not silently compare as absent — that would
    // let a typo read as open-ended, which is a claim nobody made.
    expect(
      computeValidity({ valid_from: "January 2026", valid_until: null }, "2026-07-26")?.state,
    ).toBe("unknown");
    expect(
      computeValidity({ valid_from: null, valid_until: "2026-13-45" }, "2026-07-26")?.state,
    ).toBe("unknown");
  });

  // An inverted or empty window is a contradiction. Evaluating it would mark
  // the document not-yet before `from` and expired after `until` — never
  // in-window on any day — so one transposed date would produce a stale banner
  // on vault_read, removal under valid_only, a sleep wake, and an interview
  // question about a fact that never stopped being true. It must read unknown.
  describe("contradictory windows read as unknown, never evaluated", () => {
    it("an inverted window is unknown on every side of it", () => {
      const inv = { valid_from: "2026-06-01", valid_until: "2026-01-01" };
      for (const day of ["2025-01-01", "2026-03-01", "2026-08-01"]) {
        expect(computeValidity(inv, day)?.state).toBe("unknown");
      }
    });

    it("never banners an inverted window", () => {
      const r = computeValidity(
        { valid_from: "2026-06-01", valid_until: "2026-01-01" },
        "2026-08-01",
      );
      expect(r?.banner).toBeNull();
    });

    it("an empty window (from === until) is unknown, not a single valid day", () => {
      // Half-open: [X, X) contains no days at all.
      const empty = { valid_from: "2026-06-01", valid_until: "2026-06-01" };
      expect(computeValidity(empty, "2026-06-01")?.state).toBe("unknown");
    });

    it("still carries the raw endpoints so lint can name them", () => {
      const r = computeValidity(
        { valid_from: "2026-06-01", valid_until: "2026-01-01" },
        "2026-08-01",
      );
      expect(r?.from).toBe("2026-06-01");
      expect(r?.until).toBe("2026-01-01");
    });
  });

  it("banners an expired document with a daftari-authored string", () => {
    const r = computeValidity({ valid_from: null, valid_until: "2026-01-31" }, "2026-03-02");
    expect(r?.state).toBe("expired");
    expect(r?.banner).toContain("⚠ STALE");
    expect(r?.banner).toContain("2026-01-31");
    expect(r?.banner).toContain("30d");
  });

  it("never interpolates a document-authored string into the banner", () => {
    // The decay.ts prompt-injection rule: only daftari-authored text and the
    // normalized date reach the banner.
    const r = computeValidity({ valid_from: null, valid_until: "2026-01-31" }, "2026-02-01");
    expect(r?.banner).not.toContain("Ignore");
    expect(r?.banner).toMatch(/^⚠ STALE — validity ended \d{4}-\d{2}-\d{2} \(\d+d ago\)$/);
  });
});

// --- validityConflicts -----------------------------------------------------

function doc(path: string, over: Partial<Frontmatter> = {}): LoadedDoc {
  const frontmatter = {
    title: path,
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "high",
    created: "2026-01-01",
    updated: "2026-01-01",
    updated_by: "agent:test",
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
  } as Frontmatter;
  return { path, frontmatter, content: "body", validation: { valid: true, issues: [] } };
}

const NOW = new Date("2026-07-26T00:00:00Z");

function kinds(docs: LoadedDoc[]): string[] {
  return validityConflicts(docs, NOW).map((c) => c.kind);
}

describe("validityConflicts", () => {
  it("reports nothing for a vault with no authored validity", () => {
    expect(validityConflicts([doc("a.md"), doc("b.md")], NOW)).toEqual([]);
  });

  it("reports nothing for a well-formed interval", () => {
    expect(kinds([doc("a.md", { valid_from: "2026-01-01", valid_until: "2026-12-31" })])).toEqual(
      [],
    );
  });

  describe("malformed-endpoint", () => {
    it("flags an endpoint that fails to normalize, naming the raw value", () => {
      const found = validityConflicts([doc("a.md", { valid_from: "January 2026" })], NOW);
      expect(found).toHaveLength(1);
      expect(found[0]?.kind).toBe("malformed-endpoint");
      expect(found[0]?.path).toBe("a.md");
      expect(found[0]?.detail).toContain("January 2026");
    });

    it("flags an out-of-range date", () => {
      expect(kinds([doc("a.md", { valid_until: "2026-13-45" })])).toEqual(["malformed-endpoint"]);
    });
  });

  describe("inverted", () => {
    it("flags an interval that ends before it starts", () => {
      expect(kinds([doc("a.md", { valid_from: "2026-06-01", valid_until: "2026-01-01" })])).toEqual(
        ["inverted"],
      );
    });

    it("flags an empty window where both endpoints are the same day", () => {
      // Half-open: [X, X) contains no days, so this is the same defect as an
      // inversion rather than a one-day window. Under the previous closed
      // convention this was legal, which is exactly the ambiguity half-open
      // removes.
      const found = validityConflicts(
        [doc("a.md", { valid_from: "2026-06-01", valid_until: "2026-06-01" })],
        NOW,
      );
      expect(found.map((f) => f.kind)).toContain("inverted");
      expect(found[0]?.detail).toContain("contains no days");
    });

    it("does not flag a genuine one-day window", () => {
      // One valid day, half-open, is [X, X+1).
      expect(
        kinds([doc("a.md", { valid_from: "2026-06-01", valid_until: "2026-06-02" })]),
      ).not.toContain("inverted");
    });
  });

  describe("supersession-overlap", () => {
    it("flags a successor whose interval overlaps the document it replaced", () => {
      // The vault asserts A replaced B while claiming both held at once.
      const docs = [
        doc("b.md", {
          superseded_by: "a.md",
          valid_from: "2026-01-01",
          valid_until: "2026-12-31",
        }),
        doc("a.md", { valid_from: "2026-04-01", valid_until: null }),
      ];
      expect(kinds(docs)).toEqual(["supersession-overlap"]);
    });

    it("does not flag a clean handoff — the windows meet exactly", () => {
      // Half-open contiguity is equality: b ends the instant a begins.
      const docs = [
        doc("b.md", {
          superseded_by: "a.md",
          valid_from: "2026-01-01",
          valid_until: "2026-04-01",
        }),
        doc("a.md", { valid_from: "2026-04-01", valid_until: null }),
      ];
      expect(kinds(docs)).toEqual([]);
    });

    it("does not flag when either side has no authored interval", () => {
      const docs = [doc("b.md", { superseded_by: "a.md", valid_until: "2026-03-31" }), doc("a.md")];
      expect(kinds(docs)).toEqual([]);
    });
  });

  describe("supersession-gap", () => {
    it("flags a day with no recorded belief between predecessor and successor", () => {
      const docs = [
        doc("b.md", {
          superseded_by: "a.md",
          valid_from: "2026-01-01",
          valid_until: "2026-04-01",
        }),
        doc("a.md", { valid_from: "2026-05-01", valid_until: null }),
      ];
      expect(kinds(docs)).toEqual(["supersession-gap"]);
    });

    it("flags a one-day gap — no tolerance window either way", () => {
      // Under half-open, until 2026-03-31 / from 2026-04-01 leaves 2026-03-31
      // itself uncovered. The old closed convention read this as contiguous,
      // which is precisely the off-by-one that motivated the switch.
      const docs = [
        doc("b.md", {
          superseded_by: "a.md",
          valid_from: "2026-01-01",
          valid_until: "2026-03-31",
        }),
        doc("a.md", { valid_from: "2026-04-01", valid_until: null }),
      ];
      expect(kinds(docs)).toEqual(["supersession-gap"]);
    });
  });

  describe("expired-canonical", () => {
    it("flags a canonical accumulation doc whose validity ended with no successor", () => {
      expect(kinds([doc("a.md", { status: "canonical", valid_until: "2026-01-31" })])).toEqual([
        "expired-canonical",
      ]);
    });

    it("does not flag when a successor exists", () => {
      const docs = [
        doc("a.md", { status: "canonical", valid_until: "2026-01-31", superseded_by: "b.md" }),
        doc("b.md"),
      ];
      // The overlap/gap checks may have their own opinion; expired-canonical
      // must not be among the findings.
      expect(kinds(docs)).not.toContain("expired-canonical");
    });

    it("does not flag a generative document", () => {
      expect(
        kinds([
          doc("a.md", { domain: "generative", status: "canonical", valid_until: "2026-01-31" }),
        ]),
      ).toEqual([]);
    });

    it("does not flag a draft", () => {
      expect(kinds([doc("a.md", { status: "draft", valid_until: "2026-01-31" })])).toEqual([]);
    });

    it("does not flag an interval that has not ended yet", () => {
      expect(kinds([doc("a.md", { status: "canonical", valid_until: "2027-01-31" })])).toEqual([]);
    });
  });
});
