import { describe, expect, test } from "vitest";
import { parseCitations } from "./citation-parse.js";

// All input strings are derived from real SEC amendment exhibit language
// (Amendment No. 2 to a Master Services Agreement, EDGAR 1108341/...dex10198).
describe("parseCitations — clean whole-clause operations (recoverable ground truth)", () => {
  test("parses a whole-clause restatement as a recoverable restate citation", () => {
    const text =
      'Section 5.4 of the Existing Agreement is hereby amended and restated in its ' +
      'entirety as follows: "Each such invoice submitted to Customer shall ..."';
    expect(parseCitations(text)).toEqual([
      { clause: "5.4", op: "restate", recoverable: true },
    ]);
  });

  test("parses a whole-clause deletion, targeting the deleted clause not an appositive cross-reference", () => {
    const text =
      "Section 12(a), as added to Schedule C pursuant to Section 2.3 of Schedule C " +
      "of Addendum 2 to the Existing Agreement, is hereby deleted in its entirety.";
    expect(parseCitations(text)).toEqual([
      { clause: "12(a)", op: "delete", recoverable: true },
    ]);
  });
});

describe("parseCitations — partial edits (unrecoverable: no whole-clause value)", () => {
  test("flags 'amended by replacing instances' as an unrecoverable partial edit", () => {
    const text =
      'Section 4.2 is amended by replacing all instances of "Contract Year" ' +
      'therein with "calendar year".';
    expect(parseCitations(text)).toEqual([
      { clause: "4.2", op: "partial", recoverable: false },
    ]);
  });

  test("flags 'amended by inserting a new sentence' as an unrecoverable partial edit", () => {
    const text =
      "Section 4.3 is amended by inserting the following text immediately after " +
      "the last sentence of such section: ...";
    expect(parseCitations(text)).toEqual([
      { clause: "4.3", op: "partial", recoverable: false },
    ]);
  });
});

describe("parseCitations — additions and indirection", () => {
  test("parses a new-section addition as a recoverable add citation", () => {
    const text =
      'New Section 12 is added to Schedule C as follows: "13. Audit rights ..."';
    expect(parseCitations(text)).toEqual([
      { clause: "12", op: "add", recoverable: true },
    ]);
  });

  test("flags 'amended as set forth in [attachment]' as an unrecoverable indirect edit", () => {
    const text =
      "Section 7 of the Existing Agreement is hereby amended as set forth in " +
      "Exhibit B hereto.";
    expect(parseCitations(text)).toEqual([
      { clause: "7", op: "indirect", recoverable: false },
    ]);
  });

  test("does not mistake the delete appositive 'as added pursuant to' for an addition", () => {
    const text =
      "Section 12(a), as added pursuant to Section 2.3 of Addendum 2, is hereby " +
      "deleted in its entirety.";
    expect(parseCitations(text)).toEqual([
      { clause: "12(a)", op: "delete", recoverable: true },
    ]);
  });
});

describe("parseCitations — sub-part subjects ('in its entirety' is not sufficient)", () => {
  test("downgrades 'the last sentence of Section X amended and restated in its entirety' to partial", () => {
    const text =
      "The last sentence of Section 5.2.1 of the Existing Agreement is hereby " +
      "amended and restated in its entirety as follows: ...";
    expect(parseCitations(text)).toEqual([
      { clause: "5.2.1", op: "partial", recoverable: false },
    ]);
  });

  test("downgrades 'the second paragraph of Section X deleted in its entirety' to partial", () => {
    const text = "The second paragraph of Section 5.1 is deleted in its entirety.";
    expect(parseCitations(text)).toEqual([
      { clause: "5.1", op: "partial", recoverable: false },
    ]);
  });
});

describe("parseCitations — region-bleed resistance", () => {
  test("an op whose subject is a Schedule does not claim a Section embedded in the prior op's quoted value", () => {
    const text =
      "Section 22.11.4 of the Existing Agreement is hereby amended and restated in " +
      'its entirety as follows: "Provider shall comply with this Section 22.11.3 ' +
      'of the Scorecard." ' +
      "Schedule C of the Existing Agreement is hereby amended as set forth in " +
      "Attachment A hereto.";
    // Only the restate of 22.11.4 — the Schedule C indirect has no Section
    // subject, so it must yield nothing rather than bleed onto 22.11.3.
    expect(parseCitations(text)).toEqual([
      { clause: "22.11.4", op: "restate", recoverable: true },
    ]);
  });

  test("does not claim a cross-referenced Section ('pursuant to Section X') as a subject", () => {
    const text =
      "The provisions are amended by reference; pursuant to Section 9.9 the parties agree.";
    // "amended by" with no genuine Section subject (9.9 is a cross-reference).
    expect(parseCitations(text)).toEqual([]);
  });
});

describe("parseCitations — multi-operation documents", () => {
  test("returns every operation in document order, claiming the subject clause of each", () => {
    const text =
      'Section 5.4 of the Existing Agreement is hereby amended and restated in its ' +
      'entirety as follows: "New invoice terms apply." ' +
      'Section 4.2 is amended by replacing all instances of "Contract Year" with ' +
      '"calendar year". ' +
      "Section 12(a), as added pursuant to Section 2.3 of Addendum 2, is hereby " +
      "deleted in its entirety.";
    expect(parseCitations(text)).toEqual([
      { clause: "5.4", op: "restate", recoverable: true },
      { clause: "4.2", op: "partial", recoverable: false },
      { clause: "12(a)", op: "delete", recoverable: true },
    ]);
  });
});
