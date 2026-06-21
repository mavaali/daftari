import { describe, it, expect } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig", () => {
  it("applies defaults when only answererModel is supplied", () => {
    const result = parseConfig({ answererModel: "claude-opus-4-8" });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
    expect(result.value).toEqual({
      answererModel: "claude-opus-4-8",
      maxSearchResults: 15,
      agentMaxIterations: 6,
    });
  });

  it("honors supplied overrides", () => {
    const result = parseConfig({
      answererModel: "claude-sonnet-4-5",
      maxSearchResults: 30,
      agentMaxIterations: 10,
    });
    if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
    expect(result.value).toEqual({
      answererModel: "claude-sonnet-4-5",
      maxSearchResults: 30,
      agentMaxIterations: 10,
    });
  });

  it("errors when answererModel is missing", () => {
    const result = parseConfig({});
    expect(result.ok).toBe(false);
  });

  it("errors when answererModel is empty or non-string", () => {
    expect(parseConfig({ answererModel: "" }).ok).toBe(false);
    expect(parseConfig({ answererModel: "   " }).ok).toBe(false);
    expect(parseConfig({ answererModel: 42 }).ok).toBe(false);
  });
});
