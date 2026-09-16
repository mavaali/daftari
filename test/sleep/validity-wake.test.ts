// Expired validity as a second reason to wake a document.
//
// TTL expiry says "you promised to re-check this by now". Expired validity
// says something stronger: the document itself declares its claim stopped
// holding. A document can be freshly updated — TTL nowhere near expiry — and
// still be describing a fact that ended last quarter. Only the second axis
// catches that.
//
// A superseded document is excluded: the handoff was recorded, so there is
// nothing left to ask.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSleepCycle } from "../../src/sleep/cycle.js";

const NOW = new Date("2026-07-26T00:00:00Z");

function md(vault: string, path: string, over: Record<string, string> = {}): void {
  const fm: Record<string, string> = {
    title: `Doc ${path}`,
    domain: "accumulation",
    collection: path.split("/")[0] ?? "",
    status: "canonical",
    confidence: "high",
    created: "2026-07-01",
    // Deliberately fresh: nothing here is TTL-stale, so any wake must come
    // from the validity axis alone.
    updated: "2026-07-20",
    updated_by: "agent:test",
    provenance: "direct",
    ttl_days: "365",
    ...over,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  mkdirSync(join(vault, path.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(
    join(vault, path),
    `---\n${lines.join("\n")}\nsources: []\ntags: []\n---\n\nBody. See [[${
      path.includes("downstream") ? "pricing/expired" : "pricing/other"
    }]].\n`,
  );
}

describe("daftari sleep — expired validity", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-sleep-validity-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("wakes a fresh-by-TTL document whose validity has ended", async () => {
    md(vault, "pricing/expired.md", { valid_from: "2026-01-01", valid_until: "2026-03-31" });
    // A downstream dependent, so it lands in `wake` rather than `decayedQuiet`.
    md(vault, "pricing/downstream.md");

    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const woken = r.value.wake.map((w) => w.path);
    expect(woken).toContain("pricing/expired.md");
  });

  it("explains the wake in terms of validity, not TTL", async () => {
    md(vault, "pricing/expired.md", { valid_from: "2026-01-01", valid_until: "2026-03-31" });
    md(vault, "pricing/downstream.md");

    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const task = r.value.wake.find((w) => w.path === "pricing/expired.md");
    expect(task?.reason).toContain("validity ended 2026-03-31");
    expect(task?.reason).not.toContain("TTL");
  });

  it("does NOT wake a document whose validity ended but which was superseded", async () => {
    // The handoff is on record. Nothing to ask.
    md(vault, "pricing/expired.md", {
      valid_from: "2026-01-01",
      valid_until: "2026-03-31",
      superseded_by: "pricing/successor.md",
    });
    md(vault, "pricing/successor.md", { valid_from: "2026-04-01" });
    md(vault, "pricing/downstream.md");

    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.wake.map((w) => w.path)).not.toContain("pricing/expired.md");
  });

  it("does not wake a document still inside its interval", async () => {
    md(vault, "pricing/current.md", { valid_from: "2026-01-01", valid_until: "2026-12-31" });
    md(vault, "pricing/downstream.md");

    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.wake.map((w) => w.path)).not.toContain("pricing/current.md");
  });

  it("honors the domain split — a generative doc is counted, never woken", async () => {
    md(vault, "notes/gen.md", {
      domain: "generative",
      valid_from: "2026-01-01",
      valid_until: "2026-03-31",
    });
    md(vault, "notes/downstream.md", { domain: "generative" });

    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.wake.map((w) => w.path)).not.toContain("notes/gen.md");
    expect(r.value.generativeStale).toBeGreaterThan(0);
  });

  it("leaves the staleness distribution alone — that is the TTL axis", async () => {
    md(vault, "pricing/expired.md", { valid_from: "2026-01-01", valid_until: "2026-03-31" });
    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Fresh by TTL, whatever its validity says.
    expect(r.value.staleness.stale).toBe(0);
    expect(r.value.staleness.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unit U4 — retracted source wake
//
// A canonical accumulation doc that cites a deprecated or superseded doc in
// its `sources` frontmatter should be woken regardless of its own TTL or
// validity state. The trigger is the *source doc's* lifecycle status, not the
// citing doc's staleness. Self-terminating: once the citing doc drops/re-points
// the retracted source it stops matching.
// ---------------------------------------------------------------------------

function mdRetracted(vault: string, path: string, over: Record<string, unknown> = {}): void {
  const base: Record<string, unknown> = {
    title: `Doc ${path}`,
    domain: "accumulation",
    collection: path.split("/")[0] ?? "",
    status: "canonical",
    confidence: "high",
    created: "2026-07-01",
    // Deliberately fresh — TTL and validity are not the wake trigger here.
    updated: "2026-07-24",
    updated_by: "agent:test",
    provenance: "direct",
    ttl_days: "365",
    ...over,
  };
  const lines = Object.entries(base).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${(v as string[]).join(", ")}]`;
    return `${k}: ${String(v)}`;
  });
  mkdirSync(join(vault, path.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(join(vault, path), `---\n${lines.join("\n")}\ntags: []\n---\n\nBody.\n`);
}

describe("daftari sleep — retracted source wake", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-sleep-retracted-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("wakes a fresh canonical doc whose sources cite a deprecated doc", async () => {
    // The retracted source.
    mdRetracted(vault, "refs/old-spec.md", { status: "deprecated" });
    // The dependent that cites it — fresh by TTL, validity intact.
    mdRetracted(vault, "analysis/dep.md", { sources: ["refs/old-spec.md"] });

    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const woken = r.value.wake.map((w) => w.path);
    expect(woken).toContain("analysis/dep.md");
  });

  it("wakes for explicit vault refs but not same-shaped repository refs", async () => {
    mdRetracted(vault, "refs/old-spec.md", { status: "deprecated" });
    mdRetracted(vault, "analysis/vault-dep.md", {
      sources: ["vault:refs/old-spec.md"],
    });
    mdRetracted(vault, "analysis/repo-dep.md", {
      sources: ["repo:refs/old-spec.md"],
    });

    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const woken = r.value.wake.map((w) => w.path);
    expect(woken).toContain("analysis/vault-dep.md");
    expect(woken).not.toContain("analysis/repo-dep.md");
  });

  it("reason mentions 'retracted source'", async () => {
    mdRetracted(vault, "refs/old-spec.md", { status: "deprecated" });
    mdRetracted(vault, "analysis/dep.md", { sources: ["refs/old-spec.md"] });

    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const task = r.value.wake.find((w) => w.path === "analysis/dep.md");
    expect(task?.reason).toContain("retracted source");
  });

  it("wakes a fresh canonical doc whose sources cite a superseded doc", async () => {
    mdRetracted(vault, "refs/superseded-spec.md", { status: "superseded" });
    mdRetracted(vault, "analysis/dep2.md", { sources: ["refs/superseded-spec.md"] });

    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const woken = r.value.wake.map((w) => w.path);
    expect(woken).toContain("analysis/dep2.md");
  });

  it("does NOT wake a canonical doc citing a canonical (non-retracted) source", async () => {
    mdRetracted(vault, "refs/live-spec.md", { status: "canonical" });
    mdRetracted(vault, "analysis/healthy.md", { sources: ["refs/live-spec.md"] });

    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.wake.map((w) => w.path)).not.toContain("analysis/healthy.md");
  });

  it("self-termination: re-pointing away from the retracted source stops the wake", async () => {
    mdRetracted(vault, "refs/old-spec.md", { status: "deprecated" });
    mdRetracted(vault, "refs/new-spec.md", { status: "canonical" });
    // dep3 now points at the live source, not the retracted one.
    mdRetracted(vault, "analysis/dep3.md", { sources: ["refs/new-spec.md"] });

    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.wake.map((w) => w.path)).not.toContain("analysis/dep3.md");
  });

  it("does NOT wake a draft (non-canonical) doc even if it cites a retracted source", async () => {
    mdRetracted(vault, "refs/old-spec.md", { status: "deprecated" });
    mdRetracted(vault, "analysis/draft-dep.md", {
      status: "draft",
      sources: ["refs/old-spec.md"],
    });

    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.wake.map((w) => w.path)).not.toContain("analysis/draft-dep.md");
  });

  it("does not wake a dangling qualified source ref through a same-basename retracted doc", async () => {
    mdRetracted(vault, "b/foo.md", { status: "deprecated" });
    mdRetracted(vault, "analysis/dep.md", { sources: ["a/foo.md"] });

    const r = await runSleepCycle(vault, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.wake.map((w) => w.path)).not.toContain("analysis/dep.md");
  });
});
