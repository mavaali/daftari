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
