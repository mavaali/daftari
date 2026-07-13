import { describe, expect, it } from "vitest";
import type { Frontmatter } from "../../src/frontmatter/types.js";
import {
  collectionFromPath,
  daftariToOkf,
  dateFromTimestamp,
  deriveDescription,
  isUri,
  okfToDaftari,
  slugify,
  titleFromPath,
  toIsoTimestamp,
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

describe("daftariToOkf", () => {
  it("maps collection to type and stashes the raw sidecar", () => {
    const raw = { title: "A Title", collection: "pricing", tags: ["helios"] };
    const out = daftariToOkf(raw, fm({ tags: ["helios"] }), "Helios bills in credits.");
    expect(out.type).toBe("pricing");
    expect(out.title).toBe("A Title");
    expect(out.tags).toEqual(["helios"]);
    expect(out.timestamp).toBe("2026-05-10T00:00:00Z");
    expect(out.daftari).toBe(raw);
  });

  it("falls back to 'note' type when collection is empty", () => {
    const out = daftariToOkf({}, fm({ collection: "" }), "");
    expect(out.type).toBe("note");
  });

  it("omits empty tags and non-URI resources", () => {
    const out = daftariToOkf({}, fm({ tags: [], sources: ["bare-id"] }), "");
    expect(out).not.toHaveProperty("tags");
    expect(out).not.toHaveProperty("resource");
  });

  it("maps the first URI source to resource", () => {
    const out = daftariToOkf({}, fm({ sources: ["bare-id", "https://x.test/a"] }), "");
    expect(out.resource).toBe("https://x.test/a");
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

  it("defaults the date to today when timestamp is absent", () => {
    const out = okfToDaftari({ type: "note" }, { ...ctx, relPath: "flat.md" });
    expect(out.created).toBe("2026-07-13");
  });
});
