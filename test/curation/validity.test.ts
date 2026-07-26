import { describe, expect, it } from "vitest";
import { computeValidity, validityConflicts } from "../../src/curation/validity.js";
import type { LoadedDoc } from "../../src/curation/vault-docs.js";
import type { Frontmatter } from "../../src/frontmatter/types.js";

describe("computeValidity", () => {
  it("returns null when both endpoints are absent — nothing to say", () => {
    // The pre-adoption state of every document. Distinct from "always valid".
    expect(computeValidity({ valid_from: null, valid_until: null }, "2026-07-26")).toBeNull();
  });

  it("reports valid inside a closed interval", () => {
    const r = computeValidity(
      { valid_from: "2026-01-01", valid_until: "2026-03-31" },
      "2026-02-15",
    );
    expect(r?.state).toBe("valid");
    expect(r?.banner).toBeNull();
  });

  it("includes both endpoints — the interval is closed on both ends", () => {
    const input = { valid_from: "2026-01-01", valid_until: "2026-03-31" };
    expect(computeValidity(input, "2026-01-01")?.state).toBe("valid");
    expect(computeValidity(input, "2026-03-31")?.state).toBe("valid");
  });

  it("reports not_yet before the lower endpoint", () => {
    const r = computeValidity({ valid_from: "2026-04-01", valid_until: null }, "2026-03-31");
    expect(r?.state).toBe("not_yet");
    expect(r?.banner).toBeNull();
  });

  it("reports expired after the upper endpoint", () => {
    const r = computeValidity({ valid_from: null, valid_until: "2026-03-31" }, "2026-04-01");
    expect(r?.state).toBe("expired");
  });

  it("treats a null upper endpoint as open-ended, not unknown-end", () => {
    const r = computeValidity({ valid_from: "2026-01-01", valid_until: null }, "2030-01-01");
    expect(r?.state).toBe("valid");
  });

  it("treats a null lower endpoint as open-start", () => {
    const r = computeValidity({ valid_from: null, valid_until: "2026-12-31" }, "1999-01-01");
    expect(r?.state).toBe("valid");
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

    it("does not flag a single-day interval", () => {
      // A closed interval where both endpoints are the same day is one valid
      // day, not an inversion. (This doc also trips expired-canonical, since
      // the day is in the past and nothing replaced it — that is correct and
      // separately covered, so assert only on the rule under test.)
      expect(
        kinds([doc("a.md", { valid_from: "2026-06-01", valid_until: "2026-06-01" })]),
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

    it("does not flag a clean handoff", () => {
      const docs = [
        doc("b.md", {
          superseded_by: "a.md",
          valid_from: "2026-01-01",
          valid_until: "2026-03-31",
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
          valid_until: "2026-03-31",
        }),
        doc("a.md", { valid_from: "2026-05-01", valid_until: null }),
      ];
      expect(kinds(docs)).toEqual(["supersession-gap"]);
    });

    it("does not flag a contiguous handoff — no tolerance window either way", () => {
      const docs = [
        doc("b.md", {
          superseded_by: "a.md",
          valid_from: "2026-01-01",
          valid_until: "2026-03-31",
        }),
        doc("a.md", { valid_from: "2026-04-01", valid_until: null }),
      ];
      expect(kinds(docs)).toEqual([]);
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
