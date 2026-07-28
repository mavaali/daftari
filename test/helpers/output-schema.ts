// Test-only ajv compilation/validation of tool `outputSchema`s (spec
// 2026-07-26, Decision 3, PR 1 gap closure / jugalbandi challenge C6).
//
// Production code never validates outputs at runtime — outputSchema is a
// contract on the wire shape, and this file is how the contract is
// enforced: every registered tool's schema must compile under strict
// JSON Schema 2020-12, and every value a handler test asserts must
// validate against its own tool's schema.
//
// `strict: true` is deliberate, not incidental (C6): `strict: false` (ajv's
// default when unset) SILENTLY ACCEPTS a misspelled keyword — `eunm`
// instead of `enum` compiles and matches everything, which would let this
// helper certify a typo'd schema as correct. Strict mode makes a misspelled
// keyword a compile-time failure. Where a schema genuinely needs a
// non-standard keyword, it goes in ALLOWED_VOCABULARY below — an explicit,
// reviewable relaxation, never a blanket one.

import type { ErrorObject, ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect } from "vitest";
import type { ToolDefinition } from "../../src/tools/read.js";

// No non-standard keywords are in use today. A tool that legitimately needs
// one adds it here, by name, with a one-line justification — never a
// blanket `strict: false`.
const ALLOWED_VOCABULARY: Record<string, true> = {};

function makeAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    strict: true,
    // The registry's schemas use JSON Schema union types throughout
    // (`type: ["string", "null"]` for every "absent means nothing to say"
    // field — the decay/validity/structural contract). That is standard
    // 2020-12, not a laxness; ajv's strict mode requires this opt-in
    // separately from `strict: true` itself.
    allowUnionTypes: true,
  });
  if (Object.keys(ALLOWED_VOCABULARY).length > 0) {
    ajv.addVocabulary(Object.keys(ALLOWED_VOCABULARY));
  }
  return ajv;
}

// One ajv instance for the whole test run — schemas are static, compiling
// per-call would just be slower for no benefit.
const ajv = makeAjv();
const compiled = new Map<string, ValidateFunction>();

// Compiles (and caches) a tool's outputSchema. Throws ajv's own compile
// error on a genuinely invalid or misspelled schema — callers that just want
// "does this compile" should wrap this in `expect(() => ...).not.toThrow()`.
export function compileToolSchema(tool: ToolDefinition): ValidateFunction {
  const cached = compiled.get(tool.name);
  if (cached) return cached;
  // ajv keys its internal schema cache by $id; two tools' schemas are
  // structurally independent (they're plain object literals with no shared
  // $id), so compiling per tool name is correct and collision-free.
  const validate = ajv.compile(tool.outputSchema);
  compiled.set(tool.name, validate);
  return validate;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ");
}

// Asserts `value` validates against `tool`'s own outputSchema. Failure
// message includes ajv's error paths so a broken assertion points straight
// at the offending field instead of a bare "expected true, got false".
export function expectMatchesOutputSchema(tool: ToolDefinition, value: unknown): void {
  const validate = compileToolSchema(tool);
  const ok = validate(value);
  expect(ok, `${tool.name} output failed schema validation: ${formatErrors(validate.errors)}`).toBe(
    true,
  );
}
