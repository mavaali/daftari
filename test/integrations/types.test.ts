import { describe, expect, it } from "vitest";
import { isProviderName, PROVIDER_NAMES } from "../../src/integrations/types.js";

describe("isProviderName", () => {
  it("accepts every declared provider name", () => {
    for (const provider of PROVIDER_NAMES) {
      expect(isProviderName(provider)).toBe(true);
    }
  });

  it("accepts microsoft", () => {
    expect(isProviderName("microsoft")).toBe(true);
  });

  it("rejects an unknown provider string", () => {
    expect(isProviderName("dropbox")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isProviderName(123)).toBe(false);
    expect(isProviderName(undefined)).toBe(false);
    expect(isProviderName(null)).toBe(false);
  });
});
