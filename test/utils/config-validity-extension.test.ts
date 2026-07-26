// Upgrade path for vaults that already declared valid_from / valid_until as a
// schema extension — until these became built-ins, that was the only way to
// get the field at all.
//
// The hard fail is deliberate and kept: silently reinterpreting an authored
// extension as a built-in would change its semantics without telling anyone,
// and the extension's declared type may not even be a date. But
// validateExtension's generic "shadows a built-in frontmatter field" message
// propagates out of loadConfig, which runs on essentially every write path —
// so a vault that upgrades stops loading entirely, with no hint about what to
// do. The message has to carry the fix.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../../src/utils/config.js";

describe("loadConfig — validity fields as a pre-existing schema extension", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-validity-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), yaml);
  }

  for (const field of ["valid_from", "valid_until"]) {
    it(`refuses a '${field}' extension with an actionable upgrade message`, () => {
      writeConfig(`schema_extensions:\n  ${field}:\n    type: date\n`);
      const result = loadConfig(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      const msg = result.error.message;
      // Names the field, says it is now built-in, and states the fix.
      expect(msg).toContain(field);
      expect(msg).toContain("built-in frontmatter field");
      expect(msg).toContain("schema_extensions");
      expect(msg).toMatch(/rename/i);
      // The generic message alone is not enough — it tells an operator nothing.
      expect(msg).not.toBe(`schema_extensions '${field}' shadows a built-in frontmatter field`);
    });
  }

  it("still gives the generic message for an unrelated built-in", () => {
    writeConfig("schema_extensions:\n  status:\n    type: string\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("shadows a built-in frontmatter field");
    expect(result.error.message).not.toMatch(/rename/i);
  });
});
