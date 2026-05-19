// Executes pre-write hooks against a candidate frontmatter and returns the
// combined ValidationIssue list. Every hook runs (no fail-fast); a hook
// that throws is converted into a synthetic issue whose field is the hook
// path and whose message names the underlying error. Hooks never see each
// other's issues — each is called with the same frontmatter input.

import type { ValidationIssue } from "../frontmatter/types.js";
import type { HookContext, LoadedHook } from "./types.js";

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
