// A vault that declared `series` as a schema extension before it became a
// built-in (#645). loadConfig runs on essentially every write path, so the
// refusal has to carry the fix, as it does for valid_from / valid_until.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configPath, loadConfig } from "../../src/utils/config.js";

describe("loadConfig — series as a pre-existing schema extension", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-config-series-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a 'series' extension with an actionable upgrade message", () => {
    mkdirSync(join(dir, ".daftari"), { recursive: true });
    writeFileSync(configPath(dir), "schema_extensions:\n  series:\n    type: string\n");
    const result = loadConfig(dir);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const msg = result.error.message;
    expect(msg).toContain("series");
    expect(msg).toContain("built-in frontmatter field");
    expect(msg).toContain("schema_extensions");
    expect(msg).toMatch(/rename/i);
  });
});
