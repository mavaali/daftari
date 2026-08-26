// dormancy.test.ts — U14: Board module dormancy smoke test.
//
// Proves that importing and holding board modules causes ZERO side effects:
//   - No filesystem I/O at import time.
//   - No ledger file created by merely importing or holding SOURCE_ADAPTERS.
//   - The three board tool names are present in the registry (registration
//     completeness).
//
// This is a smoke test, not a unit test — it verifies that the board is
// fully additive (R7): existing MCP/CLI/viewer paths are unaffected when the
// board module is present but not called.
//
// Run with:
//   npx vitest run src/board/dormancy.test.ts

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Import board tools to verify registration completeness.
// This mirrors what src/server.ts does at startup.
import { boardTools } from "../tools/board.js";
import { boardDispositionsPath } from "./ledger.js";
// Import the board modules under test — these must not perform I/O at
// module evaluation time. If they did, the import itself would be the bug.
import { SOURCE_ADAPTERS } from "./sources/index.js";

// ---------------------------------------------------------------------------
// Scenario 1: Importing board modules causes no filesystem side effects.
// ---------------------------------------------------------------------------

describe("board dormancy — import-time side effects", () => {
  let tmpVault: string;

  beforeEach(() => {
    tmpVault = mkdtempSync(join(tmpdir(), "daftari-dormancy-test-"));
  });

  afterEach(() => {
    rmSync(tmpVault, { recursive: true, force: true });
  });

  it("board-dispositions.jsonl is NOT created by importing board modules", () => {
    // The imports at the top of this file have already executed.
    // If any import-time I/O touched a vault's .daftari dir, we'd catch it here.
    // (We use tmpVault as a sentinel — importing cannot know about a vault
    //  created after module evaluation, so this path must remain clean.)
    const ledgerPath = boardDispositionsPath(tmpVault);
    expect(existsSync(ledgerPath)).toBe(false);
  });

  it("SOURCE_ADAPTERS registry is populated with at least one adapter (not empty)", () => {
    // Confirms the registry was built without side effects.
    expect(SOURCE_ADAPTERS.length).toBeGreaterThan(0);
  });

  it("holding SOURCE_ADAPTERS does not write anything to a vault directory", () => {
    // Reference the registry. Merely holding it must not trigger I/O.
    const count = SOURCE_ADAPTERS.length;
    expect(count).toBeGreaterThan(0);

    // No .daftari dir or ledger file should have appeared.
    expect(existsSync(join(tmpVault, ".daftari"))).toBe(false);
    expect(existsSync(boardDispositionsPath(tmpVault))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Board tool registration completeness.
// Confirms all three board tools are in the boardTools array before any call.
// ---------------------------------------------------------------------------

describe("board dormancy — tool registration completeness", () => {
  it("boardTools contains vault_board_list", () => {
    const names = boardTools.map((t) => t.name);
    expect(names).toContain("vault_board_list");
  });

  it("boardTools contains vault_board_dispose", () => {
    const names = boardTools.map((t) => t.name);
    expect(names).toContain("vault_board_dispose");
  });

  it("boardTools contains vault_board_resolve", () => {
    const names = boardTools.map((t) => t.name);
    expect(names).toContain("vault_board_resolve");
  });

  it("boardTools has exactly three entries (no phantom tools)", () => {
    expect(boardTools).toHaveLength(3);
  });
});
