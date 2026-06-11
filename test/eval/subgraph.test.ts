import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

// A minimal single-collection vault: one indexed markdown doc (so the seed
// deterministically lands on it) that `describes` code files. The .ts files are
// not markdown and are never indexed as documents.
describe("sampleSubgraph — describes edges (#121)", () => {
  let vault: string;

  beforeEach(async () => {
    vault = mkdtempSync(join(tmpdir(), "daftari-desc-sg-"));
    mkdirSync(join(vault, "guide"));
    mkdirSync(join(vault, "src"));
    writeFileSync(join(vault, "src", "login.ts"), "export function login(token: string) {}\n");
    writeFileSync(
      join(vault, "guide", "auth.md"),
      `---
title: Auth Guide
domain: accumulation
collection: guide
status: canonical
confidence: high
created: 2026-06-10
updated: 2026-06-10
updated_by: agent:test
provenance: direct
describes:
  - src/login.ts
  - svc:external/missing.ts::validateCredentials
---
# Auth Guide

Documents the login flow.
`,
    );
    const reindex = await vaultReindex(vault);
    if (!reindex.ok) throw reindex.error;
  }, 60_000);

  afterEach(() => {
    cleanupVault(vault);
  });

  it("emits a describes edge and loads a vault-resident code file as a code node", async () => {
    const r = await sampleSubgraph(vault, "any-seed", { maxNodes: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // The seed lands on the only indexed doc.
    expect(r.value.seed_doc).toBe("guide/auth.md");

    // Both describes entries produce edges of kind "describes".
    const describesEdges = r.value.edges.filter((e) => e.kind === "describes");
    expect(describesEdges.map((e) => e.to).sort()).toEqual(
      ["src/login.ts", "svc:external/missing.ts::validateCredentials"].sort(),
    );

    // The in-vault target loaded as a CODE node, kept separate from doc nodes.
    expect(r.value.nodes.some((n) => n.path === "src/login.ts")).toBe(false);
    const codeNode = r.value.code_nodes.find((n) => n.path === "src/login.ts");
    expect(codeNode?.body).toContain("export function login");

    // The external target did not resolve in the vault — no code node for it.
    expect(r.value.code_nodes.some((n) => n.path.includes("external/missing.ts"))).toBe(false);
  });

  it("caps loaded code-node bodies while still recording every describes edge", async () => {
    // One doc describing more in-vault code files than the node cap. All edges
    // are recorded; only `maxNodes` code bodies are loaded (memory bound).
    const v = mkdtempSync(join(tmpdir(), "daftari-desc-cap-"));
    mkdirSync(join(v, "guide"));
    mkdirSync(join(v, "src"));
    for (const n of [1, 2, 3, 4]) {
      writeFileSync(join(v, "src", `m${n}.ts`), `export const m${n} = ${n};\n`);
    }
    writeFileSync(
      join(v, "guide", "many.md"),
      `---
title: Many
domain: accumulation
collection: guide
status: canonical
confidence: high
created: 2026-06-10
updated: 2026-06-10
updated_by: agent:test
provenance: direct
describes:
  - src/m1.ts
  - src/m2.ts
  - src/m3.ts
  - src/m4.ts
---
# Many
`,
    );
    const reindex = await vaultReindex(v);
    if (!reindex.ok) throw reindex.error;
    try {
      const r = await sampleSubgraph(v, "seed", { maxNodes: 2 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.edges.filter((e) => e.kind === "describes")).toHaveLength(4);
      expect(r.value.code_nodes.length).toBeLessThanOrEqual(2);
    } finally {
      cleanupVault(v);
    }
  }, 60_000);
});
