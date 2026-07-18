import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTension } from "../../src/curation/tension.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultReindex, vaultSearch } from "../../src/tools/search.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:test";

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Doc",
    domain: "accumulation",
    collection: "pricing",
    status: "draft",
    confidence: "medium",
    created: "2026-07-01",
    provenance: "direct",
    sources: [],
    superseded_by: null,
    ttl_days: null,
    tags: [],
    ...overrides,
  };
}

// The link neighborhood the assertions run against:
//   pricing/hub.md (canonical)     → links to linked.md and retired.md
//   pricing/linked.md              ← linked, healthy
//   pricing/retired.md (deprecated)← linked from a CANONICAL doc
//   pricing/xylotheque.md          ← nothing links here (orphan)
//   competitive-intel/secret-hub.md (canonical) → sole linker of
//   pricing/shadowed.md (deprecated)            ← hidden-vantage cases
describe("structural decay (#8)", () => {
  let vault: string;
  beforeAll(async () => {
    vault = makeTempVault();
    const docs: Array<{ path: string; body: string; fm: Record<string, unknown> }> = [
      {
        path: "pricing/linked.md",
        body: "# Linked\n\nA healthy note.\n",
        fm: { title: "Linked" },
      },
      {
        path: "pricing/retired.md",
        body: "# Retired\n\nSuperseded thinking.\n",
        fm: { title: "Retired", status: "deprecated" },
      },
      {
        path: "pricing/xylotheque.md",
        body: "# Xylotheque\n\nNobody links to the xylotheque inventory.\n",
        fm: { title: "Xylotheque" },
      },
      {
        path: "pricing/hub.md",
        body: "# Hub\n\nSee [linked](linked.md) and [retired](retired.md).\n",
        fm: { title: "Hub", status: "canonical", confidence: "high" },
      },
      {
        path: "pricing/shadowed.md",
        body: "# Shadowed\n\nDeprecated and only referenced from intel.\n",
        fm: { title: "Shadowed", status: "deprecated" },
      },
      {
        path: "competitive-intel/secret-hub.md",
        body: "# Secret Hub\n\nLeans on [shadowed](../pricing/shadowed.md).\n",
        fm: {
          title: "Secret Hub",
          collection: "competitive-intel",
          status: "canonical",
          confidence: "high",
        },
      },
    ];
    for (const d of docs) {
      const w = await vaultWrite(vault, {
        path: d.path,
        body: d.body,
        frontmatter: frontmatter(d.fm),
        agent: AGENT,
      });
      if (!w.ok) throw w.error;
    }
    const r = await vaultReindex(vault);
    if (!r.ok) throw r.error;
  }, 120_000);
  afterAll(() => {
    cleanupVault(vault);
  });

  it("flags an orphan on read; a linked healthy doc reports null", async () => {
    const orphan = await vaultRead(vault, "pricing/xylotheque.md");
    expect(orphan.ok).toBe(true);
    if (!orphan.ok) return;
    expect(orphan.value.structural?.orphan).toBe(true);
    expect(orphan.value.structural?.banner).toContain("links here");

    const linked = await vaultRead(vault, "pricing/linked.md");
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;
    expect(linked.value.structural).toBeNull();
  });

  it("flags deprecated-still-linked with the canonical linkers named", async () => {
    const retired = await vaultRead(vault, "pricing/retired.md");
    expect(retired.ok).toBe(true);
    if (!retired.ok) return;
    expect(retired.value.structural?.orphan).toBe(false);
    expect(retired.value.structural?.deprecated_still_linked?.canonical_linkers).toEqual([
      "pricing/hub.md",
    ]);
    expect(retired.value.structural?.banner).toContain("pricing/hub.md");
  });

  it("computes from the caller's vantage — hidden linkers neither count nor leak", async () => {
    // Unrestricted: shadowed.md is linked (by the intel hub) and
    // deprecated-still-linked names it.
    const full = await vaultRead(vault, "pricing/shadowed.md");
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.value.structural?.orphan).toBe(false);
    expect(full.value.structural?.deprecated_still_linked?.canonical_linkers).toEqual([
      "competitive-intel/secret-hub.md",
    ]);

    // pricing-only vantage: the sole linker is unreadable, so the doc IS an
    // orphan from here, and no field names or implies the hidden linker.
    const pricingOnly = {
      user: "human:narrow",
      roleName: "pricing-only",
      role: { read: ["pricing"], write: [], promote: false, ratify: false },
    };
    const gated = await vaultRead(vault, "pricing/shadowed.md", pricingOnly);
    expect(gated.ok).toBe(true);
    if (!gated.ok) return;
    expect(gated.value.structural?.orphan).toBe(true);
    expect(gated.value.structural?.deprecated_still_linked).toBeNull();
    expect(JSON.stringify(gated.value.structural)).not.toContain("secret-hub");
  });

  it("vault_read carries unresolved tensions inline, search-parity shape", async () => {
    const t = await addTension(vault, {
      title: "linked vs hub",
      kind: "factual",
      sourceA: "pricing/linked.md",
      sourceB: "pricing/hub.md",
      claimA: "the note stands alone",
      claimB: "the hub subsumes it",
      loggedBy: AGENT,
    });
    if (!t.ok) throw t.error;

    const read = await vaultRead(vault, "pricing/linked.md");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.contestedCount).toBe(1);
    expect(read.value.contested?.[0]?.counterpart).toBe("pricing/hub.md");
  });

  it("search hits carry coarse structural flags", async () => {
    const orphanHit = await vaultSearch(vault, {
      query: "xylotheque inventory",
      weights: { bm25: 1, vector: 0 },
    });
    expect(orphanHit.ok).toBe(true);
    if (!orphanHit.ok) return;
    const hit = orphanHit.value.hits.find((h) => h.path === "pricing/xylotheque.md");
    expect(hit?.orphan).toBe(true);
    expect(hit?.deprecatedStillLinked).toBeUndefined();

    const retiredHit = await vaultSearch(vault, {
      query: "retired superseded thinking",
      weights: { bm25: 1, vector: 0 },
    });
    expect(retiredHit.ok).toBe(true);
    if (!retiredHit.ok) return;
    const rh = retiredHit.value.hits.find((h) => h.path === "pricing/retired.md");
    expect(rh?.deprecatedStillLinked).toBe(true);
    expect(rh?.orphan).toBeUndefined();
  });

  it("a write refreshes the link graph — an orphan stops being one immediately", async () => {
    const w = await vaultWrite(vault, {
      path: "pricing/curator-note.md",
      body: "# Curator note\n\nCataloguing the [xylotheque](xylotheque.md).\n",
      frontmatter: frontmatter({ title: "Curator note" }),
      agent: AGENT,
    });
    if (!w.ok) throw w.error;

    const read = await vaultRead(vault, "pricing/xylotheque.md");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.structural).toBeNull(); // linked now, not deprecated
  }, 60_000);
});
