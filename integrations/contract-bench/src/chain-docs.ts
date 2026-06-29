// chain-docs — turn a hand-authored chain seed into the ChainDoc[] that the
// CB1 assemble() pipeline consumes: fetch each filing (cached), convert its
// HTML to parseCitations-ready text, and order by the seed's `order`.

import type { ChainDoc } from "./clause-edge.js";
import { fetchFiling, type FetchOpts } from "./edgar-fetch.js";
import { htmlToText } from "./html-to-text.js";

export interface SeedDoc {
  id: string;
  order: number;
  role: string;
  cik: string;
  accession: string;
  filename: string;
}

export interface Seed {
  chainId: string;
  unitType: string;
  docs: SeedDoc[];
}

export type BuildResult =
  | { ok: true; docs: ChainDoc[] }
  | { ok: false; error: string };

export async function buildChainDocs(seed: Seed, opts: FetchOpts): Promise<BuildResult> {
  const sorted = [...seed.docs].sort((a, b) => a.order - b.order);
  const docs: ChainDoc[] = [];
  for (const d of sorted) {
    const r = await fetchFiling(d, opts);
    if (!r.ok) return { ok: false, error: `${d.id}: ${r.error}` };
    docs.push({ id: d.id, order: d.order, text: htmlToText(r.html) });
  }
  return { ok: true, docs };
}
