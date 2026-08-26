import { describe, expect, it } from "vitest";
import { renderInferredSchema, renderSchemaDiff } from "../../src/schema/render.js";

describe("schema Markdown rendering", () => {
  it("contains hostile-but-valid field names, paths, and messages without breaking tables", () => {
    const inferred = renderInferredSchema(
      "/vault`name\nnext",
      "notes|drafts",
      {
        filesScanned: 1,
        issues: [{ path: "notes/a`|b\n.md", message: "bad | yaml\nheading" }],
      },
      {
        documentCount: 1,
        fields: [
          {
            field: "owner`|name\nnext",
            occurrences: 1,
            prevalence: 1,
            types: ["string"],
            distinctValues: 1,
            distinctValuesCapped: false,
            examples: ["a|b`c"],
            enumLike: false,
          },
        ],
      },
    );
    const diff = renderSchemaDiff(
      "/vault",
      undefined,
      { filesScanned: 1, issues: [] },
      {
        documentCount: 1,
        minOccurrences: 2,
        undeclared: [],
        unusedExtensions: [],
        valueDrift: [
          {
            field: "state|name`",
            declaredType: "built-in",
            occurrences: 1,
            offending: 1,
            messages: ["bad | value\n## injected"],
            messagesCapped: false,
            omittedMessages: 0,
            examples: [{ path: "a|b.md", value: "bad`value" }],
          },
        ],
        nearMisses: [{ field: "stat|e", suggestedField: "status`", distance: 1, occurrences: 1 }],
      },
    );

    expect(inferred).toContain("notes\\|drafts");
    expect(inferred).toContain("owner`\\|name\\nnext");
    expect(inferred).not.toContain("\nheading\n");
    expect(diff).toContain("state\\|name`");
    expect(diff).toContain("bad \\| value\\n## injected");
    expect(diff).not.toContain("\n## injected");
  });
});
