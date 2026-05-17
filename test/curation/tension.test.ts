import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addTension, listTensions, tensionsPath } from "../../src/curation/tension.js";

const sampleInput = {
  title: "Pooled vs consumption billing",
  sourceA: "pricing/cirrus-capacity-tiers.md",
  claimA: "pooled capacity is billed whether used or not",
  sourceB: "pricing/serverless-cost-predictability.md",
  claimB: "serverless billing tracks actual consumption",
  loggedBy: "agent:claude-code",
};

describe("tension", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), "daftari-tension-"));
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it("returns an empty list when nothing has been logged", async () => {
    const result = await listTensions(vault);
    expect(result.ok && result.value).toEqual([]);
  });

  it("appends a tension with default date and unresolved status", async () => {
    const added = await addTension(vault, sampleInput);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.status).toBe("unresolved");
    expect(added.value.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // The file holds the canonical block format.
    const raw = readFileSync(tensionsPath(vault), "utf-8");
    expect(raw).toContain(`## ${added.value.date} — ${sampleInput.title}`);
    expect(raw).toContain(`- **Source A:** ${sampleInput.sourceA} says ${sampleInput.claimA}`);
    expect(raw).toContain("- **Status:** unresolved");
    expect(raw).toContain("- **Logged by:** agent:claude-code");
  });

  it("round-trips appended entries through listTensions", async () => {
    await addTension(vault, sampleInput);
    await addTension(vault, {
      ...sampleInput,
      title: "Second tension",
      date: "2026-05-10",
    });

    const result = await listTensions(vault);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    const second = result.value.find((e) => e.title === "Second tension");
    expect(second?.date).toBe("2026-05-10");
    expect(second?.sourceA).toBe(sampleInput.sourceA);
    expect(second?.claimB).toBe(sampleInput.claimB);
    expect(second?.loggedBy).toBe("agent:claude-code");
  });

  it("filters listTensions by status", async () => {
    await addTension(vault, sampleInput);
    await addTension(vault, {
      ...sampleInput,
      title: "Already settled",
      status: "resolved",
    });

    const unresolved = await listTensions(vault, "unresolved");
    expect(unresolved.ok && unresolved.value).toHaveLength(1);

    const resolved = await listTensions(vault, "resolved");
    expect(resolved.ok && resolved.value).toHaveLength(1);
    if (resolved.ok) expect(resolved.value[0]?.title).toBe("Already settled");
  });

  it("rejects an entry missing a required field", async () => {
    const result = await addTension(vault, { ...sampleInput, title: "  " });
    expect(result.ok).toBe(false);
  });
});
