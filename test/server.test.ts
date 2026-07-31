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

  it("unknown names in include/exclude are reported once each, never fatal", () => {
    const { exposed, unknown } = exposure({
      tier: "core",
      // vault_future_tool appears in BOTH lists — one warning, not two.
      include: ["vault_future_tool"],
      exclude: ["vault_also_future", "vault_future_tool"],
    });
    expect(unknown.sort()).toEqual(["vault_also_future", "vault_future_tool"]);
    expect(exposed.size).toBe(CORE_TOOLS.length);
  });
});

// docs/architecture.md states the stdio tool count in two places: the opening
// paragraph and the layered-model diagram. Both went stale at #240 — the number
// said 25 while the registry had grown to 33 — because nothing tied the prose to
// the registry. A reader who trusts the number to decide whether a tool exists
// is misled by exactly the drift this pins.
describe("architecture.md's tool count", () => {
  it("matches the registry, in both places it is stated", async () => {
    const { readFile } = await import("node:fs/promises");
    const doc = await readFile(new URL("../docs/architecture.md", import.meta.url), "utf8");
    const stated = [...doc.matchAll(/(\d+) tools/g)].map((m) => Number(m[1]));

    // Two sites, so a future edit that fixes one and forgets the other fails.
    expect(stated).toHaveLength(2);
    for (const n of stated) expect(n).toBe(registeredToolNames().length);
  });
});
