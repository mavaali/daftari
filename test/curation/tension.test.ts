import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addTension,
  listTensions,
  resolveTension,
  tensionsPath,
} from "../../src/curation/tension.js";

const sampleInput = {
  title: "Pooled vs consumption billing",
  sourceA: "pricing/cirrus-capacity-tiers.md",
  claimA: "pooled capacity is billed whether used or not",
  sourceB: "pricing/serverless-cost-predictability.md",
  claimB: "serverless billing tracks actual consumption",
  loggedBy: "agent:claude-code",
  kind: "interpretive" as const,
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

  // --- Phase 1 (tension graph plan) -----------------------------------------

  describe("Phase 1: kind taxonomy", () => {
    it("assigns sequential ids and persists the kind field", async () => {
      const first = await addTension(vault, sampleInput);
      const second = await addTension(vault, {
        ...sampleInput,
        title: "Second tension",
        kind: "factual",
      });
      expect(first.ok && first.value.id).toBe("tension-001");
      expect(second.ok && second.value.id).toBe("tension-002");

      const raw = readFileSync(tensionsPath(vault), "utf-8");
      expect(raw).toContain("- **Id:** tension-001");
      expect(raw).toContain("- **Kind:** interpretive");
      expect(raw).toContain("- **Kind:** factual");
    });

    it("rejects a kind not in the loggable set", async () => {
      // unspecified is a legacy-only state; new logs must declare a real kind.
      const unspec = await addTension(vault, {
        ...sampleInput,
        kind: "unspecified" as unknown as "factual",
      });
      expect(unspec.ok).toBe(false);

      const bogus = await addTension(vault, {
        ...sampleInput,
        kind: "made-up" as unknown as "factual",
      });
      expect(bogus.ok).toBe(false);
    });

    it("reads a legacy entry (no kind, no id) as kind=unspecified", async () => {
      // Pre-Phase-1 entries on disk look exactly like the original block format.
      mkdirSync(join(vault, ".daftari"), { recursive: true });
      const legacy =
        "\n## 2026-04-01 — Legacy tension\n" +
        "- **Source A:** legacy/a.md says A says X\n" +
        "- **Source B:** legacy/b.md says B says Y\n" +
        "- **Status:** unresolved\n" +
        "- **Logged by:** agent:legacy\n";
      writeFileSync(tensionsPath(vault), legacy, "utf-8");

      const list = await listTensions(vault);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.value).toHaveLength(1);
      const [entry] = list.value;
      expect(entry?.kind).toBe("unspecified");
      expect(entry?.id).toBeUndefined();
      expect(entry?.resolved).toBe(false);
    });

    it("does not write 'kind: unspecified' back to the file when re-rendering", async () => {
      // Sanity check: legacy entries should round-trip untouched on read. The
      // append path never re-renders existing entries, so this test just
      // confirms the file on disk is unchanged by listTensions.
      mkdirSync(join(vault, ".daftari"), { recursive: true });
      const legacy =
        "\n## 2026-04-01 — Legacy tension\n" +
        "- **Source A:** legacy/a.md says X\n" +
        "- **Source B:** legacy/b.md says Y\n" +
        "- **Status:** unresolved\n" +
        "- **Logged by:** agent:legacy\n";
      writeFileSync(tensionsPath(vault), legacy, "utf-8");

      await listTensions(vault);
      const after = readFileSync(tensionsPath(vault), "utf-8");
      expect(after).toBe(legacy);
      expect(after).not.toContain("Kind: unspecified");
    });
  });

  describe("Phase 1: resolveTension", () => {
    it("records a resolution with required fields", async () => {
      const logged = await addTension(vault, { ...sampleInput, kind: "factual" });
      expect(logged.ok).toBe(true);
      if (!logged.ok) return;

      const resolved = await resolveTension(vault, logged.value.id as string, {
        resolved_at: "2026-06-15T09:30:00Z",
        resolved_by: "human:mihir",
        kind: "corrected",
        rationale: "Vendor portal confirmed",
        references: ["pricing/canonical.md"],
      });
      expect(resolved.ok).toBe(true);
      if (!resolved.ok) return;
      expect(resolved.value.resolved).toBe(true);
      expect(resolved.value.status).toBe("resolved");
      expect(resolved.value.resolution?.kind).toBe("corrected");

      // Round-trip through the file.
      const list = await listTensions(vault);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const [entry] = list.value;
      expect(entry?.resolved).toBe(true);
      expect(entry?.resolution?.resolved_at).toBe("2026-06-15T09:30:00Z");
      expect(entry?.resolution?.resolved_by).toBe("human:mihir");
      expect(entry?.resolution?.kind).toBe("corrected");
      expect(entry?.resolution?.rationale).toBe("Vendor portal confirmed");
      expect(entry?.resolution?.references).toEqual(["pricing/canonical.md"]);
    });

    it("errors when the id is not found", async () => {
      const result = await resolveTension(vault, "tension-999", {
        resolved_at: "2026-06-15T09:30:00Z",
        resolved_by: "human:mihir",
        kind: "invalid",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/not found/);
    });

    it("errors when the tension is already resolved", async () => {
      const logged = await addTension(vault, { ...sampleInput, kind: "factual" });
      if (!logged.ok) return;
      await resolveTension(vault, logged.value.id as string, {
        resolved_at: "2026-06-15T09:30:00Z",
        resolved_by: "human:mihir",
        kind: "corrected",
      });
      const second = await resolveTension(vault, logged.value.id as string, {
        resolved_at: "2026-06-16T09:30:00Z",
        resolved_by: "human:mihir",
        kind: "accepted",
      });
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error.message).toMatch(/already resolved/);
    });

    it("preserves other entries when resolving one of many", async () => {
      const a = await addTension(vault, { ...sampleInput, kind: "temporal" });
      const b = await addTension(vault, {
        ...sampleInput,
        title: "Second",
        kind: "factual",
      });
      const c = await addTension(vault, {
        ...sampleInput,
        title: "Third",
        kind: "interpretive",
      });
      if (!a.ok || !b.ok || !c.ok) return;

      await resolveTension(vault, b.value.id as string, {
        resolved_at: "2026-06-15T09:30:00Z",
        resolved_by: "human:mihir",
        kind: "corrected",
      });

      const list = await listTensions(vault);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      expect(list.value).toHaveLength(3);
      expect(list.value.find((e) => e.title === "Second")?.resolved).toBe(true);
      expect(list.value.find((e) => e.title === sampleInput.title)?.resolved).toBe(false);
      expect(list.value.find((e) => e.title === "Third")?.resolved).toBe(false);
    });
  });
});
