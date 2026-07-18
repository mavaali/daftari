import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { mintConsumesEdges } from "../../src/curation/consumes.js";
import { recordProvenance } from "../../src/curation/provenance.js";
import { readReadLog, recordRead } from "../../src/curation/read-log.js";
import { addTension, tensionsPath } from "../../src/curation/tension.js";
import { clearContestedCache } from "../../src/search/contested.js";
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

  describe("contested annotations", () => {
    afterEach(() => {
      rmSync(tensionsPath(vault), { force: true });
      clearContestedCache();
    });

    it("annotates a hit involved in an unresolved tension", async () => {
      await addTension(vault, {
        title: "pricing feud",
        kind: "factual",
        sourceA: "pricing/helios-consumption-pricing.md",
        sourceB: "competitive-intel/vega-insight-positioning.md",
        claimA: "credits are consumption-priced",
        claimB: "Vega undercuts on flat pricing",
        loggedBy: "test",
      });
      const result = await vaultSearch(vault, {
        query: "Helios compute credit consumption pricing",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const hit = result.value.hits.find((h) => h.path === "pricing/helios-consumption-pricing.md");
      expect(hit?.contested?.[0]).toMatchObject({
        counterpart: "competitive-intel/vega-insight-positioning.md",
        claimSelf: "credits are consumption-priced",
        claimOther: "Vega undercuts on flat pricing",
        kind: "factual",
      });
      expect(hit?.contestedCount).toBe(1);
    });

    it("leaves hits untouched when no tensions exist (fields absent, not empty)", async () => {
      const result = await vaultSearch(vault, { query: "pricing" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hits.length).toBeGreaterThan(0);
      for (const hit of result.value.hits) {
        expect(hit.contested).toBeUndefined();
        expect(hit.contestedCount).toBeUndefined();
      }
    });

    it("omits the annotation when the caller cannot read the counterpart", async () => {
      await addTension(vault, {
        title: "pricing feud",
        kind: "factual",
        sourceA: "pricing/helios-consumption-pricing.md",
        sourceB: "competitive-intel/vega-insight-positioning.md",
        claimA: "credits are consumption-priced",
        claimB: "Vega undercuts on flat pricing",
        loggedBy: "test",
      });
      const access: AccessContext = {
        user: "t",
        roleName: "analyst",
        role: { read: ["pricing"], write: [], promote: false, ratify: false },
      };
      const result = await vaultSearch(
        vault,
        { query: "Helios compute credit consumption pricing" },
        access,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const hit = result.value.hits.find((h) => h.path === "pricing/helios-consumption-pricing.md");
      expect(hit).toBeDefined(); // the hit itself is readable
      expect(hit?.contested).toBeUndefined(); // the annotation is not
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
    // muon-c can't reach the top-2 on its own: its body is off-topic ("gardening...") so it
    // shares zero query terms and is semantically distant — it can only enter via coverage.
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

// Builds a bare vault where each note declares its own collection — needed to
// place restricted-collection docs in the top ranked slots for the RBAC
// over-fetch test. Distinct tags per note keep the coverage pass quiet so the
// hit count reflects only the ranked (RBAC-filtered) set.
function collectionVault(
  notes: { name: string; collection: string; tags: string[]; created: string; body: string }[],
): string {
  const dir = mkdtempSync(join(tmpdir(), "daftari-rbac-"));
  mkdirSync(join(dir, "notes"), { recursive: true });
  for (const n of notes) {
    writeFileSync(
      join(dir, "notes", n.name),
      `---\ntitle: ${n.name}\ncollection: ${n.collection}\ndomain: accumulation\nstatus: canonical\nconfidence: high\ncreated: ${n.created}\nupdated: ${n.created}\ntags: [${n.tags.join(", ")}]\n---\n\n${n.body}\n`,
    );
  }
  return dir;
}

function accessReading(...collections: string[]): AccessContext {
  return {
    user: "u",
    roleName: "r",
    role: { read: collections, write: [], promote: false, ratify: false },
  };
}

describe("vault_search RBAC over-fetch", () => {
  let vault: string;

  // Two restricted-collection docs match the query heavily (all three terms,
  // repeated) so they occupy the top-2 ranked slots; three public docs match
  // weakly (one term) and rank below the cut. With limit:2 a pre-slice-RBAC
  // filter would return zero permitted hits — the bug. Distinct tags keep the
  // coverage pass silent, so hit count == ranked permitted count.
  const HEAVY =
    "zephyr protocol calibration zephyr protocol calibration zephyr protocol calibration";
  const LIGHT = "zephyr overview note";
  beforeAll(async () => {
    vault = collectionVault([
      { name: "s1.md", collection: "secret", tags: ["t1"], created: "2026-03-01", body: HEAVY },
      { name: "s2.md", collection: "secret", tags: ["t2"], created: "2026-03-02", body: HEAVY },
      { name: "p1.md", collection: "public", tags: ["t3"], created: "2026-03-03", body: LIGHT },
      { name: "p2.md", collection: "public", tags: ["t4"], created: "2026-03-04", body: LIGHT },
      { name: "p3.md", collection: "public", tags: ["t5"], created: "2026-03-05", body: LIGHT },
    ]);
    const r = await vaultReindex(vault);
    if (!r.ok) throw r.error;
  }, 60_000);
  afterAll(() => cleanupVault(vault));

  it("returns a full page of permitted hits when restricted docs occupy the top slots", async () => {
    const res = await vaultSearch(
      vault,
      { query: "zephyr protocol calibration", limit: 2, weights: { bm25: 1, vector: 0 } },
      accessReading("public"),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The caller can read 3 public docs; with the restricted docs ranked on top,
    // it must still receive `limit` (2) permitted results, not fewer.
    expect(res.value.hits.length).toBe(2);
    expect(res.value.hits.every((h) => h.collection === "public")).toBe(true);
  });

  it("never leaks a restricted-collection doc into the results", async () => {
    const res = await vaultSearch(
      vault,
      { query: "zephyr protocol calibration", limit: 5, weights: { bm25: 1, vector: 0 } },
      accessReading("public"),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hits.some((h) => h.collection === "secret")).toBe(false);
  });

  it("still caps a wildcard reader at the user-facing limit", async () => {
    // Over-fetch must not leak past the slice: a reader who CAN see everything
    // still gets exactly `limit` ranked hits, not the whole over-fetched set.
    const res = await vaultSearch(
      vault,
      { query: "zephyr protocol calibration", limit: 2, weights: { bm25: 1, vector: 0 } },
      accessReading("*"),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hits.filter((h) => !h.viaCoverage).length).toBe(2);
  });
});

describe("vault_search_related RBAC over-fetch", () => {
  let vault: string;

  const HEAVY =
    "zephyr protocol calibration zephyr protocol calibration zephyr protocol calibration";
  const LIGHT = "zephyr overview note";
  beforeAll(async () => {
    vault = collectionVault([
      { name: "src.md", collection: "public", tags: ["t0"], created: "2026-03-01", body: HEAVY },
      { name: "s1.md", collection: "secret", tags: ["t1"], created: "2026-03-02", body: HEAVY },
      { name: "s2.md", collection: "secret", tags: ["t2"], created: "2026-03-03", body: HEAVY },
      { name: "p1.md", collection: "public", tags: ["t3"], created: "2026-03-04", body: LIGHT },
      { name: "p2.md", collection: "public", tags: ["t5"], created: "2026-03-05", body: LIGHT },
    ]);
    const r = await vaultReindex(vault);
    if (!r.ok) throw r.error;
  }, 60_000);
  afterAll(() => cleanupVault(vault));

  it("returns a full page of permitted related hits when restricted docs rank on top", async () => {
    const res = await vaultSearchRelated(
      vault,
      { path: "notes/src.md", limit: 2, weights: { bm25: 1, vector: 0 } },
      accessReading("public"),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.hits.length).toBe(2);
    expect(res.value.hits.every((h) => h.collection === "public")).toBe(true);
  });
});

describe("upstream staleness annotations (#234)", () => {
  let vault: string;

  // A compiled edge from a pricing doc to a competitive-intel unit, minted
  // through the real producer (read-log join), then a breaking change to the
  // unit — the pricing hit now has one pending-broken upstream outside a
  // pricing-only caller's read scope.
  beforeAll(async () => {
    vault = makeTempVault();
    const r = await vaultReindex(vault);
    if (!r.ok) throw r.error;
    const read = await recordRead(vault, {
      tool: "vault_read",
      file: "competitive-intel/vega-insight-positioning.md",
      run_id: "run-stale",
    });
    if (!read.ok) throw read.error;
    // Explicit past compile_ts: the breaking provenance entry below is
    // stamped "now", which must be STRICTLY later than the baseline — a
    // same-millisecond pair would classify the edge as current.
    const minted = await mintConsumesEdges(vault, {
      artifact: "pricing/helios-consumption-pricing.md",
      runId: "run-stale",
      timestamp: "2026-01-01T00:00:00.000Z",
    });
    if (!minted.ok) throw minted.error;
    const changed = await recordProvenance(vault, {
      tool: "vault_write",
      file: "competitive-intel/vega-insight-positioning.md",
      agent: "agent:test",
      action: "update",
      body_changed: true,
    });
    if (!changed.ok) throw changed.error;
  }, 60_000);
  afterAll(() => cleanupVault(vault));

  it("an unrestricted caller sees the broken bucket on the hit", async () => {
    const result = await vaultSearch(vault, {
      query: "Helios compute credit consumption pricing",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hit = result.value.hits.find((h) => h.path === "pricing/helios-consumption-pricing.md");
    expect(hit?.pendingBrokenUpstream).toBe("some");
    expect(hit?.hiddenPendingUpstream).toBeUndefined();
  });

  it("vault_search_related serves are instrumented too — same helper, own tool tag", async () => {
    const related = await vaultSearchRelated(vault, {
      path: "pricing/serverless-cost-predictability.md",
    });
    expect(related.ok).toBe(true);
    if (!related.ok) return;
    expect(related.value.hits.length).toBeGreaterThan(0);

    const log = await readReadLog(vault);
    if (!log.ok) throw log.error;
    const served = log.value.filter((e) => e.tool === "vault_search_related");
    // Every served related hit is one instrumented read-log entry.
    for (const hit of related.value.hits) {
      const entry = served.find((e) => e.file === hit.path);
      expect(entry).toBeDefined();
      expect(entry?.broken_upstream).toBeTypeOf("number");
    }
    // The broken doc carries its annotation through the related surface when served.
    const heliosHit = related.value.hits.find(
      (h) => h.path === "pricing/helios-consumption-pricing.md",
    );
    if (heliosHit) expect(heliosHit.pendingBrokenUpstream).toBe("some");
  });

  it("never derives the broken (incident) bucket from units outside the caller's scope", async () => {
    // Security review on #253: the incident classification must follow
    // vault_read's visible/hidden split — a pricing-only caller learns only
    // that SOME hidden upstream has pending changes, never that it broke.
    const pricingOnly: AccessContext = {
      user: "human:narrow",
      roleName: "pricing-only",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };
    const result = await vaultSearch(
      vault,
      { query: "Helios compute credit consumption pricing" },
      pricingOnly,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hit = result.value.hits.find((h) => h.path === "pricing/helios-consumption-pricing.md");
    expect(hit).toBeDefined();
    expect(hit?.pendingBrokenUpstream).toBeUndefined();
    expect(hit?.hiddenPendingUpstream).toBe("some");
  });
});
