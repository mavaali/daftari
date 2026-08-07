import { describe, expect, it } from "vitest";
import { parseDocument } from "../../src/frontmatter/parser.js";
import type { Frontmatter, Position } from "../../src/frontmatter/types.js";
import { serializeDocument } from "../../src/tools/write.js";

function fm(over: Partial<Frontmatter> = {}): Frontmatter {
  return {
    title: "Claim",
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "high",
    created: "2026-08-01",
    updated: "2026-08-01",
    updated_by: "agent:test",
    provenance: "direct",
    tier: null,
    criticality: null,
    sources: [],
    superseded_by: null,
    ttl_days: null,
    valid_from: null,
    valid_until: null,
    tags: [],
    describes: [],
    questions_answered: [],
    questions_raised: [],
    positions: null,
    org_position: null,
    contested: null,
    ...over,
  };
}

const pos: Position = {
  id: "pos-001",
  principal: "alice",
  stance: "assert",
  statement: "the floor causes storms",
  confidence: "high",
  provenance: "direct",
  valid_from: null,
  superseded_by: null,
  created: "2026-08-01",
  sources: [],
};

describe("serializeDocument — positions fields (U-1)", () => {
  it("legacy doc (all three null): no positions/org_position/contested keys emitted", () => {
    const text = serializeDocument(fm(), "\nBody.\n");
    expect(text).not.toContain("positions:");
    expect(text).not.toContain("org_position:");
    expect(text).not.toContain("contested:");
  });

  it("round-trips a positions array + contested through serialize → parse", () => {
    const text = serializeDocument(fm({ positions: [pos], contested: false }), "\nBody.\n");
    const parsed = parseDocument(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.frontmatter.positions).toEqual([pos]);
    expect(parsed.value.frontmatter.contested).toBe(false);
    // Round-trip is a fixpoint: serialize(parse(serialize(x))) === serialize(x).
    const again = serializeDocument(
      parsed.value.frontmatter,
      parsed.value.content,
      [],
      parsed.value.raw,
    );
    expect(again).toBe(text);
  });

  it("a doc parsed WITHOUT the fields serializes byte-identically to before (R-2)", () => {
    const legacyText = serializeDocument(fm(), "\nBody.\n");
    const parsed = parseDocument(legacyText);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw parsed.error;
    const roundTripped = serializeDocument(
      parsed.value.frontmatter,
      parsed.value.content,
      [],
      parsed.value.raw,
    );
    expect(roundTripped).toBe(legacyText);
  });
});
