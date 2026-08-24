import { describe, expect, it } from "vitest";
import { parseDocument } from "../../src/frontmatter/parser.js";
import { inferSchema, schemaExampleValue } from "../../src/schema/infer.js";

describe("inferSchema", () => {
  it("aggregates raw frontmatter into deterministic field statistics", () => {
    const report = inferSchema([
      {
        path: "a.md",
        frontmatter: {
          status: "draft",
          team: "platform",
          score: 1,
          active: true,
          tags: ["alpha"],
          released: "2026-01-02",
          nested: { owner: "a" },
          empty: null,
        },
      },
      {
        path: "b.md",
        frontmatter: {
          status: "draft",
          team: "platform",
          score: 2,
          active: false,
          tags: ["beta"],
          released: new Date("2026-02-03T00:00:00.000Z"),
          nested: { owner: "b" },
          empty: null,
        },
      },
      {
        path: "c.md",
        frontmatter: {
          status: "canonical",
          team: "data",
          score: "unknown",
          active: true,
          tags: ["alpha"],
          empty: null,
        },
      },
    ]);

    expect(report.documentCount).toBe(3);
    expect(report.fields.map((field) => field.field)).toEqual([
      "active",
      "empty",
      "nested",
      "released",
      "score",
      "status",
      "tags",
      "team",
    ]);
    expect(report.fields.find((field) => field.field === "status")).toEqual({
      field: "status",
      occurrences: 3,
      prevalence: 1,
      types: ["string"],
      distinctValues: 2,
      distinctValuesCapped: false,
      examples: ["canonical", "draft"],
      enumLike: true,
    });
    expect(report.fields.find((field) => field.field === "score")).toMatchObject({
      occurrences: 3,
      types: ["number", "string"],
      distinctValues: 3,
      examples: [1, 2, "unknown"],
      enumLike: false,
    });
    expect(report.fields.find((field) => field.field === "released")).toMatchObject({
      occurrences: 2,
      types: ["date"],
      examples: ["2026-01-02", "2026-02-03"],
      enumLike: false,
    });
    expect(report.fields.find((field) => field.field === "tags")).toMatchObject({
      types: ["array"],
      enumLike: false,
    });
    expect(report.fields.find((field) => field.field === "nested")).toMatchObject({
      types: ["object"],
      enumLike: false,
    });
    expect(report.fields.find((field) => field.field === "empty")).toMatchObject({
      types: ["null"],
      distinctValues: 1,
      examples: [null],
      enumLike: false,
    });
  });

  it("bounds high-cardinality tracking while preserving the non-enum conclusion", () => {
    const report = inferSchema(
      Array.from({ length: 60 }, (_, index) => ({
        path: `${index}.md`,
        frontmatter: { external_id: `value-${String(index).padStart(2, "0")}` },
      })),
    );

    expect(report.fields[0]).toMatchObject({
      field: "external_id",
      occurrences: 60,
      distinctValues: 50,
      distinctValuesCapped: true,
      enumLike: false,
    });
    expect(report.fields[0]?.examples).toEqual([
      "value-00",
      "value-01",
      "value-02",
      "value-03",
      "value-04",
    ]);
  });

  it("bounds example size without collapsing distinct values that share a long prefix", () => {
    const prefix = "x".repeat(300);
    const report = inferSchema([
      { path: "a.md", frontmatter: { note: `${prefix}a` } },
      { path: "b.md", frontmatter: { note: `${prefix}b` } },
    ]);

    expect(report.fields[0]).toMatchObject({ distinctValues: 2, enumLike: false });
    expect(report.fields[0]?.examples).toHaveLength(2);
    expect(report.fields[0]?.examples.every((value) => String(value).length <= 201)).toBe(true);
    expect(report.fields[0]?.examples.every((value) => String(value).endsWith("…"))).toBe(true);
  });

  it("canonicalizes recursive aliases and non-finite YAML numbers into JSON-safe examples", () => {
    const parsed = parseDocument(
      "---\nloop: &loop\n  - *loop\nnan: .nan\npos_inf: .inf\nneg_inf: -.inf\n---\n# Cyclic\n",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const report = inferSchema([{ path: "cyclic.md", frontmatter: parsed.value.raw }]);

    expect(() => JSON.stringify(report)).not.toThrow();
    expect(report.fields.find((field) => field.field === "loop")?.examples).toEqual([
      ["[Circular]"],
    ]);
    expect(report.fields.find((field) => field.field === "nan")?.examples).toEqual(["NaN"]);
    expect(report.fields.find((field) => field.field === "pos_inf")?.examples).toEqual([
      "Infinity",
    ]);
    expect(report.fields.find((field) => field.field === "neg_inf")?.examples).toEqual([
      "-Infinity",
    ]);
  });

  it("stops traversing a wide structured value at the evidence node budget", () => {
    let yielded = 0;
    const wide = new Proxy(
      Array.from({ length: 10_000 }, (_, index) => index),
      {
        get(target, property, receiver) {
          if (property !== Symbol.iterator) return Reflect.get(target, property, receiver);
          return function* values() {
            for (const value of target) {
              yielded += 1;
              yield value;
            }
          };
        },
      },
    );

    schemaExampleValue(wide);

    expect(yielded).toBeLessThan(250);
  });

  it("sorts field names by locale-independent code point order", () => {
    const report = inferSchema([{ path: "a.md", frontmatter: { alpha: 1, Zed: 2 } }]);

    expect(report.fields.map((field) => field.field)).toEqual(["Zed", "alpha"]);
  });
});
