import { describe, expect, it } from "vitest";
import {
  encodeLineageEntry,
  parseLineageEntry,
  readersFromLineage,
  unionLineage,
} from "../../src/distill/reader-fingerprint.js";

describe("reader lineage codec", () => {
  it("round-trips ts|op|encodeReader (encodeReader may itself contain pipes)", () => {
    const reader = "anthropic/claude-haiku-4.5|unreported|0.2|false|ab12cd34|4000|8000";
    const e = encodeLineageEntry("2026-08-17T00:00:00Z", "ingest", reader);
    expect(e).toBe(`2026-08-17T00:00:00Z|ingest|${reader}`);
    const p = parseLineageEntry(e);
    expect(p).toEqual({ ts: "2026-08-17T00:00:00Z", op: "ingest", reader });
  });

  it("readersFromLineage dedupes the reader-part preserving first-seen order", () => {
    const r1 = "m1|x";
    const r2 = "m2|y";
    const lin = [
      encodeLineageEntry("t1", "ingest", r1),
      encodeLineageEntry("t2", "update", r2),
      encodeLineageEntry("t3", "revision", r1),
    ];
    expect(readersFromLineage(lin)).toEqual([r1, r2]);
  });

  it("unionLineage appends only entries not already present (op,reader unique), never reorders", () => {
    const a = [encodeLineageEntry("t1", "ingest", "r1")];
    const b = [encodeLineageEntry("t1", "ingest", "r1"), encodeLineageEntry("t2", "update", "r2")];
    expect(unionLineage(a, b)).toEqual([
      encodeLineageEntry("t1", "ingest", "r1"),
      encodeLineageEntry("t2", "update", "r2"),
    ]);
  });

  it("unionLineage dedup key is (op,reader), ignoring ts — a same-(op,reader) re-append is declined", () => {
    const a = [encodeLineageEntry("t1", "update", "r2")];
    const b = [encodeLineageEntry("t9", "update", "r2")];
    expect(unionLineage(a, b)).toEqual(a); // ts differs, (op,reader) same → declined
  });

  it("parseLineageEntry returns null for malformed input (fewer than 2 pipes / empty)", () => {
    expect(parseLineageEntry("garbage")).toBeNull();
    expect(parseLineageEntry("")).toBeNull();
  });

  it("parseLineageEntry handles entry where reader itself has pipes", () => {
    // The split must only split on the first two pipes
    const reader = "model@0.5|prompt=abc12345|retry=false";
    const entry = encodeLineageEntry("2026-01-01T00:00:00Z", "update", reader);
    const parsed = parseLineageEntry(entry);
    expect(parsed).not.toBeNull();
    expect(parsed!.reader).toBe(reader);
    expect(parsed!.op).toBe("update");
    expect(parsed!.ts).toBe("2026-01-01T00:00:00Z");
  });

  it("unionLineage preserves existing order, does not re-sort", () => {
    const a = [encodeLineageEntry("t3", "update", "r3"), encodeLineageEntry("t1", "ingest", "r1")];
    const b = [encodeLineageEntry("t2", "revision", "r2")];
    const result = unionLineage(a, b);
    expect(result).toEqual([
      encodeLineageEntry("t3", "update", "r3"),
      encodeLineageEntry("t1", "ingest", "r1"),
      encodeLineageEntry("t2", "revision", "r2"),
    ]);
  });

  it("unionLineage handles empty existing or empty incoming", () => {
    const a = [encodeLineageEntry("t1", "ingest", "r1")];
    expect(unionLineage([], a)).toEqual(a);
    expect(unionLineage(a, [])).toEqual(a);
  });

  it("readersFromLineage handles empty array", () => {
    expect(readersFromLineage([])).toEqual([]);
  });

  it("readersFromLineage filters malformed entries gracefully", () => {
    const valid = encodeLineageEntry("t1", "ingest", "r1");
    expect(readersFromLineage(["garbage", valid])).toEqual(["r1"]);
  });
});
