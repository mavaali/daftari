import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vaultAssert, vaultConsolidate } from "../../src/tools/positions.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const UPSTREAM = "pricing/metric.md";
const UPSTREAM_B = "pricing/metric-b.md";
const CONSUMER = "pricing/artifact.md";

const CAROL_RATIFIER = {
  user: "carol",
  roleName: "ratifier",
  role: { read: ["*"], write: ["*"], promote: false, ratify: true },
};
const PRICING_READER = {
  user: "reader",
  roleName: "reader",
  role: { read: ["pricing"], write: [], promote: false, ratify: false },
};

function frontmatter(overrides: Record<string, unknown> = {}) {
  return {
    title: "Metric",
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

async function seedUnit(vault: string, path: string, title: string): Promise<void> {
  const w = await vaultWrite(vault, {
    path,
    body: `# ${title}\n\nvalue: 40\n`,
    frontmatter: frontmatter({ title }),
    agent: "agent:compiler",
  });
  if (!w.ok) throw w.error;
}

// Compiled-edge recipe (test/tools/edge-staleness.test.ts:32-57): read the
// upstream under a run_id, then write the consumer under the same run_id.
async function compileEdge(vault: string, upstream: string, consumer: string): Promise<void> {
  await vaultRead(vault, upstream, undefined, "run-1");
  const w = await vaultWrite(vault, {
    path: consumer,
    body: `# Artifact\n\nBuilt from ${upstream}.\n`,
    frontmatter: frontmatter({ title: "Artifact", provenance: "synthesized" }),
    agent: "agent:compiler",
    run_id: "run-1",
  });
  if (!w.ok) throw w.error;
}

async function contestUnit(vault: string, path: string): Promise<void> {
  const a = await vaultAssert(vault, {
    path,
    stance: "assert",
    confidence: "high",
    agent: "a",
    principal: "alice",
  });
  if (!a.ok) throw a.error;
  const b = await vaultAssert(vault, {
    path,
    stance: "dispute",
    confidence: "medium",
    agent: "b",
    principal: "bob",
  });
  if (!b.ok) throw b.error;
}

describe("vault_read contested_inputs (U-11)", () => {
  let vault: string;
  beforeEach(async () => {
    vault = makeTempVault();
  });
  afterEach(() => cleanupVault(vault));

  it("happy path: compiled input contested-unratified -> contested_inputs; consumer frontmatter untouched on disk (mandated)", async () => {
    await seedUnit(vault, UPSTREAM, "Metric");
    await compileEdge(vault, UPSTREAM, CONSUMER);
    await contestUnit(vault, UPSTREAM);

    const beforeBytes = await (await import("node:fs/promises")).readFile(
      `${vault}/${CONSUMER}`,
      "utf8",
    );

    const read = await vaultRead(vault, CONSUMER);
    if (!read.ok) throw read.error;
    expect(read.value.contested_inputs?.inputs).toEqual([{ unit: UPSTREAM }]);
    expect(read.value.contested_inputs?.effective_confidence).toBe("low");
    expect(read.value.contested_inputs?.banner).toContain("contested");
    expect(read.value.frontmatter.confidence).toBe("medium"); // untouched

    const afterBytes = await (await import("node:fs/promises")).readFile(
      `${vault}/${CONSUMER}`,
      "utf8",
    );
    expect(afterBytes).toBe(beforeBytes);
  });

  it("upstream consolidated (ratified-but-still-contested) -> contested_inputs absent (C-1/LD-23)", async () => {
    await seedUnit(vault, UPSTREAM, "Metric");
    await compileEdge(vault, UPSTREAM, CONSUMER);
    await contestUnit(vault, UPSTREAM);
    const c = await vaultConsolidate(
      vault,
      { path: UPSTREAM, stance: "assert", confidence: "medium", agent: "c" },
      CAROL_RATIFIER,
    );
    expect(c.ok).toBe(true);

    const read = await vaultRead(vault, CONSUMER);
    if (!read.ok) throw read.error;
    expect("contested_inputs" in read.value).toBe(false);
  });

  it("upstream legacy or uncontested (single position) -> absent", async () => {
    await seedUnit(vault, UPSTREAM, "Metric");
    await compileEdge(vault, UPSTREAM, CONSUMER);
    // Legacy upstream (never asserted on).
    const readLegacy = await vaultRead(vault, CONSUMER);
    if (!readLegacy.ok) throw readLegacy.error;
    expect("contested_inputs" in readLegacy.value).toBe(false);

    // Single (uncontested) live position.
    const a = await vaultAssert(vault, {
      path: UPSTREAM,
      stance: "assert",
      confidence: "high",
      agent: "a",
      principal: "alice",
    });
    expect(a.ok).toBe(true);
    const readUncontested = await vaultRead(vault, CONSUMER);
    if (!readUncontested.ok) throw readUncontested.error;
    expect("contested_inputs" in readUncontested.value).toBe(false);
  });

  it("consumer with no compiled edges: absent, no new key", async () => {
    await seedUnit(vault, CONSUMER, "Standalone");
    const read = await vaultRead(vault, CONSUMER);
    if (!read.ok) throw read.error;
    expect("contested_inputs" in read.value).toBe(false);
  });

  it("RBAC omission: reader who cannot read the upstream collection sees no contested_inputs", async () => {
    const seed = await vaultWrite(vault, {
      path: "competitive-intel/metric.md",
      body: "# Metric\n\nvalue: 40\n",
      frontmatter: frontmatter({ title: "Metric", collection: "competitive-intel" }),
      agent: "agent:compiler",
    });
    if (!seed.ok) throw seed.error;
    await vaultRead(vault, "competitive-intel/metric.md", undefined, "run-2");
    const consumer = await vaultWrite(vault, {
      path: CONSUMER,
      body: "# Artifact\n\nBuilt from competitive-intel/metric.md.\n",
      frontmatter: frontmatter({ title: "Artifact", provenance: "synthesized" }),
      agent: "agent:compiler",
      run_id: "run-2",
    });
    expect(consumer.ok).toBe(true);
    await contestUnit(vault, "competitive-intel/metric.md");

    const read = await vaultRead(vault, CONSUMER, PRICING_READER);
    if (!read.ok) throw read.error;
    expect("contested_inputs" in read.value).toBe(false);
  });

  it("two compiled inputs, one contested-unratified one clean -> inputs lists exactly the contested one", async () => {
    await seedUnit(vault, UPSTREAM, "Metric A");
    await seedUnit(vault, UPSTREAM_B, "Metric B");
    await vaultRead(vault, UPSTREAM, undefined, "run-3");
    await vaultRead(vault, UPSTREAM_B, undefined, "run-3");
    const w = await vaultWrite(vault, {
      path: CONSUMER,
      body: "# Artifact\n\nBuilt from two metrics.\n",
      frontmatter: frontmatter({ title: "Artifact", provenance: "synthesized" }),
      agent: "agent:compiler",
      run_id: "run-3",
    });
    expect(w.ok).toBe(true);
    await contestUnit(vault, UPSTREAM);

    const read = await vaultRead(vault, CONSUMER);
    if (!read.ok) throw read.error;
    expect(read.value.contested_inputs?.inputs).toEqual([{ unit: UPSTREAM }]);
  });
});
