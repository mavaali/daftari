// Pure computation for `daftari schema infer` (#299): the vault's de facto
// frontmatter schema — every key that occurs, its inferred type(s), example
// values, and whether it looks enum-like. Takes already-scanned docs (see
// scan.ts) so it has no IO of its own and is trivially unit-testable.

import type { FieldStats, InferredSchema, InferredType, ScannedDoc } from "./types.js";

// Example values are capped per field so a high-cardinality free-text field
// (titles, urls) doesn't blow up report size or memory.
const MAX_EXAMPLES = 5;

// Distinct values are tracked up to this cap; past it we know the field is not
// enum-like and stop growing the set. Generous enough for a real enum (status,
// priority, ...) while bounding memory for free text.
const MAX_DISTINCT_TRACKED = 50;

// A field is "enum-like" when its distinct value count is small relative to
// its occurrence count and it repeats at least once — one-off values (a
// title, a unique id) are never enum-like regardless of how few docs use them.
const ENUM_LIKE_MAX_DISTINCT = 10;
const ENUM_LIKE_MIN_OCCURRENCES = 2;

export function inferValueType(v: unknown): InferredType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Date) return v.getTime() === v.getTime() ? "date" : "null";
  if (typeof v === "string") return /^\d{4}-\d{2}-\d{2}$/.test(v) ? "date" : "string";
  if (typeof v === "number") return "number";
  if (typeof v === "boolean") return "boolean";
  return "object";
}

// A stable, bounded-length key for value dedup — distinct values are grouped
// by this, not by reference identity.
function valueKey(v: unknown): string {
  const s = v instanceof Date ? v.toISOString() : JSON.stringify(v);
  return s.length > 200 ? s.slice(0, 200) : s;
}

interface FieldAccumulator {
  occurrences: number;
  types: Map<InferredType, number>;
  examples: unknown[];
  exampleKeys: Set<string>;
  distinct: Set<string>;
  distinctCapped: boolean;
}

export function inferFromDocs(
  docs: ScannedDoc[],
  scope: string | null = null,
  skipped: { path: string; reason: string }[] = [],
): InferredSchema {
  const byField = new Map<string, FieldAccumulator>();

  for (const doc of docs) {
    for (const [field, value] of Object.entries(doc.raw)) {
      if (value === undefined || value === null) continue;

      let acc = byField.get(field);
      if (!acc) {
        acc = {
          occurrences: 0,
          types: new Map(),
          examples: [],
          exampleKeys: new Set(),
          distinct: new Set(),
          distinctCapped: false,
        };
        byField.set(field, acc);
      }

      acc.occurrences += 1;
      const type = inferValueType(value);
      acc.types.set(type, (acc.types.get(type) ?? 0) + 1);

      const key = valueKey(value);
      if (acc.distinct.size < MAX_DISTINCT_TRACKED) {
        acc.distinct.add(key);
      } else if (!acc.distinct.has(key)) {
        acc.distinctCapped = true;
      }
      if (acc.examples.length < MAX_EXAMPLES && !acc.exampleKeys.has(key)) {
        acc.examples.push(value);
        acc.exampleKeys.add(key);
      }
    }
  }

  const fields: FieldStats[] = [...byField.entries()]
    .map(([field, acc]) => {
      const types = [...acc.types.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t]) => t);
      const distinctValues = acc.distinct.size;
      const enumLike =
        !acc.distinctCapped &&
        distinctValues <= ENUM_LIKE_MAX_DISTINCT &&
        distinctValues < acc.occurrences &&
        acc.occurrences >= ENUM_LIKE_MIN_OCCURRENCES;
      return {
        field,
        occurrences: acc.occurrences,
        types,
        examples: acc.examples,
        distinctValues,
        distinctValuesCapped: acc.distinctCapped,
        enumLike,
      };
    })
    .sort((a, b) => b.occurrences - a.occurrences || a.field.localeCompare(b.field));

  return { scope, totalDocs: docs.length, skipped, fields };
}
