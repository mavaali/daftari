// test/distill/reader-fingerprint.test.ts
//
// Unit tests for the reader provenance fingerprint (f3h):
//   - encodeReader produces a compact, stable, single-line SET element.
//   - READER_PROMPT_VERSION is deterministic and is a pure function of
//     EXTRACT_SYSTEM + the injected extraction JSON schema (perturbing either
//     changes it).

import { describe, expect, it } from "vitest";
import type { ClaimRunMeta } from "../../src/distill/extract.js";
import { EXTRACT_SCHEMA, EXTRACT_SYSTEM } from "../../src/distill/extract.js";
import {
  encodeReader,
  hash8,
  READER_PROMPT_VERSION,
} from "../../src/distill/reader-fingerprint.js";

function runMeta(overrides: Partial<ClaimRunMeta> = {}): ClaimRunMeta {
  return {
    requestedModel: "claude-opus-4",
    servedModel: "claude-opus-4-20260101",
    effectiveTemperature: 0,
    viaRetry: false,
    chunkWindow: 12,
    inputCap: 8000,
    ...overrides,
  };
}

describe("encodeReader", () => {
  it("encodes a compact single-line SET element with the locked shape", () => {
    const s = encodeReader(runMeta(), "abcd1234");
    expect(s).toBe("claude-opus-4@0|prompt=abcd1234|retry=false");
    // Single line, no commas — safe to store as one SET element and re-parse.
    expect(s).not.toMatch(/[\r\n,]/);
  });

  it("is deterministic: same inputs → same string", () => {
    expect(encodeReader(runMeta(), "v")).toBe(encodeReader(runMeta(), "v"));
  });

  it("uses the 'na' temperature sentinel only in the encoded string when effectiveTemperature is undefined", () => {
    const s = encodeReader(runMeta({ effectiveTemperature: undefined }), "vv");
    expect(s).toBe("claude-opus-4@na|prompt=vv|retry=false");
  });

  it("defaults retry to false when viaRetry is undefined, and reflects a bumped retry temp", () => {
    expect(encodeReader(runMeta({ viaRetry: undefined }), "v")).toContain("retry=false");
    const salvaged = encodeReader(runMeta({ viaRetry: true, effectiveTemperature: 0.2 }), "v");
    expect(salvaged).toBe("claude-opus-4@0.2|prompt=v|retry=true");
  });

  it("changing the prompt version changes the encoded element", () => {
    expect(encodeReader(runMeta(), "aaaa1111")).not.toBe(encodeReader(runMeta(), "bbbb2222"));
  });
});

describe("READER_PROMPT_VERSION", () => {
  it("is an 8-hex-char token", () => {
    expect(READER_PROMPT_VERSION).toMatch(/^[0-9a-f]{8}$/);
  });

  it("equals hash8 of EXTRACT_SYSTEM + the schema serialized exactly as llm.ts injects it", () => {
    // llm.ts's completeJsonWithRetry embeds the schema as
    // `JSON.stringify(opts.schema, null, 2)` — reproduce that here.
    const expected = hash8(`${EXTRACT_SYSTEM}${JSON.stringify(EXTRACT_SCHEMA, null, 2)}`);
    expect(READER_PROMPT_VERSION).toBe(expected);
  });

  it("changes when EXTRACT_SYSTEM changes", () => {
    const base = hash8(`${EXTRACT_SYSTEM}${JSON.stringify(EXTRACT_SCHEMA, null, 2)}`);
    const perturbed = hash8(`${EXTRACT_SYSTEM} EXTRA${JSON.stringify(EXTRACT_SCHEMA, null, 2)}`);
    expect(perturbed).not.toBe(base);
  });

  it("changes when the injected schema changes", () => {
    const base = hash8(`${EXTRACT_SYSTEM}${JSON.stringify(EXTRACT_SCHEMA, null, 2)}`);
    const mutated = { ...(EXTRACT_SCHEMA as object), required: ["claims", "extra"] };
    const perturbed = hash8(`${EXTRACT_SYSTEM}${JSON.stringify(mutated, null, 2)}`);
    expect(perturbed).not.toBe(base);
  });

  it("hash8 is stable and 8 chars for the same input", () => {
    expect(hash8("hello")).toBe(hash8("hello"));
    expect(hash8("hello")).toHaveLength(8);
    expect(hash8("hello")).not.toBe(hash8("world"));
  });
});
