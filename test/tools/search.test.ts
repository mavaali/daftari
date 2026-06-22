import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vaultReindex, vaultSearch, vaultSearchRelated } from "../../src/tools/search.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const INSIGHT_DOC = "competitive-intel/vega-insight-positioning.md";

describe("search tools", () => {
  let vault: string;

  // Build the index once up front so individual search tests don't pay the
  // embedding cost inside a default-timeout test.
  beforeAll(async () => {
    vault = makeTempVault();
    const result = await vaultReindex(vault);
    if (!result.ok) throw result.error;
  }, 60_000);

  afterAll(() => {
    cleanupVault(vault);
  });

  describe("vault_reindex", () => {
    it("rebuilds the index and reports counts", async () => {
      const result = await vaultReindex(vault);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.documentCount).toBe(10);
      expect(result.value.vault).toBe(vault);
    });
  });

  describe("vault_search", () => {
    it("returns ranked hits for a query", async () => {
      const result = await vaultSearch(vault, {
        query: "Helios compute credit consumption pricing",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.length).toBeGreaterThan(0);
      expect(result.value.hits[0]?.path).toBe("pricing/helios-consumption-pricing.md");
    });

    it("rejects a missing or empty query", async () => {
      const empty = await vaultSearch(vault, { query: "  " });
      expect(empty.ok).toBe(false);
      const missing = await vaultSearch(vault, {});
      expect(missing.ok).toBe(false);
    });

    it("honors a custom limit", async () => {
      const result = await vaultSearch(vault, { query: "pricing", limit: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.length).toBeLessThanOrEqual(1);
    });

    it("accepts custom ranking weights", async () => {
      const result = await vaultSearch(vault, {
        query: "cirrus capacity",
        weights: { bm25: 1, vector: 0 },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.weights).toEqual({ bm25: 1, vector: 0 });
    });

    it("every hit carries a decay field that is null or an object", async () => {
      const result = await vaultSearch(vault, { query: "pricing" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.length).toBeGreaterThan(0);
      for (const hit of result.value.hits) {
        expect(Object.hasOwn(hit, "decay")).toBe(true);
        expect(hit.decay === null || typeof hit.decay === "object").toBe(true);
      }
    });
  });

  describe("vault_search_related", () => {
    it("returns related documents for a valid path", async () => {
      const result = await vaultSearchRelated(vault, { path: INSIGHT_DOC });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.length).toBeGreaterThan(0);
      expect(result.value.hits.map((h) => h.path)).not.toContain(INSIGHT_DOC);
    });

    it("rejects a missing or empty path", async () => {
      const result = await vaultSearchRelated(vault, { path: "" });
      expect(result.ok).toBe(false);
    });

    it("errors for a path that is not in the vault", async () => {
      const result = await vaultSearchRelated(vault, {
        path: "pricing/ghost.md",
      });
      expect(result.ok).toBe(false);
    });
  });
});

describe("vault_search current-source enrichment", () => {
  let vault: string;

  const NEW_DOC = `---
title: "SP-A New Widget Pricing"
domain: accumulation
collection: pricing
status: canonical
confidence: high
created: 2026-01-20
updated: 2026-05-10
updated_by: human:test
provenance: direct
sources:
  - sp-a-test-source
superseded_by: null
ttl_days: 45
tags: [spa, widget]
---

# SP-A New Widget Pricing

The zylophone widget now costs 999 credits per cycle.
`;

  const OLD_DOC = `---
title: "SP-A Old Widget Pricing"
domain: accumulation
collection: pricing
status: superseded
confidence: high
created: 2026-01-20
updated: 2026-05-10
updated_by: human:test
provenance: direct
sources:
  - sp-a-test-source
superseded_by: pricing/sp-a-new.md
ttl_days: 45
tags: [spa, widget]
---

# SP-A Old Widget Pricing

The zylophone widget used to cost 500 credits per cycle.
`;

  // A *deprecated* doc that also carries a successor (vault_deprecate sets
  // status "deprecated" with an optional superseded_by). Enrichment must key on
  // the pointer, not status, so this resolves too — guards against a future
  // status-gated optimization silently dropping deprecated-with-successor hits.
  const DEPRECATED_DOC = `---
title: "SP-A Deprecated Widget Pricing"
domain: accumulation
collection: pricing
status: deprecated
confidence: high
created: 2026-01-20
updated: 2026-05-10
updated_by: human:test
provenance: direct
sources:
  - sp-a-test-source
superseded_by: pricing/sp-a-new.md
ttl_days: 45
tags: [spa, widget]
---

# SP-A Deprecated Widget Pricing

The zylophone widget pricing here is retired.
`;

  beforeAll(async () => {
    vault = makeTempVault();
    writeFileSync(join(vault, "pricing", "sp-a-new.md"), NEW_DOC);
    writeFileSync(join(vault, "pricing", "sp-a-old.md"), OLD_DOC);
    writeFileSync(join(vault, "pricing", "sp-a-deprecated.md"), DEPRECATED_DOC);
    const r = await vaultReindex(vault);
    if (!r.ok) throw r.error;
  }, 60_000);

  afterAll(() => cleanupVault(vault));

  it("attaches currentSource.resolved to a superseded hit", async () => {
    const res = await vaultSearch(vault, { query: "zylophone widget credits" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const stale = res.value.hits.find((h) => h.path === "pricing/sp-a-old.md");
    expect(stale).toBeDefined();
    expect(stale?.currentSource).toMatchObject({ kind: "resolved", path: "pricing/sp-a-new.md" });
  });

  it("does not attach currentSource to non-superseded hits", async () => {
    const res = await vaultSearch(vault, { query: "zylophone widget credits" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const fresh = res.value.hits.find((h) => h.path === "pricing/sp-a-new.md");
    expect(fresh?.currentSource).toBeUndefined();
  });

  it("enriches a deprecated-with-successor hit (keys on the pointer, not status)", async () => {
    const res = await vaultSearch(vault, { query: "zylophone widget retired" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const dep = res.value.hits.find((h) => h.path === "pricing/sp-a-deprecated.md");
    expect(dep).toBeDefined();
    expect(dep?.status).toBe("deprecated");
    expect(dep?.currentSource).toMatchObject({ kind: "resolved", path: "pricing/sp-a-new.md" });
  });

  it("does not re-order results and only enriches retired docs that carry a successor", async () => {
    // The Helios query's top hit is the canonical Helios doc; ranking is
    // unchanged by enrichment. Any currentSource that does appear must belong to
    // a retired doc that points at a successor — never a healthy one. The vault
    // holds two such docs the Helios query retrieves: the fixture's superseded
    // cirrus doc and this block's deprecated-with-successor sp-a doc.
    const res = await vaultSearch(vault, { query: "Helios compute credit consumption pricing" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Ordering: the canonical Helios doc still ranks first and is not enriched.
    expect(res.value.hits[0]?.path).toBe("pricing/helios-consumption-pricing.md");
    expect(res.value.hits[0]?.currentSource).toBeUndefined();

    // Enrichment lands only on retired (superseded|deprecated) docs that carry a
    // successor, never on canonical/draft ones — keyed on the pointer, not status.
    const enriched = res.value.hits.filter((h) => h.currentSource !== undefined);
    for (const h of enriched) {
      expect(["superseded", "deprecated"]).toContain(h.status);
      expect(h.currentSource).toMatchObject({ kind: "resolved" });
    }
  });

  it("preserves rank order: hits stay sorted by descending score after enrichment", async () => {
    const res = await vaultSearch(vault, { query: "zylophone widget credits" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const paths = res.value.hits.map((h) => h.path);
    const sortedByScore = [...res.value.hits].sort((a, b) => b.score - a.score).map((h) => h.path);
    expect(paths).toEqual(sortedByScore);
    // and at least one hit WAS enriched in this query, so the assertion is non-vacuous
    expect(res.value.hits.some((h) => h.currentSource !== undefined)).toBe(true);
  });
});

// Builds a bare (non-sample) vault with only the given notes. reindex does not
// require a git repo (makeTempVault strips .git for the same reason).
function bareVault(
  notes: { name: string; tags: string[]; created: string; body: string }[],
): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-cov-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  for (const n of notes) {
    writeFileSync(
      join(dir, "notes", n.name),
      `---\ntitle: ${n.name}\ncollection: notes\ndomain: accumulation\nstatus: canonical\nconfidence: high\ncreated: ${n.created}\nupdated: ${n.created}\ntags: [${n.tags.join(", ")}]\n---\n\n${n.body}\n`,
    );
  }
  return dir;
}

describe("vault_search coverage pass", () => {
  let posVault: string; // muon-a/b match the query; muon-c shares the tag but not the terms
  let quietVault: string; // three docs, all-distinct tags → no >=2-seed pair
  beforeAll(async () => {
    posVault = bareVault([
      {
        name: "muon-a.md",
        tags: ["muon"],
        created: "2026-03-10",
        body: "muon spectral scaling laws result one",
      },
      {
        name: "muon-b.md",
        tags: ["muon"],
        created: "2026-03-12",
        body: "muon spectral scaling laws result two",
      },
      {
        name: "muon-c.md",
        tags: ["muon"],
        created: "2026-03-11",
        body: "gardening notes about tomatoes and soil",
      },
    ]);
    quietVault = bareVault([
      {
        name: "x.md",
        tags: ["alpha"],
        created: "2026-03-10",
        body: "research note about alpha topic",
      },
      {
        name: "y.md",
        tags: ["beta"],
        created: "2026-03-11",
        body: "research note about beta topic",
      },
      {
        name: "z.md",
        tags: ["gamma"],
        created: "2026-03-12",
        body: "research note about gamma topic",
      },
    ]);
    const r1 = await vaultReindex(posVault);
    if (!r1.ok) throw r1.error;
    const r2 = await vaultReindex(quietVault);
    if (!r2.ok) throw r2.error;
  }, 60_000);
  afterAll(() => {
    cleanupVault(posVault);
    cleanupVault(quietVault);
  });

  it("adds the same-tag in-window doc that ranking missed, flagged viaCoverage", async () => {
    // limit:2 → ranked = [muon-a, muon-b]; muon-c (same tag, in window) is added by coverage.
    const res = await vaultSearch(posVault, { query: "muon spectral scaling laws", limit: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const added = res.value.hits.find((h) => h.path === "notes/muon-c.md");
    expect(added).toBeDefined();
    expect(added?.viaCoverage).toBe(true);
    expect(added?.coverageReason).toBe("entity-window");
  });

  it("stays quiet when the top seeds share no tag (no >=2-seed pair)", async () => {
    const res = await vaultSearch(quietVault, { query: "research note topic" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hits.some((h) => h.viaCoverage)).toBe(false);
  });
});
