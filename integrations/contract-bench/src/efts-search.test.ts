import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { parseEftsResponse, searchFullText } from "./efts-search.js";

const raw = JSON.parse(readFileSync(new URL("./__fixtures__/efts/credit-amendments.json", import.meta.url), "utf8"));

describe("parseEftsResponse", () => {
  test("maps EFTS hits to normalized {cik, accession, filename, formType, fileDate}", () => {
    const hits = parseEftsResponse(raw);
    expect(hits.length).toBe(5);
    expect(hits[0]).toMatchObject({ cik: expect.stringMatching(/^\d{10}$/), accession: expect.stringMatching(/^\d{10}-\d\d-\d{6}$/), filename: expect.stringMatching(/\.htm$/) });
  });
  test("splits the _id into accession:filename and reads the first cik", () => {
    // _id is "<accession>:<filename>"; _source.ciks[0] is the filer.
    const hits = parseEftsResponse({ hits: { hits: [{ _id: "0001084991-23-000124:exhibit101firstamendmentto.htm", _source: { ciks: ["0001084991"], root_forms: ["8-K"], file_date: "2023-11-15" } }] } });
    expect(hits[0]).toEqual({ cik: "0001084991", accession: "0001084991-23-000124", filename: "exhibit101firstamendmentto.htm", formType: "8-K", fileDate: "2023-11-15" });
  });
  test("skips malformed hits (no _id, no cik)", () => {
    expect(parseEftsResponse({ hits: { hits: [{ _id: "noColon" }, { _source: { ciks: ["1"] } }] } })).toEqual([]);
    expect(parseEftsResponse({})).toEqual([]);
  });
});

describe("searchFullText", () => {
  test("paginates via the transport until an empty page, accumulating hits", async () => {
    let calls = 0;
    const page = (n: number) => JSON.stringify({ hits: { hits: Array.from({ length: n }, (_, i) => ({ _id: `000000000${calls}-00-00000${i}:f${i}.htm`, _source: { ciks: ["0000000001"], root_forms: ["8-K"], file_date: "2023-01-01" } })) } });
    const transport = async () => { const body = calls === 0 ? page(2) : page(0); calls++; return body; };
    const r = await searchFullText("Amendment to Credit Agreement", { userAgent: "ua", transport, maxHits: 100 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.hits.length).toBe(2);
    expect(calls).toBe(2); // page 0 (2 hits) then page 1 (empty) -> stop
  });
  test("returns an error result (no throw) when the transport fails", async () => {
    const transport = async () => { throw new Error("HTTP 429"); };
    const r = await searchFullText("x", { userAgent: "ua", transport });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("429");
  });
});
