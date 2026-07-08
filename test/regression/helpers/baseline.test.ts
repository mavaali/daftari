import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffBaseline } from "./baseline.js";

describe("diffBaseline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "daftari-baseline-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.REGRESSION_UPDATE;
  });

  const file = () => join(dir, "b.json");
  const write = (obj: unknown) => writeFileSync(file(), `${JSON.stringify(obj, null, 2)}\n`);

  it("returns [] when actual matches the committed baseline", () => {
    write({ a: { hit: true }, b: { hit: false } });
    expect(diffBaseline(file(), { a: { hit: true }, b: { hit: false } })).toEqual([]);
  });

  it("names changed, missing, and extra entries", () => {
    write({ a: { hit: true }, gone: { hit: true } });
    const diffs = diffBaseline(file(), { a: { hit: false }, fresh: { hit: true } });
    expect(diffs.some((d) => d.includes("a"))).toBe(true);
    expect(diffs.some((d) => d.includes("gone"))).toBe(true);
    expect(diffs.some((d) => d.includes("fresh"))).toBe(true);
    expect(diffs).toHaveLength(3);
  });

  it("reports a missing baseline file as a diff, not a crash", () => {
    const diffs = diffBaseline(file(), { a: { hit: true } });
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("regression:update-baseline");
  });

  it("update mode writes the baseline with sorted keys and returns []", () => {
    process.env.REGRESSION_UPDATE = "1";
    expect(diffBaseline(file(), { b: { hit: true }, a: { hit: false } })).toEqual([]);
    const raw = readFileSync(file(), "utf8");
    expect(raw.indexOf('"a"')).toBeLessThan(raw.indexOf('"b"'));
    expect(raw.endsWith("\n")).toBe(true);
    // and a subsequent non-update diff against what was written is clean
    delete process.env.REGRESSION_UPDATE;
    expect(diffBaseline(file(), { a: { hit: false }, b: { hit: true } })).toEqual([]);
  });
});
