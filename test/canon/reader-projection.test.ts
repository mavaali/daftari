// 6mf.3: the CanonDoc projection carries the reader fingerprint (reader_model +
// readers), read from the doc's raw frontmatter, so canon can report which
// reader authored a canonized belief. Both fields are OPTIONAL — a doc without
// them projects undefined (no crash, no placeholder).

import { describe, expect, it } from "vitest";
import { toCanonDoc } from "../../src/canon/index.js";
import type { LoadedDoc } from "../../src/curation/vault-docs.js";
import type { Frontmatter } from "../../src/frontmatter/types.js";

// Minimal built-in frontmatter for a loaded doc. Reader fields live in `raw`
// (they are declared-optional schema extensions, never coerced into the typed
// Frontmatter), so the projection must read them off raw.
function baseFrontmatter(): Frontmatter {
  return {
    title: "A belief",
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "high",
    created: "2026-01-01",
    updated: "2026-01-02",
    updated_by: "human:alice",
    provenance: "direct",
    tier: null,
    criticality: null,
    sources: [],
    superseded_by: null,
    ttl_days: null,
    valid_from: "2026-01-01",
    valid_until: null,
    tags: [],
    describes: [],
    questions_answered: [],
    questions_raised: [],
    subjects: [],
  } as unknown as Frontmatter;
}

function loadedDoc(raw: Record<string, unknown>): LoadedDoc {
  return {
    path: "pricing/belief.md",
    frontmatter: baseFrontmatter(),
    content: "Body.",
    raw,
    validation: { valid: true, issues: [] },
  };
}

describe("toCanonDoc — reader fingerprint projection (6mf.3)", () => {
  it("surfaces reader_model and readers from a canonized doc's frontmatter", () => {
    const doc = loadedDoc({
      title: "A belief",
      collection: "pricing",
      updated_by: "human:alice",
      valid_from: "2026-01-01",
      updated: "2026-01-02",
      reader_model: "modelA",
      readers: ["modelA@0.2|prompt=aaaaaaaa|retry=false"],
    });
    const cd = toCanonDoc("pricing/belief.md", doc);
    expect(cd.readerModel).toBe("modelA");
    expect(cd.readers).toEqual(["modelA@0.2|prompt=aaaaaaaa|retry=false"]);
  });

  it("projects undefined for a doc without reader fields (no crash)", () => {
    const doc = loadedDoc({
      title: "A belief",
      collection: "pricing",
      updated_by: "human:alice",
      valid_from: "2026-01-01",
      updated: "2026-01-02",
    });
    const cd = toCanonDoc("pricing/belief.md", doc);
    expect(cd.readerModel).toBeUndefined();
    expect(cd.readers).toBeUndefined();
  });

  it("projects only readerModel when readers is absent, and vice versa", () => {
    const onlyModel = toCanonDoc(
      "pricing/belief.md",
      loadedDoc({ updated_by: "x", updated: "2026-01-02", reader_model: "modelA" }),
    );
    expect(onlyModel.readerModel).toBe("modelA");
    expect(onlyModel.readers).toBeUndefined();

    const onlyReaders = toCanonDoc(
      "pricing/belief.md",
      loadedDoc({
        updated_by: "x",
        updated: "2026-01-02",
        readers: ["modelB@na|prompt=bb|retry=false"],
      }),
    );
    expect(onlyReaders.readerModel).toBeUndefined();
    expect(onlyReaders.readers).toEqual(["modelB@na|prompt=bb|retry=false"]);
  });

  it("ignores a non-string reader_model and a non-array readers (no false projection)", () => {
    const doc = loadedDoc({
      updated_by: "x",
      updated: "2026-01-02",
      reader_model: 42,
      readers: "not-an-array",
    });
    const cd = toCanonDoc("pricing/belief.md", doc);
    expect(cd.readerModel).toBeUndefined();
    expect(cd.readers).toBeUndefined();
  });
});
