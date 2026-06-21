import { describe, it, expect } from "vitest";
import { parseDocument } from "../../../dist/frontmatter/parser.js";
import { mapDay } from "./corpus-map.js";
import type { DayMetadata } from "./types.js";

const meta: DayMetadata = {
  dayNumber: 7,
  date: "2026-03-14",
  personaId: "ada",
  activeArcs: ["job-search", "relocation"],
};
const content = "Today Ada applied to three roles.\n\nShe also booked a flight.";

describe("mapDay", () => {
  it("zero-pads the day to 4 digits under the persona directory", () => {
    const daily = mapDay(7, content, meta);
    expect(daily.relPath).toBe("ada/day-0007.md");
  });

  it("emits frontmatter that survives parseDocument without coercion", () => {
    const daily = mapDay(7, content, meta);
    const result = parseDocument(daily.markdown);
    if (!result.ok) throw new Error(`parseDocument failed: ${result.error.message}`);
    const { frontmatter, raw, validation } = result.value;

    // Builtin daftari fields: the coerced value (frontmatter) must deep-equal
    // the raw parsed value. Any drift means daftari silently changed a type or
    // enum we provided — the exact failure mode reindexVault would index
    // without warning. (Dates are the live hazard: an UNQUOTED ISO date parses
    // to a Date in raw but a string in frontmatter; corpus-map quotes them so
    // both sides stay the identical string.)
    for (const field of ["collection", "tags", "title", "created", "updated"]) {
      expect(frontmatter[field], `builtin "${field}" must round-trip uncoerced`).toEqual(raw[field]);
    }

    // Extension fields (dayNumber, date) are not part of daftari's builtin
    // schema, so validateFrontmatter never copies them into `frontmatter`.
    // The no-coercion guarantee for them is that they survive in `raw`
    // byte-for-byte (daftari leaves undeclared fields untouched).
    expect(raw.dayNumber, "extension dayNumber must stay a number in raw").toBe(7);
    expect(raw.date, "extension date must stay a string in raw").toBe("2026-03-14");

    // The required builtin enums are set EXPLICITLY (not left to coerce), so
    // they round-trip to our chosen values and the corpus indexes
    // deterministically.
    expect(frontmatter.domain).toBe("accumulation");
    expect(frontmatter.status).toBe("canonical");
    expect(frontmatter.confidence).toBe("high");
    expect(frontmatter.provenance).toBe("direct");
    expect(frontmatter.updated_by).toBe("agent:recall-bench");

    // And nothing we emitted should have produced a validation issue against
    // the builtin schema.
    expect(validation.issues, JSON.stringify(validation.issues)).toEqual([]);
  });

  it("maps benchmark fields onto daftari builtins with correct values", () => {
    const daily = mapDay(7, content, meta);
    const result = parseDocument(daily.markdown);
    if (!result.ok) throw new Error(`parseDocument failed: ${result.error.message}`);
    const { frontmatter, raw } = result.value;

    expect(frontmatter.collection).toBe("ada");
    expect(frontmatter.tags).toEqual(["job-search", "relocation"]);
    expect(frontmatter.created).toBe("2026-03-14");
    expect(frontmatter.updated).toBe("2026-03-14");
    // Extension fields live on raw (not in daftari's builtin frontmatter).
    expect(raw.dayNumber).toBe(7);
    expect(raw.date).toBe("2026-03-14");
    expect(typeof frontmatter.title).toBe("string");
    expect((frontmatter.title as string).length).toBeGreaterThan(0);
  });

  it("round-trips the body content", () => {
    const daily = mapDay(7, content, meta);
    const result = parseDocument(daily.markdown);
    if (!result.ok) throw new Error(`parseDocument failed: ${result.error.message}`);
    expect(result.value.content.trim()).toBe(content.trim());
  });

  it("handles empty activeArcs as an empty tags array (no coercion)", () => {
    const m: DayMetadata = { ...meta, activeArcs: [] };
    const daily = mapDay(7, content, m);
    const result = parseDocument(daily.markdown);
    if (!result.ok) throw new Error(`parseDocument failed: ${result.error.message}`);
    expect(result.value.frontmatter.tags).toEqual([]);
    expect(result.value.frontmatter.tags).toEqual(result.value.raw.tags);
  });
});
