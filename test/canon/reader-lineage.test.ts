// Task 8 (6mf.4 R9): toCanonDoc projects optional readerLineage from
// raw.reader_lineage with the same defensive filter as readers[] — non-array /
// non-string / malformed entries are silently dropped, never an error.
// Absent reader_lineage ⇒ readerLineage: undefined on the CanonDoc.

import { describe, expect, it } from "vitest";
import { toCanonDoc } from "../../src/canon/index.js";
import { encodeLineageEntry } from "../../src/distill/reader-fingerprint.js";
import type { LoadedDoc } from "../../src/storage/types.js";

const READER_1 = "modelA@0.5|prompt=aaaaaaaa|retry=false";
const READER_2 = "modelB@0.3|prompt=bbbbbbbb|retry=false";
const LINEAGE_INGEST_R1 = encodeLineageEntry("2026-01-01T00:00:00Z", "ingest", READER_1);
const LINEAGE_UPDATE_R2 = encodeLineageEntry("2026-08-17T12:00:00Z", "update", READER_2);

function makeDoc(raw: Record<string, unknown> = {}): LoadedDoc {
  return {
    content: "# Doc\n\nBody.",
    raw,
    frontmatter: {
      title: "Doc",
      domain: "test",
      collection: "pricing",
      status: "canonical",
      confidence: "medium",
      created: "2026-01-01",
      updated: "2026-01-01",
      updated_by: "agent:test",
      provenance: "direct",
      sources: [],
      superseded_by: null,
      valid_from: null,
      valid_until: null,
      tier: null,
      ttl_days: null,
      tags: [],
    },
  };
}

describe("toCanonDoc — readerLineage projection (6mf.4 R9)", () => {
  it("projects reader_lineage from raw to readerLineage on CanonDoc", () => {
    const lineage = [LINEAGE_INGEST_R1, LINEAGE_UPDATE_R2];
    const cd = toCanonDoc("pricing/a.md", makeDoc({ reader_lineage: lineage }));
    expect(cd.readerLineage).toEqual(lineage);
  });

  it("absent reader_lineage ⇒ readerLineage undefined", () => {
    const cd = toCanonDoc("pricing/a.md", makeDoc({}));
    expect(cd.readerLineage).toBeUndefined();
  });

  it("non-array reader_lineage treated as absent (defensive)", () => {
    const cd = toCanonDoc("pricing/a.md", makeDoc({ reader_lineage: "garbage" }));
    expect(cd.readerLineage).toBeUndefined();
  });

  it("non-string entries in reader_lineage are filtered out", () => {
    const cd = toCanonDoc(
      "pricing/a.md",
      makeDoc({ reader_lineage: [LINEAGE_INGEST_R1, 42, null, LINEAGE_UPDATE_R2] }),
    );
    expect(cd.readerLineage).toEqual([LINEAGE_INGEST_R1, LINEAGE_UPDATE_R2]);
  });

  it("empty array after filtering ⇒ readerLineage undefined", () => {
    const cd = toCanonDoc("pricing/a.md", makeDoc({ reader_lineage: [42, null] }));
    expect(cd.readerLineage).toBeUndefined();
  });

  it("empty array reader_lineage ⇒ readerLineage undefined", () => {
    const cd = toCanonDoc("pricing/a.md", makeDoc({ reader_lineage: [] }));
    expect(cd.readerLineage).toBeUndefined();
  });
});
