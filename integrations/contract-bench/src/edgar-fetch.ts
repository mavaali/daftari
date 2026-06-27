// edgar-fetch — resolve a filing reference to its SEC Archives URL (pure) and
// fetch it via curl with a compliant User-Agent + on-disk cache (IO). The
// transport is injectable so cache logic is testable without the network.

export interface FilingRef {
  cik: string;
  accession: string;
  filename: string;
}

export function filingUrl(ref: FilingRef): string {
  const acc = ref.accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${ref.cik}/${acc}/${ref.filename}`;
}
