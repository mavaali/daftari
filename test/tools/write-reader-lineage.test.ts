// Task 2 (6mf.4 R2, R6, R7): land-time union of reader_lineage at the #113
// update-merge chokepoint in vaultWrite.
//
// Before this bead, propose explicitly supplied `readers`/`reader_*` fields,
// which the #113 merge let win over existing values — a clobber. The fix makes
// the merge field-aware for exactly `readers` and `reader_lineage`: it unions
// them at land time rather than overwriting.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeLineageEntry,
  readersFromLineage,
  unionLineage,
} from "../../src/distill/reader-fingerprint.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:test";
const READER_1 = "modelA@0.5|prompt=aaaaaaaa|retry=false";
const READER_2 = "modelB@0.3|prompt=bbbbbbbb|retry=false";
const LINEAGE_INGEST_R1 = encodeLineageEntry("2026-01-01T00:00:00Z", "ingest", READER_1);
const LINEAGE_UPDATE_R2 = encodeLineageEntry("2026-08-17T12:00:00Z", "update", READER_2);

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "A Distilled Note",
    domain: "accumulation",
    collection: "pricing",
    status: "canonical",
    confidence: "medium",
    created: "2026-01-01",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: 90,
    tags: ["note"],
    ...overrides,
  };
}

async function seedDoc(
  vault: string,
  path: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const written = await vaultWrite(vault, {
    path,
    body: "# A Note\n\nOriginal body.\n",
    frontmatter: frontmatter(extra),
    agent: "agent:seed",
  });
  if (!written.ok) throw written.error;
}

// Helper: assert readers[] == dedupe(reader-part of reader_lineage)
function assertReadersMatchLineage(raw: Record<string, unknown>): void {
  const lineage = Array.isArray(raw.reader_lineage) ? (raw.reader_lineage as string[]) : [];
  const expected = readersFromLineage(lineage);
  const actual = Array.isArray(raw.readers) ? (raw.readers as string[]) : [];
  expect(actual).toEqual(expected);
}

describe("vaultWrite — reader_lineage land-time union (6mf.4 R2)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("update-in-place unions readers and appends lineage (prior preserved)", async () => {
    // Seed v1 with reader_1 + ingest lineage
    await seedDoc(vault, "pricing/a.md", {
      readers: [READER_1],
      reader_lineage: [LINEAGE_INGEST_R1],
      reader_model: "modelA",
    });

    // Update with reader_2 + update lineage
    const updated = await vaultWrite(vault, {
      path: "pricing/a.md",
      body: "# A Note\n\nRevised body.\n",
      frontmatter: frontmatter({
        readers: [READER_2],
        reader_lineage: [LINEAGE_UPDATE_R2],
        reader_model: "modelB",
      }),
      agent: AGENT,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw updated.error;

    const doc = await vaultRead(vault, "pricing/a.md");
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;

    const raw = doc.value.raw;
    // readers must be the union (both preserved)
    expect(raw.readers).toEqual(expect.arrayContaining([READER_1, READER_2]));
    expect((raw.readers as string[]).length).toBe(2);

    // lineage must have both entries
    expect(raw.reader_lineage).toEqual(
      expect.arrayContaining([LINEAGE_INGEST_R1, LINEAGE_UPDATE_R2]),
    );
    expect((raw.reader_lineage as string[]).length).toBe(2);

    // 6mf.1 rule: >1 distinct reader ⇒ scalar reader_* dropped
    expect(raw.reader_model).toBeUndefined();

    // invariant: readers[] == dedupe(reader-part of reader_lineage)
    assertReadersMatchLineage(raw);
  });

  it("explicit reader_lineage:null / readers:null deletes the field (null-delete escape hatch)", async () => {
    await seedDoc(vault, "pricing/b.md", {
      readers: [READER_1],
      reader_lineage: [LINEAGE_INGEST_R1],
    });

    const updated = await vaultWrite(vault, {
      path: "pricing/b.md",
      body: "# A Note\n\nRevised.\n",
      frontmatter: frontmatter({
        reader_lineage: null,
        readers: null,
      }),
      agent: AGENT,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw updated.error;

    const doc = await vaultRead(vault, "pricing/b.md");
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;

    expect(doc.value.raw.reader_lineage).toBeUndefined();
    expect(doc.value.raw.readers).toBeUndefined();
  });

  it("non-array reader_lineage on disk → treated absent, write succeeds with fresh lineage", async () => {
    // Manually seed a doc with malformed reader_lineage (a plain string, not array)
    await seedDoc(vault, "pricing/c.md", {
      reader_lineage: "garbage-not-an-array",
      readers: [READER_1],
    });

    // Now update with a proper lineage entry
    const updated = await vaultWrite(vault, {
      path: "pricing/c.md",
      body: "# A Note\n\nRevised.\n",
      frontmatter: frontmatter({
        readers: [READER_2],
        reader_lineage: [LINEAGE_UPDATE_R2],
      }),
      agent: AGENT,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw updated.error;

    const doc = await vaultRead(vault, "pricing/c.md");
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;

    // Malformed on-disk treated as absent; the write goes through with the payload's lineage
    // BUT the readers from the existing doc are still unioned (readers was a valid array)
    const raw = doc.value.raw;
    expect(Array.isArray(raw.reader_lineage)).toBe(true);
    // The payload's lineage entry should be present
    expect(raw.reader_lineage).toEqual(expect.arrayContaining([LINEAGE_UPDATE_R2]));
  });

  it("re-landing the same lineage payload leaves readers+lineage unchanged (idempotent)", async () => {
    await seedDoc(vault, "pricing/d.md", {
      readers: [READER_1],
      reader_lineage: [LINEAGE_INGEST_R1],
    });

    // First update: different body so git commits; same lineage as seed.
    const r1 = await vaultWrite(vault, {
      path: "pricing/d.md",
      body: "# A Note\n\nRevised v1.\n",
      frontmatter: frontmatter({
        readers: [READER_1],
        reader_lineage: [LINEAGE_INGEST_R1],
      }),
      agent: AGENT,
    });
    expect(r1.ok).toBe(true);

    // Second update: different body again (forces a git commit); same lineage payload.
    // The lineage union should still be idempotent — no duplicate entries.
    const r2 = await vaultWrite(vault, {
      path: "pricing/d.md",
      body: "# A Note\n\nRevised v2.\n",
      frontmatter: frontmatter({
        readers: [READER_1],
        reader_lineage: [LINEAGE_INGEST_R1],
      }),
      agent: AGENT,
    });
    expect(r2.ok).toBe(true);

    const doc = await vaultRead(vault, "pricing/d.md");
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;

    const raw = doc.value.raw;
    // No duplicate entries — lineage union is idempotent on (op, reader)
    expect(raw.readers).toEqual([READER_1]);
    expect(raw.reader_lineage).toEqual([LINEAGE_INGEST_R1]);
    assertReadersMatchLineage(raw);
  });

  it("generic vault_write update with readers payload unions with existing (not clobber)", async () => {
    // Simulate a non-distill writer updating a doc that already has readers
    await seedDoc(vault, "pricing/e.md", {
      readers: [READER_1],
      reader_lineage: [LINEAGE_INGEST_R1],
    });

    // A generic update supplying a different readers entry
    const updated = await vaultWrite(vault, {
      path: "pricing/e.md",
      body: "# A Note\n\nBody.\n",
      frontmatter: frontmatter({
        readers: [READER_2],
      }),
      agent: AGENT,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw updated.error;

    const doc = await vaultRead(vault, "pricing/e.md");
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;

    const raw = doc.value.raw;
    // readers is union (not overwrite)
    expect(raw.readers).toEqual(expect.arrayContaining([READER_1, READER_2]));
    expect((raw.readers as string[]).length).toBe(2);
    // lineage preserved even if writer didn't supply one
    expect(raw.reader_lineage).toEqual(expect.arrayContaining([LINEAGE_INGEST_R1]));
  });

  it("verifies readers[] == dedupe(reader-part of lineage) across a round-trip", async () => {
    // This is a global invariant test
    const lineage = [LINEAGE_INGEST_R1, LINEAGE_UPDATE_R2];
    const expectedReaders = readersFromLineage(lineage);

    await seedDoc(vault, "pricing/f.md", {
      readers: [READER_1],
      reader_lineage: [LINEAGE_INGEST_R1],
    });

    await vaultWrite(vault, {
      path: "pricing/f.md",
      body: "# A Note\n\nRevised.\n",
      frontmatter: frontmatter({
        readers: [READER_2],
        reader_lineage: [LINEAGE_UPDATE_R2],
      }),
      agent: AGENT,
    });

    const doc = await vaultRead(vault, "pricing/f.md");
    expect(doc.ok).toBe(true);
    if (!doc.ok) return;

    const raw = doc.value.raw;
    // The unioned lineage should produce readers that match
    const actualLineage = Array.isArray(raw.reader_lineage) ? (raw.reader_lineage as string[]) : [];
    const computedReaders = readersFromLineage(actualLineage);
    const actualReaders = Array.isArray(raw.readers) ? (raw.readers as string[]) : [];
    expect(actualReaders).toEqual(computedReaders);
    expect(computedReaders).toEqual(expectedReaders);
  });
});
