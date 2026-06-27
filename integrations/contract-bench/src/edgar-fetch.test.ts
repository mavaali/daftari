import { describe, expect, test } from "vitest";
import { filingUrl } from "./edgar-fetch.js";

describe("filingUrl", () => {
  test("strips dashes from the accession and builds the Archives path", () => {
    expect(filingUrl({ cik: "1084991", accession: "0001084991-23-000124", filename: "exhibit101firstamendmentto.htm" }))
      .toBe("https://www.sec.gov/Archives/edgar/data/1084991/000108499123000124/exhibit101firstamendmentto.htm");
  });
});
