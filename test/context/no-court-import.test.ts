// Tripwire: src/context/ and src/tools/context.ts must never import from
// src/court/ (CLAUDE.md: "the Tension Court is an operator-only surface;
// court/docket code never takes an access context. Exposing any court
// surface via MCP requires revisiting the 2026-07-14 edge-graph spec
// first." vault_context IS an MCP-exposed, access-context-carrying read
// path — a static import check, not a convention, keeps that boundary
// honest as the module grows.)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..", "..");
const GUARDED_FILES = [
  join(REPO_ROOT, "src", "context", "estimate.ts"),
  join(REPO_ROOT, "src", "context", "assemble.ts"),
  join(REPO_ROOT, "src", "tools", "context.ts"),
];

describe("court import tripwire", () => {
  for (const file of GUARDED_FILES) {
    it(`${file.replace(REPO_ROOT, "")} imports nothing from src/court/`, () => {
      const text = readFileSync(file, "utf-8");
      const importLines = text
        .split("\n")
        .filter((line) => /^\s*import\b/.test(line) || /^\s*export\s+.*\bfrom\b/.test(line));
      for (const line of importLines) {
        expect(line, `${file} imports from src/court/: ${line}`).not.toMatch(/["'].*\/court\//);
      }
    });
  }
});
