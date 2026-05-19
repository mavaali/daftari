// Executes pre-write hooks against a candidate frontmatter and returns the
// combined ValidationIssue list. Every hook runs (no fail-fast); a hook
// that throws is converted into a synthetic issue whose field is the hook
// path and whose message names the underlying error. Hooks never see each
// other's issues — each is called with the same frontmatter input.

import type { ValidationIssue } from "../frontmatter/types.js";
import type { HookContext, LoadedHook, LoadedTransformHook } from "./types.js";

export function runPreWriteHooks(
  hooks: LoadedHook[],
  frontmatter: Record<string, unknown>,
  context: HookContext,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const { declaration, hook } of hooks) {
    try {
      const result = hook(frontmatter, context);
      if (!Array.isArray(result)) {
        issues.push({
          field: declaration.path,
          message: `hook returned non-array (got ${typeof result})`,
        });
        continue;
      }
      for (const issue of result) {
        if (
          issue === null ||
          typeof issue !== "object" ||
          typeof (issue as ValidationIssue).field !== "string" ||
          typeof (issue as ValidationIssue).message !== "string"
        ) {
          issues.push({
            field: declaration.path,
            message: `hook returned malformed issue: ${JSON.stringify(issue)}`,
          });
          continue;
        }
        issues.push(issue as ValidationIssue);
      }
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      issues.push({
        field: declaration.path,
        message: `hook threw: ${reason}`,
      });
    }
  }
  return issues;
}

// Describes a transform hook's return value for an error message: "null",
// "array", or its typeof.
function describeReturn(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// The result of running the pre_write_transform phase: the candidate
// frontmatter with every hook's patch merged in, plus any synthetic issues
// raised by a hook that threw or returned a non-object.
export interface TransformRunResult {
  merged: Record<string, unknown>;
  issues: ValidationIssue[];
}

// Executes pre_write_transform hooks against a candidate frontmatter. Hooks
// run in declaration order; each receives a fresh shallow copy of the
// *current* merged state, so a later transform sees an earlier one's output
// but cannot mutate the running state in place. A hook's Partial<Frontmatter>
// return is merged Object.assign-style — shallow, last-writer-wins, arrays
// replaced whole.
//
// A hook that throws becomes a synthetic blocking issue whose field is the
// hook path and whose message names the underlying error; nothing from a
// thrown hook is merged. A non-object return (array, primitive, null) is
// likewise a synthetic blocking issue with no merge. Every hook still runs
// even after an earlier hook failed — matching the run-all pre_write contract.
export function runPreWriteTransformHooks(
  hooks: LoadedTransformHook[],
  frontmatter: Record<string, unknown>,
  context: HookContext,
): TransformRunResult {
  const issues: ValidationIssue[] = [];
  let merged: Record<string, unknown> = { ...frontmatter };

  for (const { declaration, hook } of hooks) {
    let partial: unknown;
    try {
      partial = hook({ ...merged }, context);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      issues.push({
        field: declaration.path,
        message: `transform hook threw: ${reason}`,
      });
      continue;
    }
    if (partial === null || typeof partial !== "object" || Array.isArray(partial)) {
      issues.push({
        field: declaration.path,
        message: `transform hook returned non-object (got ${describeReturn(partial)})`,
      });
      continue;
    }
    merged = { ...merged, ...(partial as Record<string, unknown>) };
  }

  return { merged, issues };
}
