import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listStagedActions } from "../../src/curation/staged-actions.js";
import type { ClaimRunMeta, ExtractedClaim } from "../../src/distill/extract.js";
import { proposeAllClaims } from "../../src/distill/propose.js";
import {
  encodeLineageEntry,
  parseLineageEntry,
  readersFromLineage,
  unionLineage,
} from "../../src/distill/reader-fingerprint.js";
import { requireDefined } from "../../src/test-utils/require-defined.js";

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
    expect(requireDefined(parsed).reader).toBe(reader);
    expect(requireDefined(parsed).op).toBe("update");
    expect(requireDefined(parsed).ts).toBe("2026-01-01T00:00:00Z");
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

// ---------------------------------------------------------------------------
// Task 3: Distill stamps ingest vs update op (R1)
// ---------------------------------------------------------------------------

function makeClaim(overrides: Partial<ExtractedClaim> = {}): ExtractedClaim {
  return {
    claim_key: "chunk-001:some-statement-a1b2c3d4",
    statement: "Some statement.",
    proposed_frontmatter: { title: "Some statement." },
    ...overrides,
  };
}

function makeRunMeta(overrides: Partial<ClaimRunMeta> = {}): ClaimRunMeta {
  return {
    requestedModel: "claude-opus-4",
    servedModel: "claude-opus-4-20260101",
    effectiveTemperature: 0,
    viaRetry: false,
    chunkWindow: 12,
    inputCap: 8000,
    ...overrides,
  };
}

describe("proposeAllClaims — lineage op stamp (6mf.4 Task 3)", () => {
  let vault: string;
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-lineage-op-"));
  });
  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("a new claim (no pathOverrides) produces reader_lineage with op=ingest", async () => {
    const claim = makeClaim({ run_meta: makeRunMeta() });
    await proposeAllClaims(vault, [claim], { sourceId: "src-1", runId: "run-1" });

    const listed = await listStagedActions(vault, "pending");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);

    const diff = requireDefined(listed.value[0]).proposedDiff as Record<string, unknown>;
    const fm = diff.frontmatter as Record<string, unknown>;

    expect(Array.isArray(fm.reader_lineage)).toBe(true);
    const lineage = fm.reader_lineage as string[];
    expect(lineage).toHaveLength(1);
    const parsed = parseLineageEntry(requireDefined(lineage[0]));
    expect(parsed).not.toBeNull();
    expect(requireDefined(parsed).op).toBe("ingest");
  });

  it("an update claim (pathOverrides has the claim_key) produces reader_lineage with op=update", async () => {
    const claim = makeClaim({ run_meta: makeRunMeta() });
    const pathOverrides: Record<string, string> = {
      [claim.claim_key]: "accumulation/distilled/some-existing.md",
    };
    await proposeAllClaims(vault, [claim], { sourceId: "src-1", runId: "run-2" }, pathOverrides);

    const listed = await listStagedActions(vault, "pending");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);

    const diff = requireDefined(listed.value[0]).proposedDiff as Record<string, unknown>;
    const fm = diff.frontmatter as Record<string, unknown>;

    expect(Array.isArray(fm.reader_lineage)).toBe(true);
    const lineage = fm.reader_lineage as string[];
    expect(lineage).toHaveLength(1);
    const parsed = parseLineageEntry(requireDefined(lineage[0]));
    expect(parsed).not.toBeNull();
    expect(requireDefined(parsed).op).toBe("update");
  });

  it("a claim with no run_meta does not produce reader_lineage", async () => {
    const claim = makeClaim(); // no run_meta
    await proposeAllClaims(vault, [claim], { sourceId: "src-1", runId: "run-3" });

    const listed = await listStagedActions(vault, "pending");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.value).toHaveLength(1);

    const diff = requireDefined(listed.value[0]).proposedDiff as Record<string, unknown>;
    const fm = diff.frontmatter as Record<string, unknown>;

    expect(fm.reader_lineage).toBeUndefined();
  });
});
