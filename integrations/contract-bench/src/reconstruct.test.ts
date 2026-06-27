import { describe, expect, test } from "vitest";
import { reconstructChains, type DiscDoc } from "./reconstruct.js";

const doc = (accession: string, filename: string, text: string): DiscDoc => ({ ref: { cik: "1", accession, filename }, text });

describe("reconstructChains", () => {
  test("splits two same-type chains by base date, orders by ordinal, identifies the filed base", () => {
    const docs: DiscDoc[] = [
      doc("a-0", "base2020.htm", "This Credit Agreement dated as of January 1, 2020 by and among X and Y. Section 1.1 …"),
      doc("a-1", "amd1.htm", "FIRST AMENDMENT TO CREDIT AGREEMENT. This First Amendment to that certain Credit Agreement dated as of January 1, 2020 …"),
      doc("a-2", "amd2.htm", "SECOND AMENDMENT TO CREDIT AGREEMENT. This Second Amendment to that certain Credit Agreement dated as of January 1, 2020 …"),
      doc("b-0", "base2022.htm", "This Credit Agreement dated as of June 1, 2022 by and among X and Z. Section 1.1 …"),
      doc("b-1", "amdB1.htm", "FIRST AMENDMENT TO CREDIT AGREEMENT. This First Amendment to that certain Credit Agreement dated as of June 1, 2022 …"),
    ];
    const chains = reconstructChains("1", docs);
    expect(chains.length).toBe(2);
    const c2020 = chains.find((c) => c.chainId.includes("january-1-2020"))!;
    expect(c2020.docs.map((d) => [d.order, d.role, d.filename])).toEqual([
      [0, "master", "base2020.htm"], [1, "amendment-1", "amd1.htm"], [2, "amendment-2", "amd2.htm"],
    ]);
    const c2022 = chains.find((c) => c.chainId.includes("june-1-2022"))!;
    expect(c2022.docs.map((d) => d.role)).toEqual(["master", "amendment-1"]);
  });

  test("falls back to earliest amendment as base when no separate base filing is present", () => {
    const docs: DiscDoc[] = [
      doc("x-2", "amd2.htm", "SECOND AMENDMENT TO CREDIT AGREEMENT dated as of March 3, 2021 …"),
      doc("x-1", "amd1.htm", "FIRST AMENDMENT TO CREDIT AGREEMENT dated as of March 3, 2021 …"),
    ];
    const [chain] = reconstructChains("1", docs);
    // No base filing -> earliest amendment becomes order 0 (resolveChain treats ordered[0] as master).
    expect(chain.docs.map((d) => [d.order, d.role])).toEqual([[0, "amendment-1"], [1, "amendment-2"]]);
  });

  test("sets unitType to the placeholder 'unknown' (score.ts produces the authoritative value)", () => {
    const [chain] = reconstructChains("1", [doc("x-1", "a.htm", "FIRST AMENDMENT TO CREDIT AGREEMENT dated as of March 3, 2021 …")]);
    expect(chain.unitType).toBe("unknown");
  });
});
