import { describe, expect, it } from "vitest";
import { diffSchema } from "../../src/schema/diff.js";
import type { SchemaExtension } from "../../src/utils/config.js";

describe("diffSchema", () => {
  it("compares observed fields and values against built-ins and declared extensions", () => {
    const extensions: SchemaExtension[] = [
      { field: "owner", type: "string", required: false },
      {
        field: "priority",
        type: "enum",
        required: false,
        enum: ["urgent", "low"],
      },
      { field: "rating", type: "number", required: false },
      { field: "obsolete", type: "boolean", required: false },
    ];
    const report = diffSchema(
      [
        {
          path: "a.md",
          frontmatter: {
            status: "draft",
            state: "active",
            owner: "platform",
            priority: "urgent",
            rating: 5,
            one_off: true,
          },
        },
        {
          path: "b.md",
          frontmatter: {
            status: "invalid",
            state: "paused",
            owner: "platform",
            priority: "other",
            rating: "five",
          },
        },
        { path: "c.md", frontmatter: { owner: "data", obsolete: null } },
      ],
      extensions,
      { minOccurrences: 2 },
    );

    expect(report.documentCount).toBe(3);
    expect(report.minOccurrences).toBe(2);
    expect(report.undeclared).toEqual([
      {
        field: "state",
        occurrences: 2,
        prevalence: 2 / 3,
        types: ["string"],
        examples: ["active", "paused"],
        distinctValues: 2,
        distinctValuesCapped: false,
        enumLike: false,
      },
    ]);
    expect(report.unusedExtensions).toEqual([
      { field: "obsolete", type: "boolean", required: false },
    ]);
    expect(report.valueDrift).toEqual([
      {
        declaredType: "enum",
        field: "priority",
        occurrences: 2,
        offending: 1,
        messages: ['expected one of [urgent, low], got "other"'],
        messagesCapped: false,
        omittedMessages: 0,
        examples: [{ path: "b.md", value: "other" }],
      },
      {
        declaredType: "number",
        field: "rating",
        occurrences: 2,
        offending: 1,
        messages: ["expected number, got string"],
        messagesCapped: false,
        omittedMessages: 0,
        examples: [{ path: "b.md", value: "five" }],
      },
      {
        declaredType: "built-in",
        field: "status",
        occurrences: 2,
        offending: 1,
        messages: [
          'expected one of [draft, canonical, deprecated, superseded, archived], got "invalid"',
        ],
        messagesCapped: false,
        omittedMessages: 0,
        examples: [{ path: "b.md", value: "invalid" }],
      },
    ]);
    expect(report.nearMisses).toEqual([
      { field: "state", suggestedField: "status", distance: 2, occurrences: 2 },
    ]);
  });

  it("bounds path/value evidence for a large invalid value", () => {
    const report = diffSchema(
      [{ path: "large.md", frontmatter: { code: "x".repeat(500) } }],
      [{ field: "code", type: "enum", required: false, enum: ["OK"] }],
    );

    const example = report.valueDrift[0]?.examples[0];
    expect(example?.path).toBe("large.md");
    expect(String(example?.value).length).toBeLessThanOrEqual(201);
    expect(String(example?.value)).toMatch(/…$/);
    expect(report.valueDrift[0]?.messages[0]?.length).toBeLessThanOrEqual(201);
  });

  it("treats an absent or null-only required extension as unused, not value drift", () => {
    const extension: SchemaExtension = { field: "owner", type: "string", required: true };
    const absent = diffSchema([{ path: "absent.md", frontmatter: {} }], [extension]);
    const nullOnly = diffSchema([{ path: "null.md", frontmatter: { owner: null } }], [extension]);

    for (const report of [absent, nullOnly]) {
      expect(report.unusedExtensions).toEqual([{ field: "owner", type: "string", required: true }]);
      expect(report.valueDrift).toEqual([]);
    }
  });

  it("collapses repeated value-specific and index-specific errors into bounded categories", () => {
    const enumReport = diffSchema(
      Array.from({ length: 100 }, (_, index) => ({
        path: `${String(index).padStart(3, "0")}.md`,
        frontmatter: { priority: `invalid-${index}` },
      })),
      [{ field: "priority", type: "enum", required: false, enum: ["high", "low"] }],
    );
    const positionsReport = diffSchema(
      [
        {
          path: "positions.md",
          frontmatter: { positions: Array.from({ length: 1_000 }, () => 42) },
        },
      ],
      [],
    );

    expect(enumReport.valueDrift[0]).toMatchObject({
      offending: 100,
      messages: ['expected one of [high, low], got "invalid-0"'],
      messagesCapped: false,
      omittedMessages: 0,
    });
    expect(positionsReport.valueDrift[0]).toMatchObject({
      offending: 1,
      messages: ["element 0 is not an object"],
      messagesCapped: false,
      omittedMessages: 0,
    });
  });
});
