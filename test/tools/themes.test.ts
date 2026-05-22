import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveAccess } from "../../src/access/rbac.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import { openIndexDb } from "../../src/storage/index-db.js";
import { vaultReindex } from "../../src/tools/search.js";
import { vaultThemes } from "../../src/tools/themes.js";
import { loadConfig } from "../../src/utils/config.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const SAMPLE = resolve("test/fixtures/sample-vault");

const sampleConfig = loadConfig(SAMPLE);
if (!sampleConfig.ok) throw sampleConfig.error;
const analyst = resolveAccess(sampleConfig.value, "human:a", "analyst");
const admin = resolveAccess(sampleConfig.value, "human:m", "admin");

describe("vault_themes", () => {
  let vault: string;

  beforeAll(async () => {
    vault = makeTempVault();
    const reindex = await vaultReindex(vault);
    if (!reindex.ok) throw reindex.error;
  }, 60_000);

  afterAll(() => {
    cleanupVault(vault);
  });

  it("returns the expected output shape with themes sorted by documentCount desc", async () => {
    const result = await vaultThemes(vault, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v = result.value;
    expect(typeof v.totalDocuments).toBe("number");
    expect(typeof v.skippedDocuments).toBe("number");
    expect(typeof v.selectedK).toBe("number");
    expect(typeof v.clusteredAt).toBe("string");
    expect(Array.isArray(v.themes)).toBe(true);
    expect(v.themes.length).toBeGreaterThan(0);
    for (const theme of v.themes) {
      expect(typeof theme.label).toBe("string");
      expect(typeof theme.documentCount).toBe("number");
      // coherence is null for single-doc clusters (no pairs to average),
      // otherwise a number in [-1, 1].
      if (theme.coherence !== null) {
        expect(typeof theme.coherence).toBe("number");
        expect(theme.coherence).toBeGreaterThanOrEqual(-1);
        expect(theme.coherence).toBeLessThanOrEqual(1);
      } else {
        expect(theme.documentCount).toBe(1);
      }
      expect(Array.isArray(theme.representativeDocs)).toBe(true);
      expect(Array.isArray(theme.secondaryDocs)).toBe(true);
      expect(Array.isArray(theme.relatedTags)).toBe(true);
    }
    // Sorted desc by documentCount.
    for (let i = 1; i < v.themes.length; i++) {
      const a = v.themes[i - 1];
      const b = v.themes[i];
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      if (!a || !b) continue;
      expect(a.documentCount).toBeGreaterThanOrEqual(b.documentCount);
    }
    // Reported total matches the sum of theme sizes.
    const summed = v.themes.reduce((acc, t) => acc + t.documentCount, 0);
    expect(summed).toBe(v.totalDocuments);
  }, 60_000);

  it("is deterministic for the same vault and seed", async () => {
    const a = await vaultThemes(vault, {});
    const b = await vaultThemes(vault, {});
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.value.selectedK).toBe(b.value.selectedK);
    expect(a.value.totalDocuments).toBe(b.value.totalDocuments);
    expect(a.value.skippedDocuments).toBe(b.value.skippedDocuments);
    expect(a.value.themes.length).toBe(b.value.themes.length);
    for (let i = 0; i < a.value.themes.length; i++) {
      const ta = a.value.themes[i];
      const tb = b.value.themes[i];
      expect(ta).toBeDefined();
      expect(tb).toBeDefined();
      if (!ta || !tb) continue;
      expect(ta.documentCount).toBe(tb.documentCount);
      expect(ta.label).toBe(tb.label);
      expect(ta.representativeDocs).toEqual(tb.representativeDocs);
      expect(ta.secondaryDocs).toEqual(tb.secondaryDocs);
      expect(ta.relatedTags).toEqual(tb.relatedTags);
      if (ta.coherence === null || tb.coherence === null) {
        expect(ta.coherence).toBe(tb.coherence);
      } else {
        expect(ta.coherence).toBeCloseTo(tb.coherence, 8);
      }
    }
  }, 60_000);

  it("honours an explicit k and reports it in selectedK", async () => {
    const result = await vaultThemes(vault, { k: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedK).toBe(3);
    expect(result.value.themes.length).toBeLessThanOrEqual(3);
  }, 60_000);

  it("clamps k to the number of clusterable documents (tiny vault)", async () => {
    // The sample vault only has 10 docs, so passing k=99 must clamp.
    const result = await vaultThemes(vault, { k: 99 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedK).toBeLessThanOrEqual(result.value.totalDocuments);
    expect(result.value.selectedK).toBeGreaterThan(0);
  }, 60_000);

  it("restricts clustering to a single collection when given collection filter", async () => {
    const result = await vaultThemes(vault, { collection: "pricing" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDocuments).toBeGreaterThan(0);
    // Every representativeDoc must live under pricing/.
    for (const theme of result.value.themes) {
      for (const doc of theme.representativeDocs) {
        expect(doc.startsWith("pricing/")).toBe(true);
      }
    }
  }, 60_000);

  it("restricts clustering to docs that have all the given tags", async () => {
    const result = await vaultThemes(vault, { tags: ["pricing"] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDocuments).toBeGreaterThan(0);
    // Sum across themes must not exceed the unfiltered totalDocuments.
    const unfiltered = await vaultThemes(vault, {});
    if (!unfiltered.ok) return;
    expect(result.value.totalDocuments).toBeLessThanOrEqual(unfiltered.value.totalDocuments);
  }, 60_000);

  it("returns zero docs when the filter tag matches nothing", async () => {
    // A no-op filter implementation would silently return every doc; this
    // test would fail if that ever regressed.
    const result = await vaultThemes(vault, {
      tags: ["definitely-not-a-real-tag-zzzz"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalDocuments).toBe(0);
    expect(result.value.themes.length).toBe(0);
  }, 60_000);

  it("respects RBAC: the analyst sees no moonshot/_drafts docs in any theme", async () => {
    const result = await vaultThemes(vault, {}, analyst);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const theme of result.value.themes) {
      for (const doc of theme.representativeDocs) {
        expect(doc.startsWith("_drafts/")).toBe(false);
        // Analyst cannot read moonshot collection (and _drafts).
        expect(doc.startsWith("moonshot/")).toBe(false);
      }
    }
    // Admin sees more docs than analyst (or equal in the unlikely zero-mismatch case).
    const adminResult = await vaultThemes(vault, {}, admin);
    if (!adminResult.ok) return;
    expect(adminResult.value.totalDocuments).toBeGreaterThanOrEqual(result.value.totalDocuments);
  }, 60_000);

  it("counts documents with no embedded chunks in skippedDocuments", async () => {
    // Use an isolated vault so we can mutate its index without affecting
    // other tests sharing the suite-level `vault`.
    const isolated = makeTempVault();
    try {
      const reindex = await vaultReindex(isolated);
      expect(reindex.ok).toBe(true);
      if (!reindex.ok) return;
      const indexedCount = reindex.value.documentCount;
      expect(indexedCount).toBeGreaterThan(0);

      // Strip every embeddings-table row so each indexed document loses its
      // (chunk → embedding) join. Every doc should then be `skipped`.
      const dbResult = openIndexDb(isolated, LOCAL_MINILM_DIM);
      expect(dbResult.ok).toBe(true);
      if (!dbResult.ok) return;
      const db = dbResult.value;
      db.exec("DELETE FROM embeddings;");
      db.close();

      const result = await vaultThemes(isolated, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.totalDocuments).toBe(0);
      // skippedDocuments must equal the indexed doc count — every doc lost
      // its embeddings and therefore every doc must be counted as skipped.
      expect(result.value.skippedDocuments).toBe(indexedCount);
      expect(result.value.themes.length).toBe(0);
    } finally {
      cleanupVault(isolated);
    }
  }, 60_000);

  it("rejects an invalid k argument", async () => {
    const negative = await vaultThemes(vault, { k: -1 });
    expect(negative.ok).toBe(false);
    const zero = await vaultThemes(vault, { k: 0 });
    expect(zero.ok).toBe(false);
    const notInt = await vaultThemes(vault, { k: 2.5 });
    expect(notInt.ok).toBe(false);
  });

  it("includes a secondaryDocs array on every theme", async () => {
    const result = await vaultThemes(vault, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const theme of result.value.themes) {
      expect(Array.isArray(theme.secondaryDocs)).toBe(true);
      // A doc that is a primary member of theme T cannot also be a
      // secondary member of T.
      const primarySet = new Set(theme.representativeDocs);
      for (const doc of theme.secondaryDocs) {
        expect(primarySet.has(doc)).toBe(false);
      }
    }
  }, 60_000);
});
