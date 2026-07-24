import { describe, expect, it } from "vitest";
import type { Frontmatter } from "../../src/frontmatter/types.js";
import {
  collectionFromPath,
  daftariToOkf,
  dateFromGenerated,
  dateFromTimestamp,
  deriveDescription,
  isAttestedComputation,
  isUri,
  okfToDaftari,
  slugify,
  sourcesFromOkf,
  staleAfterFromTtl,
  statusToOkf,
  titleFromPath,
  toIsoTimestamp,
  toOkfSource,
  trustTier,
  ttlFromStaleAfter,
} from "../../src/okf/map.js";

// A complete Frontmatter with sensible defaults; override per test.
function fm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    title: "A Title",
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "high",
    created: "2026-01-01",
    updated: "2026-05-10",
    updated_by: "human:me",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: null,
    tags: [],
    describes: [],
    questions_answered: [],
    questions_raised: [],
    ...overrides,
  };
}

describe("isUri", () => {
  it("accepts scheme://-shaped values and rejects bare ids", () => {
    expect(isUri("https://example.com/x")).toBe(true);
    expect(isUri("bigquery://proj/ds/t")).toBe(true);
    expect(isUri("aurora-product-page")).toBe(false);
    expect(isUri("mailto:x@y.z")).toBe(false); // no "//"
  });
});

describe("deriveDescription", () => {
  it("takes the first sentence of the first prose paragraph", () => {
    const body = "# Heading\n\nHelios bills in credits. More detail here.\n";
    expect(deriveDescription(fm(), body)).toBe("Helios bills in credits.");
  });

  it("skips headings and list items", () => {
    const body = "## Overview\n\n- bullet one\n- bullet two\n\nReal prose starts here.";
    expect(deriveDescription(fm(), body)).toBe("Real prose starts here.");
  });

  it("falls back to the first questions_answered entry when body has no prose", () => {
    const body = "# Only a heading\n\n- and a list\n";
    expect(deriveDescription(fm({ questions_answered: ["What is X?"] }), body)).toBe("What is X?");
  });

  it("returns undefined when there is nothing usable", () => {
    expect(deriveDescription(fm(), "# heading only\n")).toBeUndefined();
  });

  it("truncates very long sentences", () => {
    const long = `${"word ".repeat(100)}end.`;
    const out = deriveDescription(fm(), long);
    expect(out).toBeDefined();
    expect((out as string).length).toBeLessThanOrEqual(280);
    expect(out).toMatch(/\.\.\.$/);
  });
});

describe("toIsoTimestamp", () => {
  it("expands a valid date to an ISO datetime", () => {
    expect(toIsoTimestamp("2026-05-10")).toBe("2026-05-10T00:00:00Z");
  });
  it("returns undefined for a non-calendar date", () => {
    expect(toIsoTimestamp("2026-13-45")).toBeUndefined();
    expect(toIsoTimestamp("")).toBeUndefined();
  });
});

describe("statusToOkf", () => {
  it("maps the Daftari lifecycle onto draft/stable/deprecated", () => {
    expect(statusToOkf("draft")).toBe("draft");
    expect(statusToOkf("canonical")).toBe("stable");
    expect(statusToOkf("deprecated")).toBe("deprecated");
    expect(statusToOkf("superseded")).toBe("deprecated");
    expect(statusToOkf("archived")).toBe("deprecated");
  });
});

describe("staleAfterFromTtl", () => {
  it("adds ttl_days to updated as an absolute date", () => {
    expect(staleAfterFromTtl("2026-05-10", 45)).toBe("2026-06-24");
  });
  it("returns undefined with no TTL or an invalid anchor", () => {
    expect(staleAfterFromTtl("2026-05-10", null)).toBeUndefined();
    expect(staleAfterFromTtl("not-a-date", 45)).toBeUndefined();
  });
});

describe("toOkfSource", () => {
  it("keeps a bare id as an id-only entry", () => {
    expect(toOkfSource("aurora-product-page")).toEqual({ id: "aurora-product-page" });
  });
  it("maps a URI to resource with a slug id from the last path segment", () => {
    expect(toOkfSource("https://helios.test/pricing")).toEqual({
      id: "pricing",
      resource: "https://helios.test/pricing",
    });
    expect(toOkfSource("https://x.test/a/Weekly Report.md?v=2")).toEqual({
      id: "weekly-report",
      resource: "https://x.test/a/Weekly Report.md?v=2",
    });
  });
});

describe("daftariToOkf", () => {
  it("maps collection to type and stashes the raw sidecar", () => {
    const raw = { title: "A Title", collection: "pricing", tags: ["helios"] };
    const out = daftariToOkf(raw, fm({ tags: ["helios"] }), "Helios bills in credits.");
    expect(out.type).toBe("pricing");
    expect(out.title).toBe("A Title");
    expect(out.tags).toEqual(["helios"]);
    expect(out.daftari).toBe(raw);
  });

  it("emits v0.2 generated (replacing v0.1 timestamp) from updated/updated_by", () => {
    const out = daftariToOkf({}, fm(), "");
    expect(out.generated).toEqual({ by: "human:me", at: "2026-05-10T00:00:00Z" });
    expect(out).not.toHaveProperty("timestamp");
  });

  it("never fabricates verified — Daftari records authorship, not confirmations", () => {
    const out = daftariToOkf({}, fm({ status: "canonical", confidence: "high" }), "");
    expect(out).not.toHaveProperty("verified");
  });

  it("emits lifecycle status and an absolute stale_after from ttl_days", () => {
    const out = daftariToOkf({}, fm({ status: "canonical", ttl_days: 45 }), "");
    expect(out.status).toBe("stable");
    expect(out.stale_after).toBe("2026-06-24"); // 2026-05-10 + 45d
  });

  it("omits stale_after when the doc made no freshness promise", () => {
    const out = daftariToOkf({}, fm({ ttl_days: null }), "");
    expect(out).not.toHaveProperty("stale_after");
  });

  it("falls back to 'note' type when collection is empty", () => {
    const out = daftariToOkf({}, fm({ collection: "" }), "");
    expect(out.type).toBe("note");
  });

  it("omits empty tags and non-URI resources", () => {
    const out = daftariToOkf({}, fm({ tags: [], sources: [] }), "");
    expect(out).not.toHaveProperty("tags");
    expect(out).not.toHaveProperty("resource");
  });

  it("maps the first URI source to resource and all sources to structured entries", () => {
    const out = daftariToOkf({}, fm({ sources: ["bare-id", "https://x.test/a"] }), "");
    expect(out.resource).toBe("https://x.test/a");
    expect(out.sources).toEqual([{ id: "bare-id" }, { id: "a", resource: "https://x.test/a" }]);
  });
});

describe("path/slug helpers", () => {
  it("titleFromPath humanizes the basename", () => {
    expect(titleFromPath("a/b/weekly_cart-abandonments.md")).toBe("weekly cart abandonments");
  });
  it("collectionFromPath returns the top dir or null at root", () => {
    expect(collectionFromPath("playbooks/orders.md")).toBe("playbooks");
    expect(collectionFromPath("orders.md")).toBeNull();
  });
  it("slugify produces a kebab slug or null", () => {
    expect(slugify("BigQuery Table")).toBe("bigquery-table");
    expect(slugify("  !!!  ")).toBeNull();
  });
  it("dateFromTimestamp handles Date, ISO string, and junk", () => {
    expect(dateFromTimestamp(new Date("2026-06-15T12:00:00Z"))).toBe("2026-06-15");
    expect(dateFromTimestamp("2026-06-15T00:00:00Z")).toBe("2026-06-15");
    expect(dateFromTimestamp("2026-06-15")).toBe("2026-06-15");
    expect(dateFromTimestamp(42)).toBeUndefined();
    expect(dateFromTimestamp("not-a-date")).toBeUndefined();
  });
});

describe("isAttestedComputation", () => {
  it("matches the v0.2 concept type case-insensitively, nothing else", () => {
    expect(isAttestedComputation("Attested Computation")).toBe(true);
    expect(isAttestedComputation("  attested computation ")).toBe(true);
    expect(isAttestedComputation("BigQuery Table")).toBe(false);
    expect(isAttestedComputation(undefined)).toBe(false);
  });
});

describe("dateFromGenerated", () => {
  it("prefers generated.at, falls back to the v0.1 timestamp", () => {
    expect(dateFromGenerated({ generated: { by: "x", at: "2026-06-30T14:00:00Z" } })).toBe(
      "2026-06-30",
    );
    expect(dateFromGenerated({ timestamp: "2026-06-15T00:00:00Z" })).toBe("2026-06-15");
    expect(dateFromGenerated({ generated: { by: "x" }, timestamp: "2026-06-15T00:00:00Z" })).toBe(
      "2026-06-15",
    );
    expect(dateFromGenerated({})).toBeUndefined();
  });
});

describe("trustTier", () => {
  it("derives the spec's three tiers from verified", () => {
    expect(trustTier(undefined)).toBe("unverified");
    expect(trustTier([])).toBe("unverified");
    expect(trustTier([{ by: "agent:checker", at: "2026-07-01" }])).toBe("machine-confirmed");
    expect(
      trustTier([
        { by: "agent:checker", at: "2026-07-01" },
        { by: "human:jsmith@acme", at: "2026-07-02" },
      ]),
    ).toBe("human-reviewed");
  });
});

describe("ttlFromStaleAfter", () => {
  it("converts an absolute date to days relative to the anchor", () => {
    expect(ttlFromStaleAfter("2026-12-31", "2026-06-15")).toBe(199);
    expect(ttlFromStaleAfter(new Date("2026-12-31T00:00:00Z"), "2026-06-15")).toBe(199);
  });
  it("clamps an already-passed stale_after to 0 (immediately stale)", () => {
    expect(ttlFromStaleAfter("2026-01-01", "2026-06-15")).toBe(0);
  });
  it("returns null when either date is unusable", () => {
    expect(ttlFromStaleAfter(undefined, "2026-06-15")).toBeNull();
    expect(ttlFromStaleAfter("2026-12-31", "junk")).toBeNull();
  });
});

describe("sourcesFromOkf", () => {
  it("flattens resource plus structured v0.2 sources, deduplicated", () => {
    expect(
      sourcesFromOkf({
        resource: "bigquery://proj/ds/orders",
        sources: [
          { id: "warehouse-schema", resource: "https://wiki.test/schemas/sales" },
          { id: "revenue-policy" },
          { id: "dup", resource: "bigquery://proj/ds/orders" },
          "plain-string-source",
        ],
      }),
    ).toEqual([
      "bigquery://proj/ds/orders",
      "https://wiki.test/schemas/sales",
      "revenue-policy",
      "plain-string-source",
    ]);
  });
});

describe("okfToDaftari", () => {
  const ctx = {
    relPath: "playbooks/orders.md",
    today: "2026-07-13",
    updatedBy: "agent:okf-import",
  };

  it("passes a daftari sidecar through verbatim (round-trip)", () => {
    const sidecar = { title: "Orig", collection: "pricing", status: "canonical" };
    const out = okfToDaftari({ type: "x", daftari: sidecar }, ctx);
    expect(out).toEqual(sidecar);
    expect(out).not.toBe(sidecar); // copied, not aliased
  });

  it("synthesizes conservative Daftari frontmatter for a foreign doc", () => {
    const out = okfToDaftari(
      {
        type: "BigQuery Table",
        title: "Orders",
        resource: "bigquery://proj/ds/orders",
        tags: ["sales"],
        timestamp: "2026-06-15T00:00:00Z",
      },
      ctx,
    );
    expect(out.title).toBe("Orders");
    expect(out.domain).toBe("accumulation");
    expect(out.collection).toBe("playbooks"); // from the directory
    expect(out.status).toBe("draft");
    expect(out.created).toBe("2026-06-15");
    expect(out.updated).toBe("2026-06-15");
    expect(out.updated_by).toBe("agent:okf-import");
    expect(out.sources).toEqual(["bigquery://proj/ds/orders"]);
    expect(out.tags).toEqual(["sales"]);
    expect(out.okf_type).toBe("BigQuery Table");
  });

  it("derives the collection from a slugified type when the doc is at the bundle root", () => {
    const out = okfToDaftari({ type: "Data Playbook" }, { ...ctx, relPath: "flat.md" });
    expect(out.collection).toBe("data-playbook");
    expect(out.title).toBe("flat"); // title derived from filename
  });

  it("defaults the date to today when generated.at and timestamp are absent", () => {
    const out = okfToDaftari({ type: "note" }, { ...ctx, relPath: "flat.md" });
    expect(out.created).toBe("2026-07-13");
  });

  it("dates the doc from v0.2 generated.at and preserves the trust record", () => {
    const generated = { by: "reference_agent/gemini-2.5-pro", at: "2026-06-30T14:00:00Z" };
    const out = okfToDaftari({ type: "note", generated }, ctx);
    expect(out.created).toBe("2026-06-30");
    expect(out.updated).toBe("2026-06-30");
    expect(out.okf_generated).toEqual(generated);
  });

  it("imports human-reviewed docs with confidence high; machine-confirmed stays medium", () => {
    const human = okfToDaftari(
      { type: "note", verified: [{ by: "human:jsmith@acme", at: "2026-07-01T09:00:00Z" }] },
      ctx,
    );
    expect(human.confidence).toBe("high");
    expect(human.okf_verified).toEqual([{ by: "human:jsmith@acme", at: "2026-07-01T09:00:00Z" }]);

    const machine = okfToDaftari(
      { type: "note", verified: [{ by: "agent:checker", at: "2026-07-01T09:00:00Z" }] },
      ctx,
    );
    expect(machine.confidence).toBe("medium");

    // Absence never lowers confidence: an unverified v0.2 doc is
    // indistinguishable from a v0.1 doc.
    expect(okfToDaftari({ type: "note" }, ctx).confidence).toBe("medium");
  });

  it("keeps deprecated docs deprecated but does not canonize stable ones", () => {
    expect(okfToDaftari({ type: "note", status: "deprecated" }, ctx).status).toBe("deprecated");
    expect(okfToDaftari({ type: "note", status: "stable" }, ctx).status).toBe("draft");
    expect(okfToDaftari({ type: "note", status: "draft" }, ctx).status).toBe("draft");
  });

  it("converts stale_after to ttl_days anchored at the doc date", () => {
    const out = okfToDaftari(
      { type: "note", timestamp: "2026-06-15T00:00:00Z", stale_after: "2026-12-31" },
      ctx,
    );
    expect(out.ttl_days).toBe(199);
  });

  it("preserves an Attested Computation's machinery but never auto-grants write protection", () => {
    const out = okfToDaftari(
      {
        type: "Attested Computation",
        title: "Revenue for a fiscal year",
        runtime: "bigquery",
        parameters: [{ name: "year", type: "integer", required: true }],
        executor: { resource: "skills/run-on-bq.md" },
        receipt: ["job_id", "executed_sql", "result"],
        attester: { resource: "attesters/sql_equality.py" },
      },
      ctx,
    );
    // A bundle's self-declared type must not buy tier enforcement — only
    // vault_set_tier (reason required, provenance-logged) grants it.
    expect(out).not.toHaveProperty("tier");
    expect(out.okf_type).toBe("Attested Computation");
    expect(out.okf_runtime).toBe("bigquery");
    expect(out.okf_parameters).toEqual([{ name: "year", type: "integer", required: true }]);
    expect(out.okf_executor).toEqual({ resource: "skills/run-on-bq.md" });
    expect(out.okf_receipt).toEqual(["job_id", "executed_sql", "result"]);
    expect(out.okf_attester).toEqual({ resource: "attesters/sql_equality.py" });
  });

  it("maps structured v0.2 sources into Daftari sources and keeps the raw entries", () => {
    const sources = [{ id: "warehouse-schema", resource: "https://wiki.test/schemas/sales" }];
    const out = okfToDaftari({ type: "note", sources }, ctx);
    expect(out.sources).toEqual(["https://wiki.test/schemas/sales"]);
    expect(out.okf_sources).toEqual(sources);
  });
});
