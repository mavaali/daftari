import { describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filingUrl, fetchFiling } from "./edgar-fetch.js";

describe("filingUrl", () => {
  test("strips dashes from the accession and builds the Archives path", () => {
    expect(filingUrl({ cik: "1084991", accession: "0001084991-23-000124", filename: "exhibit101firstamendmentto.htm" }))
      .toBe("https://www.sec.gov/Archives/edgar/data/1084991/000108499123000124/exhibit101firstamendmentto.htm");
  });
});

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

  test("returns an error result (does not throw) when a cached entry is unreadable", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "edgar-"));
    try {
      // Make the cache path a directory so readFile fails with EISDIR — proves
      // the cache-hit branch honors the no-throw Result contract.
      const key = `${REF.accession}-${REF.filename}`.replace(/[^\w.-]/g, "_");
      mkdirSync(join(cacheDir, key));
      const r = await fetchFiling(REF, { cacheDir, userAgent: "ua", transport: async () => "x" });
      expect(r.ok).toBe(false);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
