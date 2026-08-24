import { createHash } from "node:crypto";

export interface RawFrontmatterDocument {
  path: string;
  frontmatter: Record<string, unknown>;
}

export type ObservedType = "null" | "boolean" | "number" | "date" | "string" | "array" | "object";

export interface InferredField {
  field: string;
  occurrences: number;
  prevalence: number;
  types: ObservedType[];
  distinctValues: number;
  distinctValuesCapped: boolean;
  examples: unknown[];
  enumLike: boolean;
}

export interface InferredSchema {
  documentCount: number;
  fields: InferredField[];
}

const EXAMPLE_LIMIT = 5;
const DISTINCT_VALUE_LIMIT = 50;
const EXAMPLE_CHARACTER_LIMIT = 200;
const ENUM_DISTINCT_LIMIT = 10;
const CANONICAL_DEPTH_LIMIT = 20;
const CANONICAL_NODE_LIMIT = 200;
const TYPE_ORDER: ObservedType[] = [
  "null",
  "boolean",
  "number",
  "date",
  "string",
  "array",
  "object",
];

export function compareSchemaText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function observedType(value: unknown): ObservedType {
  if (value === null) return "null";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return "date";
  if (Array.isArray(value)) return "array";
  if (typeof value === "object") return "object";
  if (typeof value === "string" && isIsoDate(value)) return "date";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "string";
}

function normalizedValue(value: unknown): unknown {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return value;
}

interface CanonicalState {
  ancestors: WeakSet<object>;
  nodes: number;
}

function canonicalValue(
  value: unknown,
  state: CanonicalState = { ancestors: new WeakSet<object>(), nodes: 0 },
  depth = 0,
): unknown {
  if (state.nodes >= CANONICAL_NODE_LIMIT) return "[NodeLimit]";
  state.nodes += 1;
  const normalized = normalizedValue(value);
  if (typeof normalized === "number" && !Number.isFinite(normalized)) return String(normalized);
  if (typeof normalized === "bigint") return `${normalized}n`;
  if (["function", "symbol", "undefined"].includes(typeof normalized)) {
    return `[${typeof normalized}]`;
  }
  if (normalized === null || typeof normalized !== "object") return normalized;
  if (state.ancestors.has(normalized)) return "[Circular]";
  if (depth >= CANONICAL_DEPTH_LIMIT) return "[DepthLimit]";
  state.ancestors.add(normalized);
  let canonical: unknown;
  if (Array.isArray(normalized)) {
    const items: unknown[] = [];
    for (const item of normalized) {
      if (state.nodes >= CANONICAL_NODE_LIMIT) {
        items.push("[NodeLimit]");
        break;
      }
      items.push(canonicalValue(item, state, depth + 1));
    }
    canonical = items;
  } else {
    const record: Record<string, unknown> = {};
    const keys = Object.keys(normalized).sort(compareSchemaText);
    for (const key of keys) {
      if (state.nodes >= CANONICAL_NODE_LIMIT) {
        record["[NodeLimit]"] = "[NodeLimit]";
        break;
      }
      record[key] = canonicalValue((normalized as Record<string, unknown>)[key], state, depth + 1);
    }
    canonical = record;
  }
  state.ancestors.delete(normalized);
  return canonical;
}

function serializedValue(value: unknown): string {
  return JSON.stringify(canonicalValue(value)) ?? String(value);
}

function valueKey(value: unknown): string {
  const type = observedType(value);
  const digest = createHash("sha256").update(serializedValue(value)).digest("hex");
  return `${String(TYPE_ORDER.indexOf(type)).padStart(2, "0")}:${digest}`;
}

export function schemaExampleValue(value: unknown): unknown {
  const canonical = canonicalValue(value);
  if (typeof canonical === "string" && canonical.length > EXAMPLE_CHARACTER_LIMIT) {
    return `${canonical.slice(0, EXAMPLE_CHARACTER_LIMIT)}…`;
  }
  const serialized = JSON.stringify(canonical) ?? String(canonical);
  return serialized.length > EXAMPLE_CHARACTER_LIMIT
    ? `${serialized.slice(0, EXAMPLE_CHARACTER_LIMIT)}…`
    : canonical;
}

function exampleSortKey(value: unknown): string {
  const type = observedType(value);
  return `${String(TYPE_ORDER.indexOf(type)).padStart(2, "0")}:${serializedValue(value)}`;
}

export function inferSchema(documents: RawFrontmatterDocument[]): InferredSchema {
  const byField = new Map<
    string,
    {
      occurrences: number;
      types: Set<ObservedType>;
      distinct: Map<string, unknown>;
      distinctValuesCapped: boolean;
    }
  >();
  for (const document of documents) {
    for (const [field, value] of Object.entries(document.frontmatter)) {
      const accumulator = byField.get(field) ?? {
        occurrences: 0,
        types: new Set<ObservedType>(),
        distinct: new Map<string, unknown>(),
        distinctValuesCapped: false,
      };
      accumulator.occurrences += 1;
      accumulator.types.add(observedType(value));
      const key = valueKey(value);
      if (accumulator.distinct.has(key)) {
        // Already represented; nothing else to retain.
      } else if (accumulator.distinct.size < DISTINCT_VALUE_LIMIT) {
        accumulator.distinct.set(key, schemaExampleValue(value));
      } else {
        accumulator.distinctValuesCapped = true;
      }
      byField.set(field, accumulator);
    }
  }

  const fields = [...byField.entries()]
    .sort(([left], [right]) => compareSchemaText(left, right))
    .map(([field, accumulator]): InferredField => {
      const types = [...accumulator.types].sort(
        (left, right) => TYPE_ORDER.indexOf(left) - TYPE_ORDER.indexOf(right),
      );
      const examples = [...accumulator.distinct.values()]
        .sort((left, right) => compareSchemaText(exampleSortKey(left), exampleSortKey(right)))
        .slice(0, EXAMPLE_LIMIT);
      const enumLike =
        !accumulator.distinctValuesCapped &&
        types.length === 1 &&
        ["boolean", "number", "string"].includes(types[0] ?? "") &&
        accumulator.distinct.size <= ENUM_DISTINCT_LIMIT &&
        accumulator.distinct.size < accumulator.occurrences;
      return {
        field,
        occurrences: accumulator.occurrences,
        prevalence: documents.length === 0 ? 0 : accumulator.occurrences / documents.length,
        types,
        distinctValues: accumulator.distinct.size,
        distinctValuesCapped: accumulator.distinctValuesCapped,
        examples,
        enumLike,
      };
    });

  return { documentCount: documents.length, fields };
}
