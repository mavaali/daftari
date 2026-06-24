import { describe, expect, test } from "vitest";
import { resolveChain } from "./clause-edge.js";
import { buildQAs } from "./qa-build.js";

describe("buildQAs — current-value buckets", () => {
  const docs = [
    { id: "master", order: 0, text: "Section 4.2 governs payment. Section 9.1 governs law." },
    {
      id: "amendment-1",
      order: 1,
      text: 'Section 4.2 is hereby amended and restated in its entirety as follows: "Net 45 days."',
    },
    {
      id: "amendment-2",
      order: 2,
      text:
        "Section 9.1 is hereby amended and restated in its entirety as follows: " +
        '"Governed by Delaware law."',
    },
  ];

  test("a clause whose governing doc is not the latest is scoped-current, answered from that earlier doc", () => {
    const qas = buildQAs(docs, resolveChain(docs));
    expect(qas.find((q) => q.clause === "4.2")).toMatchObject({
      bucket: "scoped-current",
      governingDoc: "amendment-1",
      answer: "Net 45 days.",
      question: "What is the current value of Section 4.2?",
    });
  });

  test("a clause whose governing doc is the latest is latest-current", () => {
    const qas = buildQAs(docs, resolveChain(docs));
    expect(qas.find((q) => q.clause === "9.1")).toMatchObject({
      bucket: "latest-current",
      governingDoc: "amendment-2",
      answer: "Governed by Delaware law.",
    });
  });
});

describe("buildQAs — integrity gates", () => {
  const docs = [
    { id: "master", order: 0, text: "Section 4.2 governs payment. Section 7.1 governs term." },
    {
      id: "amendment-1",
      order: 1,
      text: 'Section 4.2 is hereby amended and restated in its entirety as follows: "Net 30 days."',
    },
    {
      id: "amendment-2",
      order: 2,
      text: "Section 7.1 is amended by inserting a renewal sentence as the last sentence.",
    },
  ];

  test("a clause tainted by an unrecoverable op produces no QA", () => {
    const qas = buildQAs(docs, resolveChain(docs));
    expect(qas.find((q) => q.clause === "7.1")).toBeUndefined();
  });

  test("an absent clause becomes a no-value probe answered NOT_PRESENT", () => {
    const qas = buildQAs(docs, resolveChain(docs), { noValueClauses: ["88.8"] });
    expect(qas.find((q) => q.clause === "88.8")).toMatchObject({
      bucket: "no-value",
      answer: "NOT_PRESENT",
      governingDoc: "",
    });
  });
});

describe("buildQAs — defined-term clauses", () => {
  const docs = [
    { id: "master", order: 0, text: '"Applicable Margin" means 2.00%. "Base Rate" means the prime rate.' },
    {
      id: "amendment-1",
      order: 1,
      text:
        "The following terms are hereby amended and restated in their respective " +
        'entireties to read in full as follows: "Applicable Margin" means 2.75% per annum.',
    },
    {
      id: "amendment-2",
      order: 2,
      text:
        "The following terms are hereby amended and restated in their respective " +
        'entireties to read in full as follows: "Base Rate" means SOFR plus 1.00%.',
    },
  ];

  test("a defined-term governed by an earlier amendment is scoped-current, answered with that definition", () => {
    const am = buildQAs(docs, resolveChain(docs)).find((q) => q.clause === "Applicable Margin");
    expect(am?.bucket).toBe("scoped-current");
    expect(am?.governingDoc).toBe("amendment-1");
    expect(am?.answer).toContain("2.75%");
    expect(am?.answer).not.toContain("2.00%");
  });
});
