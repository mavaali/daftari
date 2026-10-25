// Config parsing for the vault-level `visibility` marker (cross-vault leak
// gate, U1). A vault declares itself "private" or "shared" in
// .daftari/config.yaml; a later reader stamps documents from it. Default is
// "shared" so a single-vault install has no private reads and the future
// gate is a no-op — no breakage. An invalid value is a loud config error,
// matching the loud-config contract used elsewhere in this file.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../../src/utils/config.js";

describe("loadConfig — visibility", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-visibility-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
  }

  it("defaults to shared when no config file exists", () => {
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.visibility).toBe("shared");
  });

  it("defaults to shared when the visibility key is absent", () => {
    writeConfig("auto_commit: true\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.visibility).toBe("shared");
  });

  it("loads visibility: private", () => {
    writeConfig("visibility: private\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.visibility).toBe("private");
  });

  it("loads visibility: shared explicitly", () => {
    writeConfig("visibility: shared\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.visibility).toBe("shared");
  });

  it("fails loud on an invalid visibility value", () => {
    writeConfig("visibility: bogus\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/visibility/);
    expect(result.error.message).toMatch(/private/);
    expect(result.error.message).toMatch(/shared/);
  });

  it("rejects a non-string visibility value", () => {
    writeConfig("visibility: 42\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/must be a string/);
  });
});
