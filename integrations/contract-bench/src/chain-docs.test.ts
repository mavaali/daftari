import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChainDocs, type Seed } from "./chain-docs.js";

const SEED: Seed = {
  chainId: "t", unitType: "mixed",
  docs: [
    { id: "amd-2", order: 2, role: "amendment-2", cik: "1", accession: "a-2", filename: "two.htm" },
    { id: "base", order: 0, role: "master-ar",  cik: "1", accession: "a-0", filename: "zero.htm" },
    { id: "amd-1", order: 1, role: "amendment-1", cik: "1", accession: "a-1", filename: "one.htm" },
  ],
};

describe("buildChainDocs", () => {
  test("fetches each doc, htmlToText's it, and returns ChainDocs sorted by order", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "edgar-"));
    try {
      const bodies: Record<string, string> = {
        "zero.htm": "<p>base &#8220;X&#8221;</p>",
        "one.htm": "<p>one</p>",
        "two.htm": "<p>two</p>",
      };
      const transport = async (url: string) => {
        const file = url.split("/").pop() as string;
        return bodies[file];
      };
      const r = await buildChainDocs(SEED, { cacheDir, userAgent: "ua", transport });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.docs.map((d) => d.id)).toEqual(["base", "amd-1", "amd-2"]);
      expect(r.docs.map((d) => d.order)).toEqual([0, 1, 2]);
      expect(r.docs[0]).toMatchObject({ id: "base", order: 0, text: "base “X”" });
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("propagates a fetch failure as an error result naming the doc", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "edgar-"));
    try {
      const transport = async () => { throw new Error("HTTP 404"); };
      const r = await buildChainDocs(SEED, { cacheDir, userAgent: "ua", transport });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/base.*404/);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
