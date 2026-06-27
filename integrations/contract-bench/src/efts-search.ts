// efts-search — query EDGAR full-text search (efts.sec.gov) and normalize hits.
// Endpoint verified live: https://efts.sec.gov/LATEST/search-index?q=<phrase>&forms=<f>&ciks=<10-digit>&from=<n>
// Each hit: _id = "<accession>:<filename>", _source.{ciks[], root_forms[], file_date}.
// Result window caps at 10000; ~100 hits/page. Parsing is pure; the network call
// uses an injectable curl transport (same pattern as edgar-fetch).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface EftsHit {
  cik: string;
  accession: string;
  filename: string;
  formType: string;
  fileDate: string;
}

interface RawEfts { hits?: { hits?: Array<{ _id?: string; _source?: { ciks?: string[]; root_forms?: string[]; file_date?: string } }> } }

export function parseEftsResponse(json: unknown): EftsHit[] {
  const hits = (json as RawEfts).hits?.hits ?? [];
  const out: EftsHit[] = [];
  for (const h of hits) {
    const id = h._id ?? "";
    const colon = id.indexOf(":");
    if (colon < 0) continue;
    const cik = h._source?.ciks?.[0];
    const filename = id.slice(colon + 1);
    if (!cik || !filename) continue;
    out.push({
      cik,
      accession: id.slice(0, colon),
      filename,
      formType: h._source?.root_forms?.[0] ?? "",
      fileDate: h._source?.file_date ?? "",
    });
  }
  return out;
}

export type Transport = (url: string, userAgent: string) => Promise<string>;

const curlTransport: Transport = async (url, userAgent) => {
  const { stdout } = await execFileP("curl", ["-sS", "--fail", "--max-time", "40", "-A", userAgent, url], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
  return stdout;
};

const EFTS = "https://efts.sec.gov/LATEST/search-index";
const WINDOW_CAP = 10000;

export interface SearchOpts {
  userAgent: string;
  forms?: string;
  ciks?: string;
  maxHits?: number;
  transport?: Transport;
  throttleMs?: number;
}

export async function searchFullText(query: string, opts: SearchOpts): Promise<{ ok: true; hits: EftsHit[] } | { ok: false; error: string }> {
  const transport = opts.transport ?? curlTransport;
  const max = Math.min(opts.maxHits ?? 1000, WINDOW_CAP);
  const buildUrl = (from: number) => {
    const p = new URLSearchParams({ q: `"${query}"`, from: String(from) });
    if (opts.forms) p.set("forms", opts.forms);
    if (opts.ciks) p.set("ciks", opts.ciks);
    return `${EFTS}?${p.toString()}`;
  };
  const all: EftsHit[] = [];
  try {
    let from = 0;
    while (all.length < max) {
      const page = parseEftsResponse(JSON.parse(await transport(buildUrl(from), opts.userAgent)));
      if (page.length === 0) break;
      all.push(...page);
      from += page.length; // robust to EFTS's actual page size
      if (opts.throttleMs) await new Promise((r) => setTimeout(r, opts.throttleMs));
    }
    return { ok: true, hits: all.slice(0, max) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
