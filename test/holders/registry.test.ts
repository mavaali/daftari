import { describe, expect, it } from "vitest";
import { buildRegistry, isRegistered, resolveHolder } from "../../src/holders/registry.js";

describe("holder registry", () => {
  const reg = buildRegistry({ "mavaali-v1": "agent:mavaali", mavaali: "agent:mavaali" });

  it("maps many historical strings to one canonical holder", () => {
    expect(resolveHolder(reg, "mavaali-v1")).toBe("agent:mavaali");
    expect(resolveHolder(reg, "mavaali")).toBe("agent:mavaali");
  });

  it("passes through an unknown string as its own holder id", () => {
    expect(resolveHolder(reg, "human:bob")).toBe("human:bob");
  });

  it("flags unregistered strings so a rename cannot forge a ghost holder", () => {
    expect(isRegistered(reg, "mavaali-v1")).toBe(true);
    expect(isRegistered(reg, "human:bob")).toBe(false);
  });
});
