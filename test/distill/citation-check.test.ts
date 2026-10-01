// Tests for the citation-integrity check (distill).
//
// Deterministic, literal-match only: extracts numbers/dates/quotes cited in a
// compiled claim's statement and asserts each exists verbatim in the raw
// source text it was compiled from. Does not catch paraphrase or semantic
// drift — scope is intentionally narrow (see module doc).

import { describe, expect, it } from "vitest";
import { checkCitationIntegrity, extractCitations } from "../../src/distill/citation-check.js";

describe("extractCitations", () => {
  it("extracts a quoted span", () => {
    const citations = extractCitations('The team said "ship it Friday".');
    expect(citations).toContainEqual({ type: "quote", value: "ship it Friday" });
  });

  it("extracts an ISO date", () => {
    const citations = extractCitations("The launch moves to 2026-06-03.");
    expect(citations).toContainEqual({ type: "date", value: "2026-06-03" });
  });

  it("extracts a month-name date", () => {
    const citations = extractCitations("The launch moves to June 3rd, 2026.");
    expect(citations.some((c) => c.type === "date" && c.value.includes("June 3rd"))).toBe(true);
  });

  it("extracts a slash date", () => {
    const citations = extractCitations("Due 6/3/2026 per the plan.");
    expect(citations).toContainEqual({ type: "date", value: "6/3/2026" });
  });

  it("extracts a bare number", () => {
    const citations = extractCitations("The team estimated 50 hours of work.");
    expect(citations).toContainEqual({ type: "number", value: "50" });
  });

  it("extracts a decimal/percent number", () => {
    const citations = extractCitations("Latency dropped 3.5%.");
    expect(citations).toContainEqual({ type: "number", value: "3.5%" });
  });

  it("returns an empty list for a statement with no cited numbers/dates/quotes", () => {
    const citations = extractCitations("The team agreed to use Postgres for the new service.");
    expect(citations).toEqual([]);
  });

  it("does not double-count digits already consumed by a date match", () => {
    const citations = extractCitations("The launch moves to 2026-06-03.");
    const numbers = citations.filter((c) => c.type === "number");
    expect(numbers).toEqual([]);
  });
});

describe("checkCitationIntegrity", () => {
  it("passes when every cited number/date/quote exists verbatim in the source", () => {
    const statement = "The team estimated 50 hours and moved launch to 2026-06-03.";
    const source =
      "[2026-05-01T10:00:00] Alice: let's budget 50 hours\n" +
      "[2026-05-01T10:01:00] Bob: and the launch moves to 2026-06-03";

    const result = checkCitationIntegrity(statement, source);

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.citations.length).toBeGreaterThan(0);
  });

  it("flags a hallucinated number not present in the source", () => {
    const statement = "The team estimated 500 hours of work.";
    const source = "[2026-05-01T10:00:00] Alice: let's budget 50 hours";

    const result = checkCitationIntegrity(statement, source);

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ type: "number", value: "500" }]);
  });

  it("does not treat a cited number as verified merely because it is a substring of a larger number", () => {
    // Source contains "150", statement cites "50" — must NOT verify by substring.
    const statement = "The estimate was 50 hours.";
    const source = "[2026-05-01T10:00:00] Alice: it will take 150 hours";

    const result = checkCitationIntegrity(statement, source);

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ type: "number", value: "50" }]);
  });

  it("flags a hallucinated date not present in the source", () => {
    const statement = "The launch moves to 2026-06-03.";
    const source = "[2026-05-01T10:00:00] Alice: the launch moves to 2026-06-10";

    const result = checkCitationIntegrity(statement, source);

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ type: "date", value: "2026-06-03" }]);
  });

  it("flags a paraphrased quote that does not exist verbatim in the source", () => {
    const statement = 'Alice said "we should ship on Friday".';
    const source = "[2026-05-01T10:00:00] Alice: I think we should ship it on Friday";

    const result = checkCitationIntegrity(statement, source);

    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([{ type: "quote", value: "we should ship on Friday" }]);
  });

  it("passes with empty citations when the statement cites nothing verifiable", () => {
    const result = checkCitationIntegrity("The team agreed to use Postgres.", "irrelevant source");
    expect(result.ok).toBe(true);
    expect(result.citations).toEqual([]);
    expect(result.violations).toEqual([]);
  });
});
