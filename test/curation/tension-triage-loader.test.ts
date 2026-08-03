// loadTensionTriage — the async loader that wires real vault reads
// (documents, per-tension blast, read-heat) into the pure computeTensionTriage
// engine. Mirrors loadTensionClusters' Result + entryFilter contract.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordRead } from "../../src/curation/read-log.js";
import { addTension, type TensionEntry } from "../../src/curation/tension.js";
import { loadTensionTriage } from "../../src/curation/tension-triage.js";

const NOW = new Date("2026-06-01T00:00:00Z");

interface DocSpec {
  path: string;
  sources?: string[];
  created?: string;
}

async function writeDoc(vault: string, spec: DocSpec): Promise<void> {
  const sources = spec.sources ?? [];
  const sourcesYaml =
    sources.length === 0 ? "sources: []" : `sources:\n${sources.map((s) => `  - ${s}`).join("\n")}`;
  const fm = [
    "---",
    `title: "${spec.path}"`,
    "domain: accumulation",
    "collection: triage",
    "status: canonical",
    "confidence: high",
    `created: ${spec.created ?? "2026-05-01"}`,
    "updated: 2026-05-01",
    "updated_by: agent:test",
    "provenance: direct",
    sourcesYaml,
    "superseded_by: null",
    "ttl_days: null",
    "tags: []",
    "---",
    "",
  ].join("\n");
  const abs = join(vault, spec.path);
  mkdirSync(dirname(abs), { recursive: true });
  await writeFile(abs, `${fm}\n`);
}

async function logTension(vault: string, a: string, b: string): Promise<void> {
  const res = await addTension(vault, {
    title: `${a} vs ${b}`,
    sourceA: a,
    claimA: "X",
    sourceB: b,
    claimB: "Y",
    loggedBy: "agent:test",
    kind: "factual",
  });
  if (!res.ok) throw new Error("addTension failed in setup");
}

describe("loadTensionTriage", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-triage-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("returns an empty result when the vault has no tensions", async () => {
    await writeDoc(vault, { path: "a.md" });
    const result = await loadTensionTriage(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.cluster_count).toBe(0);
    expect(result.value.tension_count).toBe(0);
    expect(result.value.clusters).toEqual([]);
  });

  it("wires tier and confidence from doc frontmatter onto each side", async () => {
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "b.md" });
    await logTension(vault, "a.md", "b.md");

    const result = await loadTensionTriage(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const t = result.value.clusters[0]?.tensions[0];
    // writeDoc emits tier-less frontmatter (tier: null) at high confidence.
    expect(t?.a.tier).toBeNull();
    expect(t?.a.confidence).toBe("high");
    expect(t?.b.confidence).toBe("high");
  });

  it("computes per-tension blast, seeding on both endpoints", async () => {
    // c.md sources a.md, so c is downstream of the contested pair {a,b}.
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "b.md" });
    await writeDoc(vault, { path: "c.md", sources: ["a.md"] });
    await logTension(vault, "a.md", "b.md");

    const result = await loadTensionTriage(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const t = result.value.clusters[0]?.tensions[0];
    expect(t?.primary_blast).toBe(1);
    expect(t?.advisory_blast).toBe(0);
    expect(t?.hidden_downstream).toBe("none");
  });

  it("wires read-heat from the read log onto each side", async () => {
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "b.md" });
    await logTension(vault, "a.md", "b.md");
    // A read within the 30-day window (cutoff 2026-05-02).
    await recordRead(vault, {
      tool: "vault_read",
      file: "a.md",
      timestamp: "2026-05-20T00:00:00Z",
    });

    const result = await loadTensionTriage(vault, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const t = result.value.clusters[0]?.tensions[0];
    expect(t?.a.read_heat?.count).toBe(1);
    expect(t?.a.read_heat?.last_read).toBe("2026-05-20T00:00:00Z");
    expect(t?.b.read_heat?.count).toBe(0);
  });

  it("applies the injected entryFilter (RBAC hook)", async () => {
    await writeDoc(vault, { path: "a.md" });
    await writeDoc(vault, { path: "b.md" });
    await writeDoc(vault, { path: "c.md" });
    await writeDoc(vault, { path: "d.md" });
    await logTension(vault, "a.md", "b.md");
    await logTension(vault, "c.md", "d.md");

    // Drop every tension touching c.md — the filter the tool layer would inject.
    const filter = (entries: TensionEntry[]) =>
      entries.filter((e) => e.sourceA !== "c.md" && e.sourceB !== "c.md");
    const result = await loadTensionTriage(vault, NOW, filter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tension_count).toBe(1);
    expect(result.value.clusters[0]?.tensions[0]?.a.path).toBe("a.md");
  });
});
