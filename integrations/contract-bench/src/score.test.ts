import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scoreChain } from "./score.js";
import type { Seed } from "./chain-docs.js";

const seed = (docs: { order: number; role: string; filename: string }[]): Seed => ({
  chainId: "t", unitType: "unknown",
  docs: docs.map((d) => ({ id: d.role, order: d.order, role: d.role, cik: "1", accession: "a", filename: d.filename })),
});

describe("scoreChain", () => {
  test("scores a mixed chain: counts ops across amendments, classifies unit type, computes unrecoverable rate", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "edgar-"));
    try {
      const bodies: Record<string, string> = {
        "base.htm": "<p>Master agreement.</p>",
        // amendment with one Section restate (recoverable) + one defined-term restate (recoverable) + one partial (unrecoverable)
        "a1.htm": `<p>Section 5.1 of the Agreement is hereby amended and restated in its entirety as follows: "x". The terms set forth in Section 1.1 are hereby amended and restated in their respective entireties to read in full as follows: &#8220;Margin&#8221; means 2%. Section 9.9 of the Agreement is hereby amended by inserting a comma.</p>`,
      };
      const transport = async (url: string) => bodies[url.split("/").pop() as string];
      const r = await scoreChain(seed([{ order: 0, role: "master", filename: "base.htm" }, { order: 1, role: "amendment-1", filename: "a1.htm" }]), { cacheDir, userAgent: "ua", transport });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.score.length).toBe(2);
      expect(r.score.unitType).toBe("mixed");           // Section clause + defined term both present
      expect(r.score.totalOps).toBe(3);
      expect(r.score.unrecoverableOps).toBe(1);          // the "amended by" partial
      expect(r.score.unrecoverableRate).toBeCloseTo(1 / 3, 5);
      expect(r.score.cik).toBe("1");
    } finally { rmSync(cacheDir, { recursive: true, force: true }); }
  });

  test("propagates a build failure as an error result", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "edgar-"));
    try {
      const transport = async () => { throw new Error("HTTP 404"); };
      const r = await scoreChain(seed([{ order: 0, role: "master", filename: "b.htm" }]), { cacheDir, userAgent: "ua", transport });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("404"); // the build error propagates, not a generic message
    } finally { rmSync(cacheDir, { recursive: true, force: true }); }
  });
});
