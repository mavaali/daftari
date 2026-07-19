import { describe, expect, it } from "vitest";
import {
  CORE_TOOLS,
  registeredToolNames,
  resolveToolExposure,
  STANDARD_TOOLS,
} from "../src/server.js";
import type { ToolsConfig } from "../src/utils/config.js";

function exposure(overrides: Partial<ToolsConfig>): ReturnType<typeof resolveToolExposure> {
  return resolveToolExposure({ tier: "full", include: [], exclude: [], ...overrides });
}

describe("tool exposure tiers (#103/#104)", () => {
  it("every tier-listed tool is a registered tool — no stale names survive a rename", () => {
    const registered = new Set(registeredToolNames());
    for (const name of STANDARD_TOOLS) {
      expect(registered.has(name), `${name} is tier-listed but not registered`).toBe(true);
    }
  });

  it("tiers nest: core ⊂ standard ⊂ full", () => {
    const standard = new Set(STANDARD_TOOLS);
    for (const name of CORE_TOOLS) expect(standard.has(name)).toBe(true);
    expect(CORE_TOOLS.length).toBeLessThan(STANDARD_TOOLS.length);
    expect(STANDARD_TOOLS.length).toBeLessThan(registeredToolNames().length);
  });

  it("full exposes the whole registry, including tools added after the tier lists", () => {
    const { exposed, unknown } = exposure({ tier: "full" });
    expect([...exposed].sort()).toEqual([...registeredToolNames()].sort());
    expect(unknown).toEqual([]);
  });

  it("core exposes exactly the search-before-derive loop", () => {
    const { exposed } = exposure({ tier: "core" });
    expect([...exposed].sort()).toEqual([...CORE_TOOLS].sort());
  });

  it("standard exposes the document lifecycle on top of core", () => {
    const { exposed } = exposure({ tier: "standard" });
    expect([...exposed].sort()).toEqual([...STANDARD_TOOLS].sort());
    expect(exposed.has("vault_tension_log")).toBe(false);
    expect(exposed.has("vault_themes")).toBe(false);
  });

  it("include adds beyond the tier and exclude removes from it — exclude wins (#104)", () => {
    const { exposed } = exposure({
      tier: "core",
      include: ["vault_tension_log"],
      exclude: ["vault_status", "vault_tension_log"],
    });
    expect(exposed.has("vault_tension_log")).toBe(false); // included, then excluded
    expect(exposed.has("vault_status")).toBe(false); // excluded from core
    expect(exposed.has("vault_search")).toBe(true); // untouched core member
  });

  it("unknown names in include/exclude are reported, never fatal", () => {
    const { exposed, unknown } = exposure({
      tier: "core",
      include: ["vault_future_tool"],
      exclude: ["vault_also_future"],
    });
    expect(unknown.sort()).toEqual(["vault_also_future", "vault_future_tool"]);
    expect(exposed.size).toBe(CORE_TOOLS.length);
  });
});
