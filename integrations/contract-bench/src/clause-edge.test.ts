import { describe, expect, test } from "vitest";
import { resolveChain } from "./clause-edge.js";

const master = { id: "master", order: 0, text: "Section 4.2 governs payment terms. Section 7.1 governs term." };

describe("resolveChain — governing document per clause", () => {
  test("a restate makes the amending document the governing doc, with master as origin", () => {
    const docs = [
      master,
      {
        id: "amendment-1",
        order: 1,
        text:
          "Section 4.2 of the Agreement is hereby amended and restated in its " +
          'entirety as follows: "Net 30 days."',
      },
    ];
    expect(resolveChain(docs)).toEqual([
      {
        clause: "4.2",
        governingDoc: "amendment-1",
        status: "live",
        clean: true,
        history: ["master", "amendment-1"],
      },
    ]);
  });

  test("accumulates supersession, holds governing at the last recoverable op, and taints clauses touched by an unrecoverable op", () => {
    const docs = [
      master,
      {
        id: "amendment-1",
        order: 1,
        text: 'Section 4.2 is hereby amended and restated in its entirety as follows: "Net 30."',
      },
      {
        id: "amendment-2",
        order: 2,
        text: 'Section 4.2 is hereby amended and restated in its entirety as follows: "Net 45."',
      },
      {
        id: "amendment-3",
        order: 3,
        text: "Section 7.1 is amended by inserting a renewal sentence as the last sentence.",
      },
    ];
    expect(resolveChain(docs)).toEqual([
      // governing 4.2 = amendment-2, NOT the latest doc (amendment-3) — scoped-current.
      {
        clause: "4.2",
        governingDoc: "amendment-2",
        status: "live",
        clean: true,
        history: ["master", "amendment-1", "amendment-2"],
      },
      // 7.1 only ever touched by a partial — value can't be recovered, so tainted.
      {
        clause: "7.1",
        governingDoc: "master",
        status: "live",
        clean: false,
        history: ["master", "amendment-3"],
      },
    ]);
  });

  test("an add introduces a clause with no master origin; a delete marks status deleted", () => {
    const docs = [
      master,
      {
        id: "amendment-1",
        order: 1,
        text: 'New Section 9.5 is added to the Agreement as follows: "Arbitration applies."',
      },
      {
        id: "amendment-2",
        order: 2,
        text: "Section 4.2 of the Agreement is hereby deleted in its entirety.",
      },
    ];
    expect(resolveChain(docs)).toEqual([
      {
        clause: "9.5",
        governingDoc: "amendment-1",
        status: "live",
        clean: true,
        history: ["amendment-1"],
      },
      {
        clause: "4.2",
        governingDoc: "master",
        status: "deleted",
        clean: true,
        history: ["master", "amendment-2"],
      },
    ]);
  });
});
