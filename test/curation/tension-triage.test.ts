// Tension Triage Card (Story 1): the pure engine. Composes live tensions with
// their blast, per-side tier/confidence, and per-side read-heat, grouped by
// cluster. Deliberately computes NO composite severity score — ranking is the
// human's job in v0 (legibility before automation).

import { describe, expect, it } from "vitest";
import type { ReadHeat } from "../../src/curation/read-heat.js";
import type { TensionEntry } from "../../src/curation/tension.js";
import type { HiddenDownstream } from "../../src/curation/tension-blast.js";
import {
  computeTensionTriage,
  type TriageBlast,
  type TriageDocMeta,
} from "../../src/curation/tension-triage.js";

const NOW = new Date("2026-06-01T00:00:00Z");

const buildEntry = (overrides: Partial<TensionEntry>): TensionEntry => ({
  id: "tension-001",
  date: "2026-05-01",
  title: "t",
  kind: "factual",
  sourceA: "a.md",
  claimA: "A",
  sourceB: "b.md",
  claimB: "B",
  status: "unresolved",
  loggedBy: "agent:claude-code",
  resolved: false,
  ...overrides,
});

const heat = (count: number): ReadHeat => ({
  count,
  last_read: count > 0 ? "2026-05-30T00:00:00Z" : null,
  instrumented: true,
});

const blast = (p: number, a: number, h: HiddenDownstream = "none"): TriageBlast => ({
  primary_blast: p,
  advisory_blast: a,
  hidden_downstream: h,
});

const meta = (
  tier: TriageDocMeta["tier"],
  confidence: TriageDocMeta["confidence"],
): TriageDocMeta => ({
  tier,
  confidence,
  created: "2026-01-01",
});

const emptyInputs = () => ({
  docMeta: new Map<string, TriageDocMeta>(),
  readHeat: new Map<string, ReadHeat>(),
  blastByTension: new Map<string, TriageBlast>(),
});

describe("computeTensionTriage", () => {
  it("returns an empty result when there are no tensions", () => {
    const result = computeTensionTriage([], emptyInputs(), NOW);
    expect(result.cluster_count).toBe(0);
    expect(result.tension_count).toBe(0);
    expect(result.clusters).toEqual([]);
  });

  it("excludes resolved and accepted tensions", () => {
    const tensions = [
      buildEntry({ id: "tension-001", resolved: true }),
      buildEntry({
        id: "tension-002",
        sourceA: "c.md",
        sourceB: "d.md",
        resolved: true,
        resolution: {
          resolved_at: "2026-05-15",
          resolved_by: "human:mihir",
          kind: "accepted",
        },
      }),
      buildEntry({ id: "tension-003", sourceA: "e.md", sourceB: "f.md" }),
    ];
    const result = computeTensionTriage(tensions, emptyInputs(), NOW);
    expect(result.tension_count).toBe(1);
    expect(result.clusters[0]?.tensions[0]?.id).toBe("tension-003");
  });

  it("groups two disconnected tensions into two clusters", () => {
    const tensions = [
      buildEntry({ id: "tension-001", sourceA: "a.md", sourceB: "b.md" }),
      buildEntry({ id: "tension-002", sourceA: "c.md", sourceB: "d.md" }),
    ];
    const result = computeTensionTriage(tensions, emptyInputs(), NOW);
    expect(result.cluster_count).toBe(2);
  });

  it("orders clusters by member count descending", () => {
    const tensions = [
      // small cluster: a-b (2 docs)
      buildEntry({ id: "tension-001", sourceA: "a.md", sourceB: "b.md" }),
      // large cluster: c-d-e (3 docs) via two tensions
      buildEntry({ id: "tension-002", sourceA: "c.md", sourceB: "d.md" }),
      buildEntry({ id: "tension-003", sourceA: "d.md", sourceB: "e.md" }),
    ];
    const result = computeTensionTriage(tensions, emptyInputs(), NOW);
    expect(result.clusters[0]?.documents.length).toBe(3);
    expect(result.clusters[1]?.documents.length).toBe(2);
  });

  it("orders tensions within a cluster by age descending", () => {
    const tensions = [
      buildEntry({ id: "tension-001", sourceA: "a.md", sourceB: "b.md", date: "2026-05-20" }), // newer
      buildEntry({ id: "tension-002", sourceA: "b.md", sourceB: "c.md", date: "2026-04-01" }), // older
    ];
    const result = computeTensionTriage(tensions, emptyInputs(), NOW);
    const ids = result.clusters[0]?.tensions.map((t) => t.id);
    expect(ids).toEqual(["tension-002", "tension-001"]);
  });

  it("computes age_days from the tension date", () => {
    const tensions = [buildEntry({ date: "2026-05-01" })];
    const result = computeTensionTriage(tensions, emptyInputs(), NOW);
    expect(result.clusters[0]?.tensions[0]?.age_days).toBe(31);
  });

  it("enriches each side with tier and confidence from doc metadata", () => {
    const inputs = emptyInputs();
    inputs.docMeta.set("a.md", meta(1, "high"));
    inputs.docMeta.set("b.md", meta(null, "low"));
    const result = computeTensionTriage([buildEntry({})], inputs, NOW);
    const t = result.clusters[0]?.tensions[0];
    expect(t?.a.tier).toBe(1);
    expect(t?.a.confidence).toBe("high");
    expect(t?.b.tier).toBeNull();
    expect(t?.b.confidence).toBe("low");
  });

  it("attaches read-heat per side", () => {
    const inputs = emptyInputs();
    inputs.readHeat.set("a.md", heat(7));
    inputs.readHeat.set("b.md", heat(0));
    const result = computeTensionTriage([buildEntry({})], inputs, NOW);
    const t = result.clusters[0]?.tensions[0];
    expect(t?.a.read_heat?.count).toBe(7);
    expect(t?.b.read_heat?.count).toBe(0);
  });

  it("attaches blast per tension", () => {
    const inputs = emptyInputs();
    inputs.blastByTension.set("tension-001", blast(4, 2, "some"));
    const result = computeTensionTriage([buildEntry({ id: "tension-001" })], inputs, NOW);
    const t = result.clusters[0]?.tensions[0];
    expect(t?.primary_blast).toBe(4);
    expect(t?.advisory_blast).toBe(2);
    expect(t?.hidden_downstream).toBe("some");
  });

  it("marks a side unknown when its doc is missing from metadata", () => {
    const result = computeTensionTriage([buildEntry({})], emptyInputs(), NOW);
    const t = result.clusters[0]?.tensions[0];
    expect(t?.a.tier).toBeNull();
    expect(t?.a.confidence).toBeNull();
    expect(t?.a.read_heat).toBeNull();
  });

  it("marks blast unavailable when the tension has no blast entry", () => {
    const result = computeTensionTriage([buildEntry({})], emptyInputs(), NOW);
    const t = result.clusters[0]?.tensions[0];
    expect(t?.primary_blast).toBeNull();
    expect(t?.advisory_blast).toBeNull();
    expect(t?.hidden_downstream).toBeNull();
  });

  it("computes NO composite score field on a tension", () => {
    const result = computeTensionTriage([buildEntry({})], emptyInputs(), NOW);
    const t = result.clusters[0]?.tensions[0] as Record<string, unknown>;
    expect(t).not.toHaveProperty("score");
    expect(t).not.toHaveProperty("severity");
    expect(t).not.toHaveProperty("rank");
  });

  it("carries the paths and claims onto each side", () => {
    const result = computeTensionTriage(
      [buildEntry({ sourceA: "a.md", claimA: "A says", sourceB: "b.md", claimB: "B says" })],
      emptyInputs(),
      NOW,
    );
    const t = result.clusters[0]?.tensions[0];
    expect(t?.a.path).toBe("a.md");
    expect(t?.a.claim).toBe("A says");
    expect(t?.b.path).toBe("b.md");
    expect(t?.b.claim).toBe("B says");
  });
});
