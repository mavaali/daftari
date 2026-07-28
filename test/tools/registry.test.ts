// vault_tools + registry module tests (spec 2026-07-26-context-packs-
// progressive-disclosure-design.md, final plan Phase 1.5).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { allRegisteredTools, registeredToolNames, vaultTools } from "../../src/tools/registry.js";
import { clearConfigCache, configPath } from "../../src/utils/config.js";
import { expectMatchesOutputSchema } from "../helpers/output-schema.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

function writeConfig(vault: string, yaml: string): void {
  mkdirSync(join(vault, ".daftari"), { recursive: true });
  writeFileSync(configPath(vault), yaml);
  clearConfigCache();
}

const ONE_LINE_MAX = 120;
const INDEX_TOKEN_BUDGET = 1500;

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

describe("ToolDefinition.oneLine — every registered tool", () => {
  it("every tool has a non-empty oneLine no longer than 120 chars", () => {
    for (const t of allRegisteredTools()) {
      expect(typeof t.oneLine, `${t.name}.oneLine`).toBe("string");
      expect(t.oneLine.length, `${t.name}.oneLine is empty`).toBeGreaterThan(0);
      expect(
        t.oneLine.length,
        `${t.name}.oneLine exceeds ${ONE_LINE_MAX} chars`,
      ).toBeLessThanOrEqual(ONE_LINE_MAX);
    }
  });

  it("the whole-registry index payload stays within the ~1,500 token budget", () => {
    const vaultTool = allRegisteredTools().find((t) => t.name === "vault_tools");
    expect(vaultTool).toBeTruthy();
    const index = allRegisteredTools()
      .map((t) => ({ name: t.name, oneLine: t.oneLine }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const payload = JSON.stringify({ mode: "index", count: index.length, tools: index });
    expect(estimateTokens(payload)).toBeLessThanOrEqual(INDEX_TOKEN_BUDGET);
  });
});

describe("vault_tools", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
    clearConfigCache();
  });

  afterEach(() => {
    clearConfigCache();
    cleanupVault(vault);
  });

  const tool = allRegisteredTools().find((t) => t.name === "vault_tools");
  if (!tool) throw new Error("vault_tools not registered");

  it("index mode (no expand arg) lists every registered tool, sorted by name", async () => {
    const result = await vaultTools(vault, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("index");
    if (result.value.mode !== "index") return;
    expect(result.value.count).toBe(registeredToolNames().length);
    const names = result.value.tools.map((t) => t.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names).toContain("vault_tools");
    expect(names).toContain("vault_context");
    expectMatchesOutputSchema(tool, result.value);
  });

  it("index mode is byte-deterministic across two calls", async () => {
    const a = await vaultTools(vault, {});
    const b = await vaultTools(vault, {});
    expect(a.ok && b.ok && JSON.stringify(a.value) === JSON.stringify(b.value)).toBe(true);
  });

  it("expand mode returns full definitions matching the ListTools serialization shape", async () => {
    const result = await vaultTools(vault, { expand: ["vault_search"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("expand");
    if (result.value.mode !== "expand") return;
    expect(result.value.tools).toHaveLength(1);
    expect(result.value.tools[0]?.name).toBe("vault_search");
    expect(result.value.tools[0]?.inputSchema).toBeTruthy();
    expect(result.value.tools[0]?.outputSchema).toBeTruthy();
    expect(result.value.unknown).toEqual([]);
    expectMatchesOutputSchema(tool, result.value);
  });

  it("unknown expand names land per-name in `unknown`, never a batch error", async () => {
    const result = await vaultTools(vault, { expand: ["vault_search", "vault_does_not_exist"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.value.mode !== "expand") throw new Error("expected expand mode");
    expect(result.value.tools.map((t) => t.name)).toEqual(["vault_search"]);
    expect(result.value.unknown).toEqual(["vault_does_not_exist"]);
  });

  it("empty exclude yields the full registry in index mode", async () => {
    const result = await vaultTools(vault, {});
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.mode !== "index") return;
    expect(result.value.count).toBe(registeredToolNames().length);
  });

  it("excluded tool is absent from index mode (C2 — exclude always wins)", async () => {
    writeConfig(vault, "roles: {}\ntools:\n  tier: full\n  exclude: [vault_lint]\n");
    const result = await vaultTools(vault, {});
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.mode !== "index") return;
    expect(result.value.tools.map((t) => t.name)).not.toContain("vault_lint");
    expect(result.value.count).toBe(registeredToolNames().length - 1);
  });

  it("expand of an excluded name lands in `unknown`, identical to unregistered (C2)", async () => {
    writeConfig(vault, "roles: {}\ntools:\n  tier: full\n  exclude: [vault_lint]\n");
    const result = await vaultTools(vault, { expand: ["vault_lint", "vault_search"] });
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.mode !== "expand") return;
    expect(result.value.tools.map((t) => t.name)).toEqual(["vault_search"]);
    expect(result.value.unknown).toEqual(["vault_lint"]);
  });

  it("tier does not affect vault_tools — a full registry with no exclude shows tiered-out tools", async () => {
    writeConfig(vault, "roles: {}\ntools:\n  tier: core\n");
    const result = await vaultTools(vault, {});
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.mode !== "index") return;
    // vault_tension_log is full-tier only, but vault_tools shows the whole
    // registry regardless of tier — tier and include never affect vault_tools.
    expect(result.value.tools.map((t) => t.name)).toContain("vault_tension_log");
  });
});
