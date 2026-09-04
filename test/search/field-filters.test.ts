import { describe, expect, it } from "vitest";
import { compileFieldFilterSql, parseFieldFilters } from "../../src/search/field-filters.js";
import type { IndexedFieldDeclaration } from "../../src/utils/config.js";

const declarations: IndexedFieldDeclaration[] = [
  { field: "owner", type: "string" },
  { field: "stage", type: "enum", enum: ["queued", "active", "done"] },
  { field: "urgent", type: "boolean" },
  { field: "priority", type: "number" },
  { field: "due_date", type: "date" },
];

function parse(raw: unknown) {
  return parseFieldFilters(raw, declarations);
}

describe("parseFieldFilters", () => {
  it("accepts absence and an empty list", () => {
    expect(parse(undefined)).toEqual({ ok: true, value: [] });
    expect(parse([])).toEqual({ ok: true, value: [] });
  });

  it("accepts equality for every supported scalar type", () => {
    const result = parse([
      { field: "owner", op: "eq", value: "human:mihir" },
      { field: "stage", op: "eq", value: "active" },
      { field: "urgent", op: "eq", value: true },
      { field: "priority", op: "eq", value: 2 },
      { field: "due_date", op: "eq", value: "2026-9-5" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map(({ field, op, value }) => ({ field, op, value }))).toEqual([
      { field: "owner", op: "eq", value: "human:mihir" },
      { field: "stage", op: "eq", value: "active" },
      { field: "urgent", op: "eq", value: true },
      { field: "priority", op: "eq", value: 2 },
      { field: "due_date", op: "eq", value: "2026-09-05" },
    ]);
  });

  it("accepts range operators for number and date", () => {
    for (const op of ["gt", "gte", "lt", "lte"] as const) {
      expect(parse([{ field: "priority", op, value: 2 }]).ok).toBe(true);
      expect(parse([{ field: "due_date", op, value: "2026-09-05" }]).ok).toBe(true);
    }
  });

  const invalidCases: Array<{ name: string; raw: unknown; contains: string }> = [
    { name: "non-list", raw: {}, contains: "must be a list" },
    {
      name: "more than sixteen filters",
      raw: Array.from({ length: 17 }, () => ({ field: "priority", op: "eq", value: 1 })),
      contains: "at most 16",
    },
    { name: "non-object entry", raw: [null], contains: "filters[0] must be a mapping" },
    {
      name: "unknown property",
      raw: [{ field: "priority", op: "eq", value: 1, surprise: true }],
      contains: "unrecognised property 'surprise'",
    },
    {
      name: "missing field",
      raw: [{ op: "eq", value: 1 }],
      contains: "filters[0].field must be a non-empty string",
    },
    {
      name: "undeclared field",
      raw: [{ field: "cost", op: "eq", value: 1 }],
      contains: "field 'cost' is not indexed",
    },
    {
      name: "unknown operator",
      raw: [{ field: "priority", op: "between", value: 1 }],
      contains: "unsupported operator 'between'",
    },
    {
      name: "string range",
      raw: [{ field: "owner", op: "gte", value: "human:a" }],
      contains: "operator 'gte' is not valid for string field 'owner'",
    },
    {
      name: "boolean range",
      raw: [{ field: "urgent", op: "lt", value: true }],
      contains: "operator 'lt' is not valid for boolean field 'urgent'",
    },
    {
      name: "wrong string value",
      raw: [{ field: "owner", op: "eq", value: 4 }],
      contains: "value must be a string",
    },
    {
      name: "enum value outside declaration",
      raw: [{ field: "stage", op: "eq", value: "paused" }],
      contains: "value must be one of [queued, active, done]",
    },
    {
      name: "wrong boolean value",
      raw: [{ field: "urgent", op: "eq", value: "true" }],
      contains: "value must be true or false",
    },
    {
      name: "non-finite number",
      raw: [{ field: "priority", op: "eq", value: Number.POSITIVE_INFINITY }],
      contains: "value must be a finite number",
    },
    {
      name: "impossible date",
      raw: [{ field: "due_date", op: "eq", value: "2026-02-30" }],
      contains: "value must be a YYYY-MM-DD date",
    },
    {
      name: "oversized string",
      raw: [{ field: "owner", op: "eq", value: "é".repeat(2049) }],
      contains: "at most 4096 UTF-8 bytes",
    },
  ];

  for (const testCase of invalidCases) {
    it(`rejects ${testCase.name}`, () => {
      const result = parse(testCase.raw);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("vault_search 'filters'");
      expect(result.error.message).toContain(testCase.contains);
    });
  }
});

describe("compileFieldFilterSql", () => {
  it("compiles ANDed correlated EXISTS clauses with bound values", () => {
    const parsed = parse([
      { field: "priority", op: "gte", value: 2 },
      { field: "due_date", op: "lt", value: "2026-10-01" },
      { field: "urgent", op: "eq", value: false },
    ]);
    if (!parsed.ok) throw parsed.error;
    const compiled = compileFieldFilterSql(parsed.value, "d.path");
    expect(compiled.sql.match(/EXISTS/g)).toHaveLength(3);
    expect(compiled.sql).toContain(" AND ");
    expect(compiled.sql).toContain("df0.number_value >= ?");
    expect(compiled.sql).toContain("df1.text_value < ?");
    expect(compiled.sql).toContain("df2.bool_value = ?");
    expect(compiled.params).toEqual([
      "priority",
      "number",
      2,
      "due_date",
      "date",
      "2026-10-01",
      "urgent",
      "boolean",
      0,
    ]);
  });

  it("keeps hostile field names and values out of SQL text", () => {
    const hostileField = "x') OR 1=1 --";
    const hostileValue = "v') OR 1=1 --";
    const parsed = parseFieldFilters(
      [{ field: hostileField, op: "eq", value: hostileValue }],
      [{ field: hostileField, type: "string" }],
    );
    if (!parsed.ok) throw parsed.error;
    const compiled = compileFieldFilterSql(parsed.value, "documents.path");
    expect(compiled.sql).not.toContain(hostileField);
    expect(compiled.sql).not.toContain(hostileValue);
    expect(compiled.params).toEqual([hostileField, "string", hostileValue]);
  });
});
