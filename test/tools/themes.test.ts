import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveAccess } from "../../src/access/rbac.js";
import { LOCAL_MINILM_DIM } from "../../src/search/providers/local-minilm.js";
import * as indexDb from "../../src/storage/index-db.js";
import { openIndexDb } from "../../src/storage/index-db.js";
import { vaultReindex } from "../../src/tools/search.js";
import { __resetThemesCache, vaultThemes } from "../../src/tools/themes.js";
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

  afterEach(() => {
    vi.restoreAllMocks();
    __resetThemesCache();
  });

  it("returns the expected output shape with themes sorted by documentCount desc", async () => {
    const result = await vaultThemes(vault, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v = result.value;
    expect(typeof v.totalDocuments).toBe("number");
    expect(typeof v.skippedDocuments).toBe("number");
    expect(typeof v.selectedK).toBe("number");
    expect(typeof v.droppedClusters).toBe("number");
    // themes.length can undershoot selectedK only by clamp or by dropped
    // (chunk-bearing, zero-membership) clusters — never silently.
    expect(v.themes.length + v.droppedClusters).toBeLessThanOrEqual(v.selectedK);
    expect(typeof v.clusteredAt).toBe("string");
    expect(Array.isArray(v.themes)).toBe(true);
    expect(v.themes.length).toBeGreaterThan(0);
    for (const theme of v.themes) {
      expect(typeof theme.id).toBe("number");
      expect(typeof theme.label).toBe("string");
      expect(typeof theme.documentCount).toBe("number");
      expect(typeof theme.primaryDocumentCount).toBe("number");
      // Coverage can never be below the partition: every primary member is
      // a member.
      expect(theme.documentCount).toBeGreaterThanOrEqual(theme.primaryDocumentCount);
      // coherence is null for single-chunk clusters (no pairs to average),
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
    // #58 semantics: primaryDocumentCount PARTITIONS the scoped docs (each
    // doc counted once, at its argmax theme); documentCount is COVERAGE, so
    // its sum meets or exceeds the total whenever cross-cutting docs exist.
    const primarySum = v.themes.reduce((acc, t) => acc + t.primaryDocumentCount, 0);
    expect(primarySum).toBe(v.totalDocuments);
    const coverageSum = v.themes.reduce((acc, t) => acc + t.documentCount, 0);
    expect(coverageSum).toBeGreaterThanOrEqual(v.totalDocuments);
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
    // The distributions are part of the deterministic surface too (#58).
    expect(a.value.docMemberships).toEqual(b.value.docMemberships);
  }, 60_000);

  it("honours an explicit k and reports it in selectedK", async () => {
    const result = await vaultThemes(vault, { k: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.selectedK).toBe(3);
    expect(result.value.themes.length).toBeLessThanOrEqual(3);
  }, 60_000);

  it("clamps k to the number of clusterable chunks (tiny vault)", async () => {
    // Clustering is chunk-level (#58), so an oversized k clamps to the
    // chunk count, not the doc count.
    const result = await vaultThemes(vault, { k: 9999 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalChunks).toBeGreaterThanOrEqual(result.value.totalDocuments);
    expect(result.value.selectedK).toBeLessThanOrEqual(result.value.totalChunks);
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
      for (const doc of [...theme.representativeDocs, ...theme.secondaryDocs]) {
        expect(doc.startsWith("_drafts/")).toBe(false);
        // Analyst cannot read moonshot collection (and _drafts).
        expect(doc.startsWith("moonshot/")).toBe(false);
      }
    }
    // The distributions surface is doc-path-keyed — same vantage rule.
    for (const path of Object.keys(result.value.docMemberships)) {
      expect(path.startsWith("_drafts/")).toBe(false);
      expect(path.startsWith("moonshot/")).toBe(false);
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

  // --- E3: load/compute-avoidance -----------------------------------------

  it("does not decode out-of-scope embeddings when a collection filter is given (E3)", async () => {
    // Establish the unscoped decode count as a baseline: an unfiltered call
    // must decode strictly more embeddings than a single-collection call,
    // because a scoped call must never load out-of-collection embeddings.
    __resetThemesCache();
    const decodeSpy = vi.spyOn(indexDb, "blobToEmbedding");

    const unfiltered = await vaultThemes(vault, {});
    expect(unfiltered.ok).toBe(true);
    const unfilteredDecodes = decodeSpy.mock.calls.length;
    expect(unfilteredDecodes).toBeGreaterThan(0);

    decodeSpy.mockClear();
    __resetThemesCache();
    const scoped = await vaultThemes(vault, { collection: "pricing" });
    expect(scoped.ok).toBe(true);
    const scopedDecodes = decodeSpy.mock.calls.length;

    // The scoped call loaded fewer embeddings than the whole-vault call —
    // proving out-of-scope embeddings were filtered in SQL, not after the load.
    expect(scopedDecodes).toBeGreaterThan(0);
    expect(scopedDecodes).toBeLessThan(unfilteredDecodes);
  }, 60_000);

  it("does not re-decode embeddings on a second call with an unchanged index (E3 cache)", async () => {
    __resetThemesCache();
    const decodeSpy = vi.spyOn(indexDb, "blobToEmbedding");

    const first = await vaultThemes(vault, {});
    expect(first.ok).toBe(true);
    const firstDecodes = decodeSpy.mock.calls.length;
    expect(firstDecodes).toBeGreaterThan(0);

    decodeSpy.mockClear();
    const second = await vaultThemes(vault, {});
    expect(second.ok).toBe(true);
    // A cache hit against the unchanged index must re-pool nothing.
    expect(decodeSpy.mock.calls.length).toBe(0);

    // ...and the cached result must be identical to the first call.
    if (!first.ok || !second.ok) return;
    expect(second.value.totalDocuments).toBe(first.value.totalDocuments);
    expect(second.value.selectedK).toBe(first.value.selectedK);
    expect(second.value.themes.map((t) => t.label)).toEqual(first.value.themes.map((t) => t.label));
    expect(second.value.themes.map((t) => t.documentCount)).toEqual(
      first.value.themes.map((t) => t.documentCount),
    );
  }, 60_000);

  it("invalidates the cache and re-pools after the index content changes (E3 cache)", async () => {
    // A separate vault so the mutation does not leak into the shared suite.
    const isolated = makeTempVault();
    try {
      const reindex = await vaultReindex(isolated);
      expect(reindex.ok).toBe(true);
      __resetThemesCache();

      const decodeSpy = vi.spyOn(indexDb, "blobToEmbedding");
      const first = await vaultThemes(isolated, {});
      expect(first.ok).toBe(true);
      expect(decodeSpy.mock.calls.length).toBeGreaterThan(0);

      // Mutate the index content: drop half the embeddings. The signature
      // must change and the next call must re-pool rather than serve stale
      // pooled vectors.
      const dbResult = openIndexDb(isolated, LOCAL_MINILM_DIM);
      expect(dbResult.ok).toBe(true);
      if (!dbResult.ok) return;
      const db = dbResult.value;
      db.exec("DELETE FROM embeddings;");
      db.close();

      decodeSpy.mockClear();
      const second = await vaultThemes(isolated, {});
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      // Every embedding was dropped, so every doc is now skipped and no
      // embeddings decode — but crucially the cache did NOT serve the stale
      // pre-deletion themes.
      expect(second.value.totalDocuments).toBe(0);
      expect(second.value.themes.length).toBe(0);
    } finally {
      cleanupVault(isolated);
    }
  }, 60_000);

  it("derives secondaryDocs and docMemberships consistently from the distributions (#58)", async () => {
    const result = await vaultThemes(vault, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v = result.value;
    const themeIds = new Set(v.themes.map((t) => t.id));

    // Every docMemberships entry is a cross-cutting doc: ≥ 2 memberships,
    // each referencing a real theme id, ordered weight-desc, weights in
    // (0, 1] and summing to at most 1 (sub-threshold slices are dropped).
    for (const [path, memberships] of Object.entries(v.docMemberships)) {
      expect(path.length).toBeGreaterThan(0);
      expect(memberships.length).toBeGreaterThanOrEqual(2);
      let sum = 0;
      for (let i = 0; i < memberships.length; i++) {
        const m = memberships[i];
        if (!m) continue;
        expect(themeIds.has(m.theme)).toBe(true);
        expect(m.weight).toBeGreaterThan(0);
        expect(m.weight).toBeLessThanOrEqual(1);
        sum += m.weight;
        if (i > 0)
          expect(m.weight).toBeLessThanOrEqual((memberships[i - 1] as { weight: number }).weight);
      }
      expect(sum).toBeLessThanOrEqual(1 + 1e-9);
    }

    for (const theme of v.themes) {
      expect(Array.isArray(theme.secondaryDocs)).toBe(true);
      // representativeDocs are the theme's RESIDENTS (primary members) —
      // always disjoint from secondaryDocs, the invariant v1 also held.
      const reps = new Set(theme.representativeDocs);
      for (const doc of theme.secondaryDocs) expect(reps.has(doc)).toBe(false);
      for (const doc of theme.representativeDocs) {
        // A representative that is cross-cutting must still be PRIMARY here.
        const m = v.docMemberships[doc];
        if (m) expect((m[0] as { theme: number }).theme).toBe(theme.id);
      }
      for (const doc of theme.secondaryDocs) {
        // A secondary is by construction a cross-cutting doc: it appears in
        // docMemberships, holds a membership in THIS theme, and its
        // top-weight (primary) theme is a different one.
        const memberships = v.docMemberships[doc];
        expect(memberships).toBeDefined();
        if (!memberships) continue;
        expect(memberships.some((m) => m.theme === theme.id)).toBe(true);
        expect((memberships[0] as { theme: number }).theme).not.toBe(theme.id);
      }
    }
  }, 60_000);
});
