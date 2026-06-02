import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleSubgraph } from "../../src/eval/subgraph.js";
import { vaultReindex } from "../../src/tools/search.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

// The checked-in fixture index.db is intentionally stale (skipped by
// makeTempVault). Like the other index-backed suites (e.g. themes.test.ts) we
// build a fresh index in an isolated temp copy of the sample vault so
// `openIndexForActiveProvider` sees real documents.
describe("sampleSubgraph", () => {
  let vault: string;

  beforeAll(async () => {
    vault = makeTempVault();
    const reindex = await vaultReindex(vault);
    if (!reindex.ok) throw reindex.error;
  }, 60_000);

  afterAll(() => {
    cleanupVault(vault);
  });

  it("returns the same subgraph for the same seed + vault", async () => {
    const seed = "deterministic-test-seed-1";
    const a = await sampleSubgraph(vault, seed, { maxNodes: 5 });
    const b = await sampleSubgraph(vault, seed, { maxNodes: 5 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value.nodes.map((n) => n.path).sort()).toEqual(
        b.value.nodes.map((n) => n.path).sort(),
      );
    }
  });

  it("respects maxNodes cap", async () => {
    const r = await sampleSubgraph(vault, "seed-2", { maxNodes: 3 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.nodes.length).toBeLessThanOrEqual(3);
  });

  it("returns at least the seed doc", async () => {
    const r = await sampleSubgraph(vault, "seed-3", { maxNodes: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.nodes.length).toBeGreaterThanOrEqual(1);
  });

  it("walks frontmatter sources edges", async () => {
    // Pre-knowledge of the sample-vault fixture: if any doc has a `sources:`
    // entry pointing to another in-vault doc, the subgraph should include both
    // when one is the seed. Asserted softly: edges of kind 'sources' exist
    // somewhere in the returned subgraph for at least one of three seeds.
    const seeds = ["seed-a", "seed-b", "seed-c"];
    const landedOn: string[] = [];
    let sawSourcesEdge = false;
    for (const seed of seeds) {
      const r = await sampleSubgraph(vault, seed, { maxNodes: 5 });
      if (!r.ok) continue;
      landedOn.push(r.value.seed_doc);
      if (r.value.edges.some((e) => e.kind === "sources")) {
        sawSourcesEdge = true;
        break;
      }
    }
    // If this fails, the message disambiguates a broken walker from seed drift:
    // check whether `landedOn` includes any source-bearing doc before assuming
    // the walker regressed.
    expect(
      sawSourcesEdge,
      `no 'sources' edge across seeds [${seeds.join(", ")}]; seed docs landed on: [${landedOn.join(", ")}]`,
    ).toBe(true);
  });

  it("walks superseded_by revision edges and includes both endpoints as nodes", async () => {
    // The fixture's one supersede edge: pricing/cirrus-capacity-tiers.md is
    // superseded_by pricing/cirrus-capacity-tiers-2026.md. The edge is walked
    // bidirectionally, so a seed landing on either cirrus doc reaches the other.
    const OLD = "pricing/cirrus-capacity-tiers.md";
    const NEW = "pricing/cirrus-capacity-tiers-2026.md";
    // A spread of seeds; several land on a cirrus doc (e.g. "s0", "s6", "s7").
    // The bidirectional edge means any seed landing on either cirrus doc
    // connects both endpoints into the returned subgraph.
    const seeds = ["s0", "s6", "s7", "s9", "s13", "seed-a", "seed-b", "seed-c"];
    const landedOn: string[] = [];
    let connected = false;
    for (const seed of seeds) {
      const r = await sampleSubgraph(vault, seed, { maxNodes: 5 });
      if (!r.ok) continue;
      landedOn.push(r.value.seed_doc);
      const hasEdge = r.value.edges.some((e) => e.kind === "superseded");
      const paths = new Set(r.value.nodes.map((n) => n.path));
      if (hasEdge && paths.has(OLD) && paths.has(NEW)) {
        connected = true;
        break;
      }
    }
    // On failure, `landedOn` shows where the seeds resolved: if none is a cirrus
    // doc this is seed drift (widen the list), not a walker regression.
    expect(
      connected,
      `no superseded edge connecting both cirrus docs across seeds [${seeds.join(", ")}]; seed docs landed on: [${landedOn.join(", ")}]`,
    ).toBe(true);
  });
});
