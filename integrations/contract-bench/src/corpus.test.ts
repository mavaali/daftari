import { describe, expect, test } from "vitest";
import { resolveChain } from "./clause-edge.js";
import { buildCorpus } from "./corpus.js";

describe("buildCorpus — clause-version atomization with clause-scoped supersession", () => {
  const docs = [
    { id: "master", order: 0, text: "Section 4.2 governs payment." },
    {
      id: "amendment-1",
      order: 1,
      text: 'Section 4.2 is hereby amended and restated in its entirety as follows: "Net 30 days."',
    },
    {
      id: "amendment-2",
      order: 2,
      text: 'Section 4.2 is hereby amended and restated in its entirety as follows: "Net 60 days."',
    },
  ];

  test("emits one doc per clause version, each superseded_by the next, governing version current", () => {
    const corpus = buildCorpus(docs, resolveChain(docs));
    const v0 = corpus.find((d) => d.path === "clause-4.2/master.md");
    const v1 = corpus.find((d) => d.path === "clause-4.2/amendment-1.md");
    const v2 = corpus.find((d) => d.path === "clause-4.2/amendment-2.md");

    expect(v0?.frontmatter.superseded_by).toBe("clause-4.2/amendment-1.md");
    expect(v1?.frontmatter.superseded_by).toBe("clause-4.2/amendment-2.md");
    // governing (latest) version terminates the chain -> it is the current source
    expect(v2?.frontmatter.superseded_by).toBeUndefined();
    expect(v2?.body).toContain("Net 60 days.");
  });
});

describe("buildCorpus — defined-term clause paths", () => {
  test("sanitizes whitespace in term names so vault paths are filesystem-safe", () => {
    const docs = [
      { id: "master", order: 0, text: '"Applicable Margin" means 2.00%.' },
      {
        id: "amendment-1",
        order: 1,
        text:
          "The following terms are hereby amended and restated in their respective " +
          'entireties to read in full as follows: "Applicable Margin" means 2.75%.',
      },
    ];
    const paths = buildCorpus(docs, resolveChain(docs)).map((d) => d.path);
    expect(paths).toContain("clause-Applicable-Margin/master.md");
    expect(paths).toContain("clause-Applicable-Margin/amendment-1.md");
    expect(paths.some((p) => /\s/.test(p))).toBe(false);
  });
});
