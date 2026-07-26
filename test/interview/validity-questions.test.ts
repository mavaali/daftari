// The interview's expired-validity question.
//
// A TTL overshoot asks "is this still true?" — the vault genuinely does not
// know. An ended validity asks something sharper, because the document has
// already answered that: it stopped being true, and nothing replaced it. The
// only open question is WHAT replaced it.
//
// This is also the adoption ramp for the whole axis. Valid time is authored
// and never inferred, so the only way intervals get into a vault is somebody
// writing them — and being asked "what replaced this?" is the moment where
// that happens naturally.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherQuestions } from "../../src/interview/questions.js";

const NOW = new Date("2026-07-26T00:00:00Z");

function md(vault: string, path: string, over: Record<string, string> = {}): void {
  const fm: Record<string, string> = {
    title: `Doc ${path}`,
    domain: "accumulation",
    collection: path.split("/")[0] ?? "",
    status: "canonical",
    confidence: "high",
    created: "2026-07-01",
    updated: "2026-07-20", // fresh by TTL
    updated_by: "agent:test",
    provenance: "direct",
    ttl_days: "365",
    ...over,
  };
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  mkdirSync(join(vault, path.split("/")[0] ?? ""), { recursive: true });
  writeFileSync(
    join(vault, path),
    `---\n${lines.join("\n")}\nsources: []\ntags: []\n---\n\nBody of ${path}.\n`,
  );
}

describe("daftari interview — expired validity", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-interview-validity-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("asks what replaced a document whose validity ended", async () => {
    md(vault, "pricing/expired.md", { valid_from: "2026-01-01", valid_until: "2026-03-31" });
    const r = await gatherQuestions(vault, { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.value.find((x) => x.refs.includes("pricing/expired.md"));
    expect(q?.kind).toBe("stale");
    expect(q?.question).toContain("stopped being");
    expect(q?.question).toContain("2026-03-31");
    expect(q?.question).toMatch(/what replaced it/i);
    expect(q?.context).toContain("no successor");
  });

  it("asks nothing when a successor is already recorded", async () => {
    md(vault, "pricing/expired.md", {
      valid_from: "2026-01-01",
      valid_until: "2026-03-31",
      superseded_by: "pricing/successor.md",
    });
    md(vault, "pricing/successor.md", { valid_from: "2026-04-01" });
    const r = await gatherQuestions(vault, { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.find((x) => x.refs.includes("pricing/expired.md"))).toBeUndefined();
  });

  it("asks nothing about a document still inside its interval", async () => {
    md(vault, "pricing/current.md", { valid_from: "2026-01-01", valid_until: "2026-12-31" });
    const r = await gatherQuestions(vault, { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.find((x) => x.refs.includes("pricing/current.md"))).toBeUndefined();
  });

  it("still asks the TTL question for a document with no interval", async () => {
    md(vault, "pricing/old.md", { updated: "2020-01-01", ttl_days: "30" });
    const r = await gatherQuestions(vault, { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const q = r.value.find((x) => x.refs.includes("pricing/old.md"));
    expect(q?.question).toContain("freshness window");
  });

  it("honors the domain split — never asks about a generative doc", async () => {
    md(vault, "notes/gen.md", {
      domain: "generative",
      valid_from: "2026-01-01",
      valid_until: "2026-03-31",
    });
    const r = await gatherQuestions(vault, { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.find((x) => x.refs.includes("notes/gen.md"))).toBeUndefined();
  });
});
