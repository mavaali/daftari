import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  emptyTensionScanState,
  pairHash,
  readTensionScanState,
  scanContentHash,
  tensionScanStatePath,
  writeTensionScanState,
} from "../../src/sleep/tension-scan-state.js";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "daftari-scan-state-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("readTensionScanState", () => {
  it("returns the empty default when the file is absent", () => {
    expect(readTensionScanState(vault)).toEqual(emptyTensionScanState());
  });

  it("returns the empty default when the file is corrupt", () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(tensionScanStatePath(vault), "{not json", "utf-8");
    expect(readTensionScanState(vault)).toEqual(emptyTensionScanState());
  });

  it("drops malformed fields individually instead of failing the whole read", () => {
    mkdirSync(join(vault, ".daftari"), { recursive: true });
    writeFileSync(
      tensionScanStatePath(vault),
      JSON.stringify({
        lastScanCommit: 42, // wrong type ⇒ null
        scanned: { "a.md": "h1" },
        judgedPairs: ["p1", 7, "p2"], // non-strings dropped
      }),
      "utf-8",
    );
    const s = readTensionScanState(vault);
    expect(s.lastScanCommit).toBeNull();
    expect(s.scanned).toEqual({ "a.md": "h1" });
    expect(s.judgedPairs).toEqual(["p1", "p2"]);
  });

  it("round-trips through writeTensionScanState", () => {
    const state = {
      lastScanCommit: "abc123",
      scanned: { "pricing/a.md": "deadbeef00000000" },
      judgedPairs: ["p1", "p2"],
    };
    const wrote = writeTensionScanState(vault, state);
    expect(wrote.ok).toBe(true);
    expect(readTensionScanState(vault)).toEqual(state);
  });

  it("rejects an empty vaultRoot on write", () => {
    expect(writeTensionScanState("", emptyTensionScanState()).ok).toBe(false);
  });
});

describe("pairHash", () => {
  const a = { path: "x/a.md", contentHash: scanContentHash("alpha") };
  const b = { path: "y/b.md", contentHash: scanContentHash("beta") };

  it("is order-independent", () => {
    expect(pairHash(a, b)).toBe(pairHash(b, a));
  });

  it("changes when either side's content changes", () => {
    const aEdited = { path: a.path, contentHash: scanContentHash("alpha v2") };
    expect(pairHash(aEdited, b)).not.toBe(pairHash(a, b));
  });

  it("distinguishes different path pairs with identical content", () => {
    const c = { path: "z/c.md", contentHash: a.contentHash };
    expect(pairHash(c, b)).not.toBe(pairHash(a, b));
  });
});
