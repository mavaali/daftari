import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { load as parseYaml } from "js-yaml";
import { enableRealConsolidation } from "./consolidate-config.js";

describe("enableRealConsolidation", () => {
  it("throws when vaultRoot is NOT under os.tmpdir()", () => {
    expect(() => enableRealConsolidation("/etc/foo")).toThrow(
      "recall-bench: refusing to enable real consolidation (shadow_mode:false) outside os.tmpdir()",
    );
  });

  it("writes .daftari/config.yaml with shadow_mode: false under a real tmpdir vault", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "rb-test-"));
    enableRealConsolidation(vaultRoot);
    const configPath = join(vaultRoot, ".daftari", "config.yaml");
    const parsed = parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(parsed["shadow_mode"]).toBe(false);
  });

  it("preserves existing keys when config.yaml pre-exists", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "rb-test-"));
    const daftariDir = join(vaultRoot, ".daftari");
    mkdirSync(daftariDir, { recursive: true });
    writeFileSync(join(daftariDir, "config.yaml"), "transport: openrouter\n", "utf8");

    enableRealConsolidation(vaultRoot);

    const configPath = join(daftariDir, "config.yaml");
    const parsed = parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(parsed["shadow_mode"]).toBe(false);
    expect(parsed["transport"]).toBe("openrouter");
  });
});
