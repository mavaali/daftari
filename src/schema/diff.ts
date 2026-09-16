import { validateFrontmatter } from "../frontmatter/schema.js";
import { BUILTIN_FRONTMATTER_FIELDS } from "../frontmatter/types.js";
import type { SchemaExtension } from "../utils/config.js";
import {
  compareSchemaText,
  inferSchema,
  type ObservedType,
  type RawFrontmatterDocument,
  schemaExampleValue,
} from "./infer.js";

export interface UndeclaredField {
  field: string;
  occurrences: number;
  prevalence: number;
  types: ObservedType[];
  examples: unknown[];
  distinctValues: number;
  distinctValuesCapped: boolean;
  enumLike: boolean;
}

export interface ValueDrift {
  field: string;
  declaredType: SchemaExtension["type"] | "built-in";
  occurrences: number;
  offending: number;
  messages: string[];
  messagesCapped: boolean;
  omittedMessages: number;
  examples: { path: string; value: unknown }[];
}

const DRIFT_MESSAGE_LIMIT = 5;

function driftCategory(message: string): string {
  return message
    .replace(/element \d+/g, "element <index>")
    .replace(/, got .+$/s, ", got <value>")
    .replace(/\(\d+ > \d+\)/g, "(<length> > <limit>)");
}

export interface NearMiss {
  field: string;
  suggestedField: string;
  distance: number;
  occurrences: number;
}

export interface SchemaDiff {
  documentCount: number;
  minOccurrences: number;
  undeclared: UndeclaredField[];
  unusedExtensions: Pick<SchemaExtension, "field" | "type" | "required">[];
  valueDrift: ValueDrift[];
  nearMisses: NearMiss[];
}

export interface SchemaDiffOptions {
  minOccurrences?: number;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        (current[j - 1] ?? 0) + 1,
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? right.length;
}

function nearMiss(
  field: string,
  declaredFields: readonly string[],
): { suggestedField: string; distance: number } | null {
  if (field.length < 3) return null;
  const normalized = field.toLowerCase();
  const candidates = declaredFields
    .filter((declared) => declared.length >= 3)
    .map((declared) => ({
      suggestedField: declared,
      distance: editDistance(normalized, declared.toLowerCase()),
    }))
    .filter(
      ({ suggestedField, distance }) =>
        distance <= 2 && distance / Math.max(field.length, suggestedField.length) <= 1 / 3,
    )
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        compareSchemaText(left.suggestedField, right.suggestedField),
    );
  return candidates[0] ?? null;
}

export function diffSchema(
  documents: RawFrontmatterDocument[],
  extensions: SchemaExtension[],
  options: SchemaDiffOptions = {},
): SchemaDiff {
  const minOccurrences = Math.max(1, Math.floor(options.minOccurrences ?? 2));
  const inferred = inferSchema(documents);
  const declaredFields = [
    ...(BUILTIN_FRONTMATTER_FIELDS as readonly string[]),
    ...extensions.map((extension) => extension.field),
  ];
  const declared = new Set(declaredFields);
  const usedExtensions = new Set<string>();
  for (const document of documents) {
    for (const extension of extensions) {
      const value = document.frontmatter[extension.field];
      if (value !== undefined && value !== null) usedExtensions.add(extension.field);
    }
  }

  const undeclared = inferred.fields
    .filter((field) => !declared.has(field.field) && field.occurrences >= minOccurrences)
    .map(
      ({
        field,
        occurrences,
        prevalence,
        types,
        examples,
        distinctValues,
        distinctValuesCapped,
        enumLike,
      }) => ({
        field,
        occurrences,
        prevalence,
        types,
        examples,
        distinctValues,
        distinctValuesCapped,
        enumLike,
      }),
    );

  const unusedExtensions = extensions
    .filter((extension) => !usedExtensions.has(extension.field))
    .map(({ field, type, required }) => ({ field, type, required }))
    .sort((left, right) => compareSchemaText(left.field, right.field));

  const inferredByField = new Map(inferred.fields.map((field) => [field.field, field]));
  const extensionsByField = new Map(extensions.map((extension) => [extension.field, extension]));
  const driftByField = new Map<
    string,
    {
      offending: number;
      messages: Map<string, string>;
      omittedMessages: number;
      examples: { path: string; value: unknown }[];
    }
  >();
  for (const document of documents) {
    const validation = validateFrontmatter(document.frontmatter, extensions);
    const issuesByField = new Map<string, string[]>();
    for (const issue of validation.report.issues) {
      if (!declared.has(issue.field) || !Object.hasOwn(document.frontmatter, issue.field)) continue;
      if (
        extensionsByField.has(issue.field) &&
        (document.frontmatter[issue.field] === undefined ||
          document.frontmatter[issue.field] === null)
      ) {
        continue;
      }
      const messages = issuesByField.get(issue.field) ?? [];
      messages.push(issue.message);
      issuesByField.set(issue.field, messages);
    }
    for (const [field, messages] of issuesByField) {
      const accumulator = driftByField.get(field) ?? {
        offending: 0,
        messages: new Map<string, string>(),
        omittedMessages: 0,
        examples: [],
      };
      accumulator.offending += 1;
      for (const message of messages) {
        const category = String(schemaExampleValue(driftCategory(message)));
        if (accumulator.messages.has(category)) continue;
        if (accumulator.messages.size < DRIFT_MESSAGE_LIMIT) {
          accumulator.messages.set(category, String(schemaExampleValue(message)));
        } else {
          accumulator.omittedMessages += 1;
        }
      }
      if (accumulator.examples.length < 5) {
        accumulator.examples.push({
          path: document.path,
          value: schemaExampleValue(document.frontmatter[field]),
        });
      }
      driftByField.set(field, accumulator);
    }
  }
  const valueDrift = [...driftByField.entries()]
    .sort(([left], [right]) => compareSchemaText(left, right))
    .map(
      ([field, accumulator]): ValueDrift => ({
        field,
        declaredType: extensionsByField.get(field)?.type ?? "built-in",
        occurrences: inferredByField.get(field)?.occurrences ?? 0,
        offending: accumulator.offending,
        messages: [...accumulator.messages.values()].sort(compareSchemaText),
        messagesCapped: accumulator.omittedMessages > 0,
        omittedMessages: accumulator.omittedMessages,
        examples: accumulator.examples.sort((left, right) =>
          compareSchemaText(left.path, right.path),
        ),
      }),
    );

  const nearMisses = inferred.fields
    .filter((field) => !declared.has(field.field))
    .flatMap((field): NearMiss[] => {
      const match = nearMiss(field.field, declaredFields);
      return match ? [{ field: field.field, occurrences: field.occurrences, ...match }] : [];
    })
    .sort((left, right) => compareSchemaText(left.field, right.field));

  return {
    documentCount: documents.length,
    minOccurrences,
    undeclared,
    unusedExtensions,
    valueDrift,
    nearMisses,
  };
}
