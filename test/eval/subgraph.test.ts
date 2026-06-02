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
    let sawSourcesEdge = false;
    for (const seed of seeds) {
      const r = await sampleSubgraph(vault, seed, { maxNodes: 5 });
      if (r.ok && r.value.edges.some((e) => e.kind === "sources")) {
        sawSourcesEdge = true;
        break;
      }
    }
    expect(sawSourcesEdge).toBe(true);
  });
});
