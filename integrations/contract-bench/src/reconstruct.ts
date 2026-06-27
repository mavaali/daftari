// reconstruct — group a CIK's amendment exhibits into chains by their preamble
// (agreementType, baseDate) signature, order by ordinal, and identify the base
// filing (else fall back to the earliest amendment as master). Emits E1-format
// Seeds. unitType is a placeholder here ("unknown"); score.ts produces the
// authoritative value. SeedDoc.role follows E1's convention:
// base -> "master", ordinal N -> "amendment-N".
import type { Seed, SeedDoc } from "./chain-docs.js";
import type { FilingRef } from "./edgar-fetch.js";
import { parsePreamble, type Preamble } from "./preamble.js";

export interface DiscDoc {
  ref: FilingRef;
  text: string;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function seedDoc(ref: FilingRef, order: number, role: string): SeedDoc {
  // id == role: unique within one chain (the only scope buildChainDocs/parseCitations
  // use it in), not globally unique across a CIK's chains.
  return { id: role, order, role, cik: ref.cik, accession: ref.accession, filename: ref.filename };
}

export function reconstructChains(cik: string, docs: DiscDoc[]): Seed[] {
  const amendments: { doc: DiscDoc; pre: Preamble }[] = [];
  const others: DiscDoc[] = [];
  for (const d of docs) {
    const pre = parsePreamble(d.text);
    if (pre) amendments.push({ doc: d, pre });
    else others.push(d);
  }
  const groups = new Map<string, { doc: DiscDoc; pre: Preamble }[]>();
  for (const a of amendments) {
    const key = `${a.pre.agreementType.toLowerCase()}|${a.pre.baseDate}`;
    const g = groups.get(key);
    if (g) g.push(a); else groups.set(key, [a]);
  }
  const seeds: Seed[] = [];
  for (const [key, group] of groups) {
    const baseDate = key.split("|")[1];
    const agreementType = group[0].pre.agreementType;
    group.sort((x, y) => x.pre.ordinal - y.pre.ordinal); // duplicate ordinals (re-filings) sort non-deterministically — assumed absent in clean EDGAR data
    // NOTE: `find` (not removal) means one `others` doc can be claimed as master by
    // more than one chain — e.g. an omnibus base filing referencing two base dates.
    // Left unguarded (claiming-order would be Map-iteration-dependent); watch for
    // inflated chain counts / shared masters in the Task 8 live run.
    const base = others.find((o) =>
      o.text.includes(baseDate) && new RegExp(esc(agreementType), "i").test(o.text.slice(0, 3000)),
    );
    const seedDocs: SeedDoc[] = [];
    let order = 0;
    if (base) seedDocs.push(seedDoc(base.ref, order++, "master"));
    // Amendments-only fallback: with no base filing, order starts at 0 on the
    // first amendment, so it becomes the order-0 master baseline for resolveChain
    // while its role stays honest ("amendment-1").
    for (const a of group) seedDocs.push(seedDoc(a.doc.ref, order++, `amendment-${a.pre.ordinal}`));
    seeds.push({
      chainId: `${cik}-${slug(agreementType)}-${slug(baseDate)}`,
      unitType: "unknown",
      docs: seedDocs,
    });
  }
  return seeds;
}
