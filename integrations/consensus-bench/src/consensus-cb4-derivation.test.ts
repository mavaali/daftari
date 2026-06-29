import { describe, expect, test } from "vitest";
import { parseCb4Derivation, acquireDerivation } from "./consensus-cb4-derivation.js";
import type { LlmClient } from "./consensus-llm.js";

const stub = (reply: string): LlmClient => ({ complete: async () => reply });

describe("parseCb4Derivation", () => {
  test("parses related+premise+reason from a JSON object (with code fences)", () => {
    const v = parseCb4Derivation('```json\n{"related":true,"premise":"A","reason":"x"}\n```');
    expect(v).toEqual({ related: true, premise: "A", reason: "x" });
  });
  test("related:false discards premise", () => {
    expect(parseCb4Derivation('{"related":false,"premise":"A","reason":"none"}'))
      .toEqual({ related: false, premise: null, reason: "none" });
  });
  test("invalid shape -> null (unparseable)", () => {
    expect(parseCb4Derivation("not json")).toBeNull();
    expect(parseCb4Derivation('{"related":"yes"}')).toBeNull();
  });
  test("related:true with empty reason -> null (reason gate)", () => {
    expect(parseCb4Derivation('{"related":true,"premise":"A","reason":""}')).toBeNull();
  });
});

describe("acquireDerivation", () => {
  test("returns the parsed verdict from the model", async () => {
    const v = await acquireDerivation(stub('{"related":true,"premise":"B","reason":"r"}'), "GOV", "STALE");
    expect(v?.related).toBe(true);
    expect(v?.premise).toBe("B");
  });
});
