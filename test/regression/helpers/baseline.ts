// Golden-baseline diff for the Tier 1 regression suites. Baselines are
// committed JSON objects keyed by a stable id (revid, query id) mapping to a
// per-entry outcome object. Any difference — better or worse — is a failure:
// behavior changes must travel with a re-committed baseline in the same PR
// (docs/superpowers/specs/2026-07-07-regression-suite-design.md).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type Entry = Record<string, unknown>;
export type Baseline = Record<string, Entry>;

export interface BaselineDiffOptions {
  numericTolerance?: number;
}

export function round6(value: number | null): number | null {
  return value === null ? null : Math.round(value * 1e6) / 1e6;
}

function valuesEqual(expected: unknown, actual: unknown, numericTolerance: number): boolean {
  if (typeof expected === "number" && typeof actual === "number") {
    const roundingSlack = Number.EPSILON * Math.max(1, Math.abs(expected), Math.abs(actual));
    return Math.abs(expected - actual) <= numericTolerance + roundingSlack;
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    return (
      Array.isArray(expected) &&
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((value, index) => valuesEqual(value, actual[index], numericTolerance))
    );
  }
  if (
    typeof expected === "object" &&
    expected !== null &&
    typeof actual === "object" &&
    actual !== null
  ) {
    const expectedRecord = expected as Record<string, unknown>;
    const actualRecord = actual as Record<string, unknown>;
    const expectedKeys = Object.keys(expectedRecord).sort();
    const actualKeys = Object.keys(actualRecord).sort();
    return (
      JSON.stringify(expectedKeys) === JSON.stringify(actualKeys) &&
      expectedKeys.every((key) =>
        valuesEqual(expectedRecord[key], actualRecord[key], numericTolerance),
      )
    );
  }
  return Object.is(expected, actual);
}

function sortedStringify(obj: Baseline): string {
  const out: Baseline = {};
  for (const k of Object.keys(obj).sort()) {
    const entry: Entry = {};
    for (const f of Object.keys(obj[k]).sort()) entry[f] = obj[k][f];
    out[k] = entry;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

// Returns [] on match. In update mode (REGRESSION_UPDATE=1) writes `actual`
// and returns []. A missing baseline file is reported as a single diff line.
export function diffBaseline(
  path: string,
  actual: Baseline,
  options: BaselineDiffOptions = {},
): string[] {
  const numericTolerance = options.numericTolerance ?? 0;
  if (!Number.isFinite(numericTolerance) || numericTolerance < 0) {
    throw new Error("baseline numericTolerance must be a finite non-negative number");
  }
  if (process.env.REGRESSION_UPDATE === "1") {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, sortedStringify(actual));
    return [];
  }
  if (!existsSync(path)) {
    return [`${path}: baseline missing — run \`npm run regression:update-baseline\` and commit it`];
  }
  const expected = JSON.parse(readFileSync(path, "utf8")) as Baseline;
  const diffs: string[] = [];
  for (const k of Object.keys(expected)) {
    if (!(k in actual)) {
      diffs.push(`${k}: in baseline but not produced by this run`);
    } else if (!valuesEqual(expected[k], actual[k], numericTolerance)) {
      diffs.push(`${k}: ${JSON.stringify(expected[k])} → ${JSON.stringify(actual[k])}`);
    }
  }
  for (const k of Object.keys(actual)) {
    if (!(k in expected)) diffs.push(`${k}: new entry not in baseline`);
  }
  return diffs;
}
