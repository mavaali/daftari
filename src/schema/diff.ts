// Pure computation for `daftari schema diff` (#299): compares the vault's de
// facto schema (see infer.ts) against the declared one — built-ins plus
// config schema_extensions — and reports drift between intent and reality.
// Fixes nothing; a curation report like vault_lint.

import { validateFrontmatter } from "../frontmatter/schema.js";
import { BUILTIN_FRONTMATTER_FIELDS } from "../frontmatter/types.js";
import type { SchemaExtension } from "../utils/config.js";
import { inferFromDocs } from "./infer.js";
import type { DriftFinding, ScannedDoc, SchemaDiffReport, UndeclaredKeyFinding } from "./types.js";

// An undeclared key only gets reported once it's in "wide use" — a single
// stray field on one doc is noise, not a candidate for declaration. Two
// occurrences is a low bar on purpose: this is advisory, not a filter that
// should hide real drift on a small vault.
const DEFAULT_MIN_OCCURRENCES = 2;

// Near-miss field names (`state` vs `status`) within this edit distance are
// flagged as a likely typo/rename rather than a deliberate new key.
const NEAR_MISS_MAX_DISTANCE = 2;

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (curr[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[n] ?? 0;
}

function nearestDeclaredField(field: string, declared: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = NEAR_MISS_MAX_DISTANCE + 1;
  for (const candidate of declared) {
    if (candidate === field) continue;
    const distance = levenshtein(field, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= NEAR_MISS_MAX_DISTANCE ? best : null;
}

export interface DiffOptions {
  minOccurrences?: number;
}

export function diffFromDocs(
  docs: ScannedDoc[],
  extensions: SchemaExtension[],
  scope: string | null = null,
  opts: DiffOptions = {},
): SchemaDiffReport {
  const minOccurrences = opts.minOccurrences ?? DEFAULT_MIN_OCCURRENCES;
  const inferred = inferFromDocs(docs, scope);
  const declaredFields = [...BUILTIN_FRONTMATTER_FIELDS, ...extensions.map((e) => e.field)];
  const declaredSet = new Set(declaredFields);

  const undeclared: UndeclaredKeyFinding[] = inferred.fields
    .filter((f) => !declaredSet.has(f.field) && f.occurrences >= minOccurrences)
    .map((f) => ({
      field: f.field,
      occurrences: f.occurrences,
      types: f.types,
      enumLike: f.enumLike,
      nearMiss: nearestDeclaredField(f.field, declaredFields),
    }));

  const inferredByField = new Map(inferred.fields.map((f) => [f.field, f]));
  const unusedExtensions = extensions
    .filter((e) => !inferredByField.has(e.field))
    .map((e) => ({ field: e.field, type: e.type }));

  const driftAcc = new Map<
    string,
    { occurrences: number; offending: number; messages: Set<string>; examples: unknown[] }
  >();
  const extensionFields = new Set(extensions.map((e) => e.field));

  for (const doc of docs) {
    const { report } = validateFrontmatter(doc.raw, extensions);
    for (const issue of report.issues) {
      if (!extensionFields.has(issue.field)) continue;
      const value = doc.raw[issue.field];
      // A "missing required field" issue fires with no value present — that's
      // unused-extension territory (see below), not observed-value drift.
      if (value === undefined || value === null) continue;
      let acc = driftAcc.get(issue.field);
      if (!acc) {
        acc = { occurrences: 0, offending: 0, messages: new Set(), examples: [] };
        driftAcc.set(issue.field, acc);
      }
      acc.offending += 1;
      acc.messages.add(issue.message);
      if (acc.examples.length < 5) acc.examples.push(value);
    }
  }
  for (const ext of extensions) {
    const stats = inferredByField.get(ext.field);
    if (stats) {
      const acc = driftAcc.get(ext.field);
      if (acc) acc.occurrences = stats.occurrences;
    }
  }

  const drift: DriftFinding[] = extensions
    .map((ext): DriftFinding | null => {
      const acc = driftAcc.get(ext.field);
      if (!acc || acc.offending === 0) return null;
      return {
        field: ext.field,
        declaredType: ext.type,
        occurrences: acc.occurrences,
        offending: acc.offending,
        messages: [...acc.messages],
        examples: acc.examples,
      };
    })
    .filter((d): d is DriftFinding => d !== null);

  return { scope, totalDocs: inferred.totalDocs, undeclared, unusedExtensions, drift };
}
