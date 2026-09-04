import { err, ok, type Result } from "../frontmatter/types.js";
import type { IndexedFieldDeclaration, IndexedFieldType } from "../utils/config.js";
import { normalizeIsoDate } from "../utils/dates.js";

export const MAX_FIELD_FILTERS = 16;
export const MAX_INDEXED_FILTER_TEXT_BYTES = 4096;

export type FieldFilterOperator = "eq" | "gt" | "gte" | "lt" | "lte";

export interface CompiledFieldFilter {
  field: string;
  type: IndexedFieldType;
  op: FieldFilterOperator;
  value: string | number | boolean;
}

export interface FieldFilterSql {
  sql: string;
  params: Array<string | number>;
}

const OPERATORS: readonly FieldFilterOperator[] = ["eq", "gt", "gte", "lt", "lte"];
const RANGE_OPERATORS: readonly FieldFilterOperator[] = ["gt", "gte", "lt", "lte"];

function filterError(message: string): Result<CompiledFieldFilter[], Error> {
  return err(new Error(`vault_search 'filters': ${message}`));
}

export function parseFieldFilters(
  raw: unknown,
  declarations: IndexedFieldDeclaration[],
): Result<CompiledFieldFilter[], Error> {
  if (raw === undefined) return ok([]);
  if (!Array.isArray(raw)) return filterError("must be a list");
  if (raw.length > MAX_FIELD_FILTERS) {
    return filterError(`may contain at most ${MAX_FIELD_FILTERS} predicates`);
  }

  const byField = new Map(declarations.map((declaration) => [declaration.field, declaration]));
  const filters: CompiledFieldFilter[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return filterError(`filters[${i}] must be a mapping`);
    }
    const obj = entry as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key !== "field" && key !== "op" && key !== "value") {
        return filterError(`filters[${i}] has unrecognised property '${key}'`);
      }
    }
    if (typeof obj.field !== "string" || obj.field.length === 0) {
      return filterError(`filters[${i}].field must be a non-empty string`);
    }
    const declaration = byField.get(obj.field);
    if (!declaration) return filterError(`field '${obj.field}' is not indexed`);
    if (typeof obj.op !== "string" || !OPERATORS.includes(obj.op as FieldFilterOperator)) {
      return filterError(`filters[${i}] has unsupported operator '${String(obj.op)}'`);
    }
    const op = obj.op as FieldFilterOperator;
    if (
      RANGE_OPERATORS.includes(op) &&
      declaration.type !== "number" &&
      declaration.type !== "date"
    ) {
      return filterError(
        `operator '${op}' is not valid for ${declaration.type} field '${declaration.field}'`,
      );
    }

    let value: string | number | boolean;
    if (declaration.type === "number") {
      if (typeof obj.value !== "number" || !Number.isFinite(obj.value)) {
        return filterError(`filters[${i}].value must be a finite number`);
      }
      value = obj.value;
    } else if (declaration.type === "boolean") {
      if (typeof obj.value !== "boolean") {
        return filterError(`filters[${i}].value must be true or false`);
      }
      value = obj.value;
    } else if (declaration.type === "date") {
      if (typeof obj.value !== "string") {
        return filterError(`filters[${i}].value must be a YYYY-MM-DD date`);
      }
      const normalized = normalizeIsoDate(obj.value);
      if (normalized === null) {
        return filterError(`filters[${i}].value must be a YYYY-MM-DD date`);
      }
      value = normalized;
    } else {
      if (typeof obj.value !== "string") {
        return filterError(`filters[${i}].value must be a string`);
      }
      if (Buffer.byteLength(obj.value, "utf8") > MAX_INDEXED_FILTER_TEXT_BYTES) {
        return filterError(
          `filters[${i}].value must be at most ${MAX_INDEXED_FILTER_TEXT_BYTES} UTF-8 bytes`,
        );
      }
      if (declaration.type === "enum" && !(declaration.enum ?? []).includes(obj.value)) {
        return filterError(
          `filters[${i}].value must be one of [${(declaration.enum ?? []).join(", ")}]`,
        );
      }
      value = obj.value;
    }
    filters.push({ field: declaration.field, type: declaration.type, op, value });
  }
  return ok(filters);
}

const SQL_OPERATOR: Record<FieldFilterOperator, string> = {
  eq: "=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
};

export function compileFieldFilterSql(
  filters: CompiledFieldFilter[],
  pathExpression: string,
): FieldFilterSql {
  const params: Array<string | number> = [];
  const clauses = filters.map((filter, index) => {
    const alias = `df${index}`;
    const column =
      filter.type === "number"
        ? "number_value"
        : filter.type === "boolean"
          ? "bool_value"
          : "text_value";
    const value = typeof filter.value === "boolean" ? (filter.value ? 1 : 0) : filter.value;
    params.push(filter.field, filter.type, value);
    return (
      `EXISTS (SELECT 1 FROM document_fields AS ${alias} ` +
      `WHERE ${alias}.path = ${pathExpression} AND ${alias}.field = ? ` +
      `AND ${alias}.kind = ? AND ${alias}.${column} ${SQL_OPERATOR[filter.op]} ?)`
    );
  });
  return { sql: clauses.join(" AND "), params };
}
