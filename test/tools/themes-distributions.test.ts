// #58 acceptance: a synthetic "two-region" document lands in BOTH themes'
// membership lists. Driven with an injected fake provider whose vectors are
// content-determined (no model download) — unlike themes.test.ts, which
// exercises the same tool against real local-minilm embeddings.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ok } from "../../src/frontmatter/types.js";
import type { EmbeddingProvider } from "../../src/search/embedding-provider.js";
import { resetProviderForTests, setProviderForTests } from "../../src/search/vector.js";
import { vaultReindex } from "../../src/tools/search.js";
import { __resetThemesCache, vaultThemes } from "../../src/tools/themes.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const DIM = 4;

// Vectors are corners of the embedding space, chosen by marker token: every
// chunk mentioning alphapricing goes to one corner, betamoonshot to another,
// everything else to a third. Clustering is then exact and deterministic.
function markerProvider(): EmbeddingProvider {
  return {
    id: "fake-markers",
    dim: DIM,
    warm: async () => ok(undefined),
    embed: async (texts, onProgress) => {
      const out = texts.map((t) => {
        const vec = new Float32Array(DIM);
        if (t.includes("alphapricing")) vec[0] = 1;
        else if (t.includes("betamoonshot")) vec[1] = 1;
        else vec[2] = 1;
        return vec;
      });
      onProgress?.(texts.length, texts.length);
      return ok(out);
    },
  };
}

// A paragraph long enough (> 400 chars) that two of them cannot pack into
// one 800-char chunk — guaranteeing the two-region doc splits into (at
// least) one chunk per region.
function longParagraph(marker: string): string {
  return `The ${marker} topic sentence repeats for bulk. `.repeat(12);
}

function writeDoc(vault: string, relPath: string, title: string, body: string): void {
  const abs = join(vault, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(
    abs,
    `---
title: "${title}"
domain: accumulation
collection: pricing
status: draft
confidence: medium
created: 2026-05-01
updated: 2026-05-01
updated_by: agent:seed
provenance: direct
sources: []
superseded_by: null
ttl_days: 90
tags: [pricing]
---

${body}
`,
  );
}

describe("vault_themes per-doc distributions (#58, fake provider)", () => {
  let vault: string;

  beforeEach(() => {
    vault = makeTempVault();
    setProviderForTests(markerProvider());
    __resetThemesCache();
  });

  afterEach(() => {
    resetProviderForTests();
    __resetThemesCache();
    cleanupVault(vault);
  });

  it("a two-region doc is a member of both themes; pure docs are not", async () => {
    // Two pure docs anchor the two regions; the synthesis doc has one long
    // paragraph in each, so its two chunks split across the regions.
    writeDoc(vault, "pricing/pure-alpha.md", "Pure alpha", longParagraph("alphapricing"));
    writeDoc(vault, "pricing/pure-beta.md", "Pure beta", longParagraph("betamoonshot"));
    writeDoc(
      vault,
      "pricing/two-region.md",
      "Two region synthesis",
      `${longParagraph("alphapricing")}\n\n${longParagraph("betamoonshot")}`,
    );

    const reindex = await vaultReindex(vault);
    expect(reindex.ok).toBe(true);
    if (!reindex.ok) return;
    expect(reindex.value.vectorEnabled).toBe(true);

    // k=3: the alpha corner, the beta corner, and the everything-else corner
    // (the fixture vault's own docs all embed there).
    const result = await vaultThemes(vault, { k: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const v = result.value;

    // The two-region doc is the cross-cutting one: exactly two memberships,
    // an even split (one chunk in each region), reported in docMemberships.
    const memberships = v.docMemberships["pricing/two-region.md"];
    expect(memberships).toBeDefined();
    if (!memberships) return;
    expect(memberships).toHaveLength(2);
    for (const m of memberships) expect(m.weight).toBeCloseTo(0.5, 8);
    const [alphaTheme, betaTheme] = memberships.map((m) => m.theme);
    expect(alphaTheme).not.toBe(betaTheme);

    // Pure docs are single-theme: omitted from docMemberships entirely.
    expect(v.docMemberships["pricing/pure-alpha.md"]).toBeUndefined();
    expect(v.docMemberships["pricing/pure-beta.md"]).toBeUndefined();

    // Both region themes COUNT the two-region doc (coverage), and exactly
    // one of them holds it as primary... but an even 50/50 split breaks the
    // tie deterministically, so between them the doc adds exactly one
    // primary membership.
    const themesById = new Map(v.themes.map((t) => [t.id, t]));
    const alpha = themesById.get(alphaTheme as number);
    const beta = themesById.get(betaTheme as number);
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    if (!alpha || !beta) return;
    // Each region theme: one pure doc + the two-region doc = coverage 2.
    expect(alpha.documentCount).toBe(2);
    expect(beta.documentCount).toBe(2);
    expect(alpha.primaryDocumentCount + beta.primaryDocumentCount).toBe(3);
    // The two-region doc appears as a SECONDARY of whichever region theme
    // it is not primary in — and never as a representative of that theme
    // (representatives are residents; disjoint from secondaries).
    const secondaries = [...alpha.secondaryDocs, ...beta.secondaryDocs];
    expect(secondaries).toContain("pricing/two-region.md");
    for (const theme of [alpha, beta]) {
      for (const doc of theme.secondaryDocs) {
        expect(theme.representativeDocs).not.toContain(doc);
      }
    }

    // Partition invariant across ALL themes: primaries sum to the doc count.
    const primarySum = v.themes.reduce((acc, t) => acc + t.primaryDocumentCount, 0);
    expect(primarySum).toBe(v.totalDocuments);
  }, 60_000);
});
