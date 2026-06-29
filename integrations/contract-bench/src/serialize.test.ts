import { describe, expect, test } from "vitest";
import type { CorpusDoc } from "./corpus.js";
import { renderDoc } from "./serialize.js";

describe("renderDoc — daftari-ingestable markdown", () => {
  test("renders the current (terminal) version without a superseded_by key", () => {
    const doc: CorpusDoc = {
      path: "clause-4.2/amendment-2.md",
      frontmatter: { title: "Section 4.2 (amendment-2)", clause: "4.2", source: "amendment-2" },
      body: "Net 60 days.",
    };
    expect(renderDoc(doc)).toBe(
      '---\n' +
        'title: "Section 4.2 (amendment-2)"\n' +
        'clause: "4.2"\n' +
        'source: "amendment-2"\n' +
        "---\n" +
        "Net 60 days.\n",
    );
  });

  test("renders a superseded version with superseded_by pointing at the successor's path", () => {
    const doc: CorpusDoc = {
      path: "clause-4.2/master.md",
      frontmatter: {
        title: "Section 4.2 (master)",
        clause: "4.2",
        source: "master",
        superseded_by: "clause-4.2/amendment-1.md",
      },
      body: "Section 4.2 governs payment.",
    };
    expect(renderDoc(doc)).toContain('superseded_by: "clause-4.2/amendment-1.md"');
  });
});
