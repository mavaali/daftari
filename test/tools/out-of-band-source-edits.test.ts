// Out-of-band source edits (Stage 1 T06 finding 2). Compiled-edge staleness
// used to read only Daftari's own provenance log, so a unit edited or deleted
// directly on disk (Obsidian, git pull, an editor) kept reporting
// `current: unchanged since baseline`. Each consumes edge now carries the
// unit's content hash at compile time; a mismatch with no recorded Daftari
// write is an out-of-band change. A unit that is gone from disk is reported
// as deleted to a reader who can read everything, and stays coarsened for a
// restricted reader (#416/#217).

import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccessContext } from "../../src/access/rbac.js";
import { consumesPath, listConsumesEdges } from "../../src/curation/consumes.js";
import { vaultStaleness } from "../../src/tools/edge-staleness.js";
import { vaultRead } from "../../src/tools/read.js";
import { vaultReceipt } from "../../src/tools/receipt.js";
import { vaultReindex } from "../../src/tools/search.js";
import { vaultWrite } from "../../src/tools/write.js";
import { cleanupVault, makeTempVault } from "../helpers/temp-vault.js";

const AGENT = "agent:compiler";
const UNIT = "pricing/metric.md";
const ARTIFACT = "pricing/artifact.md";

const ADMIN: AccessContext = {
  user: "human:operator",
  roleName: "admin",
  role: { read: ["*"], write: ["*"], promote: true, ratify: true },
};
const PRICING_ONLY: AccessContext = {
  user: "human:narrow",
  roleName: "pricing-only",
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

// UNIT written through Daftari, read by run-1, then ARTIFACT written by run-1:
// one compiled edge ARTIFACT —consumes→ UNIT.
async function seedCompiled(vault: string): Promise<void> {
  const unit = await vaultWrite(vault, {
    path: UNIT,
    body: "# Metric\n\nvalue: 40\n",
    frontmatter: frontmatter(),
    agent: AGENT,
  });
  if (!unit.ok) throw unit.error;
  const read = await vaultRead(vault, UNIT, undefined, "run-1");
  if (!read.ok) throw read.error;
  const artifact = await vaultWrite(vault, {
    path: ARTIFACT,
    body: "# Artifact\n\nBuilt from the metric.\n",
    frontmatter: frontmatter({ title: "Artifact", provenance: "synthesized" }),
    agent: AGENT,
    run_id: "run-1",
  });
  if (!artifact.ok) throw artifact.error;
}

function editOnDisk(vault: string, edit: (raw: string) => string): void {
  const p = join(vault, UNIT);
  writeFileSync(p, edit(readFileSync(p, "utf-8")));
}

async function upstream(vault: string, access?: AccessContext) {
  const r = await vaultRead(vault, ARTIFACT, access);
  if (!r.ok) throw r.error;
  return r.value.upstream_staleness;
}

async function receiptFlags(vault: string, access?: AccessContext): Promise<string[]> {
  const r = await vaultReceipt(vault, { paths: [ARTIFACT] }, access);
  if (!r.ok) throw r.error;
  return r.value.summary.flags;
}

describe("out-of-band source edits (T06 finding 2)", () => {
  let vault: string;
  beforeEach(() => {
    vault = makeTempVault();
  });
  afterEach(() => {
    cleanupVault(vault);
  });

  it("stamps the unit's compile-time content hash on the consumes edge", async () => {
    await seedCompiled(vault);
    const edges = await listConsumesEdges(vault);
    if (!edges.ok) throw edges.error;
    expect(edges.value).toHaveLength(1);
    expect(edges.value[0]?.unit_hash).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("a baseline is current until the source changes", async () => {
    await seedCompiled(vault);
    const up = await upstream(vault, ADMIN);
    expect(up?.edges[0]?.staleness).toBe("current");
    expect(await receiptFlags(vault, ADMIN)).not.toContain("cites-pending-broken-upstream");
  }, 60_000);

  it("a source edited on disk outside Daftari is pending-broken, with an out-of-band reason", async () => {
    await seedCompiled(vault);
    editOnDisk(vault, (raw) => raw.replace("value: 40", "value: 99"));
    await vaultReindex(vault);

    const up = await upstream(vault, ADMIN);
    expect(up?.edges[0]?.staleness).toBe("pending-broken");
    expect(up?.edges[0]?.reason).toContain("outside Daftari");
    expect(up?.pending_broken).toBe(1);
    expect(up?.banner).toContain("changed incompatibly");

    // The receipt consumes the same shared classification.
    expect(await receiptFlags(vault, ADMIN)).toContain("cites-pending-broken-upstream");

    const st = await vaultStaleness(vault, { artifact: ARTIFACT });
    if (!st.ok) throw st.error;
    if (st.value.mode !== "artifact") throw new Error("expected artifact mode");
    expect(st.value.edges[0]?.staleness).toBe("pending-broken");
    expect(st.value.summary.pending_broken).toBe(1);
  }, 60_000);

  it("detects the edit without a reindex (reads the file, not the index)", async () => {
    await seedCompiled(vault);
    editOnDisk(vault, (raw) => raw.replace("value: 40", "value: 99"));
    const up = await upstream(vault);
    expect(up?.edges[0]?.staleness).toBe("pending-broken");
  }, 60_000);

  it("hash semantics: a whitespace edit counts as a change; a CRLF re-checkout does not", async () => {
    await seedCompiled(vault);
    editOnDisk(vault, (raw) => raw.replace(/\n/g, "\r\n"));
    expect((await upstream(vault))?.edges[0]?.staleness).toBe("current");

    editOnDisk(vault, (raw) => `${raw}\n`);
    expect((await upstream(vault))?.edges[0]?.staleness).toBe("pending-broken");
  }, 60_000);

  it("a source deleted on disk is reported as deleted to a reader who can read everything", async () => {
    await seedCompiled(vault);
    unlinkSync(join(vault, UNIT));

    for (const reindex of [false, true]) {
      if (reindex) await vaultReindex(vault);
      const up = await upstream(vault, ADMIN);
      expect(up?.edges[0]?.unit).toBe(UNIT);
      expect(up?.edges[0]?.staleness).toBe("unverifiable");
      expect(up?.edges[0]?.reason).toContain("deleted");
      expect(up?.unverifiable).toBe(1);
      expect(up?.hidden_pending).toBe("none");
      expect(up?.banner).toContain("deleted");
      expect(up?.banner).not.toContain("outside your read scope");
      expect(await receiptFlags(vault, ADMIN)).toContain("cites-broken-source");
    }

    // The operator (no access context) gets the same named row.
    const op = await upstream(vault);
    expect(op?.edges[0]?.reason).toContain("deleted");
  }, 60_000);

  it("a restricted reader still gets only the coarse bucket for a deleted source", async () => {
    await seedCompiled(vault);
    unlinkSync(join(vault, UNIT));
    await vaultReindex(vault);

    const up = await upstream(vault, PRICING_ONLY);
    expect(up?.edges).toEqual([]);
    expect(up?.unverifiable).toBe(0);
    expect(up?.hidden_pending).toBe("some");
    expect(up?.banner).toContain("outside your read scope");
    expect(up?.banner).not.toContain("deleted");
  }, 60_000);

  it("an old baseline without a hash keeps today's behaviour", async () => {
    await seedCompiled(vault);
    // Strip unit_hash: the shape every edge minted before this change has.
    const lines = readFileSync(consumesPath(vault), "utf-8").trim().split("\n");
    writeFileSync(
      consumesPath(vault),
      `${lines
        .map((l) => {
          const { unit_hash: _drop, ...rest } = JSON.parse(l) as Record<string, unknown>;
          return JSON.stringify(rest);
        })
        .join("\n")}\n`,
    );
    editOnDisk(vault, (raw) => raw.replace("value: 40", "value: 99"));
    await vaultReindex(vault);

    const up = await upstream(vault, ADMIN);
    expect(up?.edges[0]?.staleness).toBe("current");
    expect(up?.edges[0]?.reason).toBe("unchanged since baseline");
  }, 60_000);

  it("an in-Daftari write still takes the provenance path", async () => {
    await seedCompiled(vault);
    const cur = await vaultRead(vault, UNIT);
    if (!cur.ok) throw cur.error;
    const w = await vaultWrite(vault, {
      path: UNIT,
      body: "# Metric\n\nvalue: 60\n",
      frontmatter: cur.value.frontmatter as unknown as Record<string, unknown>,
      agent: AGENT,
    });
    if (!w.ok) throw w.error;
    const edge = (await upstream(vault))?.edges[0];
    expect(edge?.staleness).toBe("pending-broken");
    expect(edge?.reason).not.toContain("outside Daftari");
  }, 60_000);
});
