import { describe, expect, test } from "vitest";
import { filingUrl } from "./edgar-fetch.js";

describe("filingUrl", () => {
  test("strips dashes from the accession and builds the Archives path", () => {
    expect(filingUrl({ cik: "1084991", accession: "0001084991-23-000124", filename: "exhibit101firstamendmentto.htm" }))
      .toBe("https://www.sec.gov/Archives/edgar/data/1084991/000108499123000124/exhibit101firstamendmentto.htm");
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchFiling } from "./edgar-fetch.js";

const REF = { cik: "1084991", accession: "0001084991-23-000124", filename: "exhibit101firstamendmentto.htm" };

describe("fetchFiling", () => {
  test("fetches via transport, caches, and serves the second call from cache", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "edgar-"));
    try {
      let calls = 0;
      const transport = async () => { calls++; return "<p>hello</p>"; };
      const r1 = await fetchFiling(REF, { cacheDir, userAgent: "ua", transport });
      const r2 = await fetchFiling(REF, { cacheDir, userAgent: "ua", transport });
      expect(r1).toMatchObject({ ok: true, fromCache: false, html: "<p>hello</p>" });
      expect(r2).toMatchObject({ ok: true, fromCache: true, html: "<p>hello</p>" });
      expect(calls).toBe(1);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });

  test("returns an error result (does not throw) when the transport fails", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "edgar-"));
    try {
      const transport = async () => { throw new Error("HTTP 403"); };
      const r = await fetchFiling(REF, { cacheDir, userAgent: "ua", transport });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("403");
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
