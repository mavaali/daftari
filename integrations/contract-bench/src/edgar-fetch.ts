// edgar-fetch — resolve a filing reference to its SEC Archives URL (pure) and
// fetch it via curl with a compliant User-Agent + on-disk cache (IO). The
// transport is injectable so cache logic is testable without the network.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";

export interface FilingRef {
  cik: string;
  accession: string;
  filename: string;
}

export function filingUrl(ref: FilingRef): string {
  const acc = ref.accession.replace(/-/g, "");
  return `https://www.sec.gov/Archives/edgar/data/${ref.cik}/${acc}/${ref.filename}`;
}

const execFileP = promisify(execFile);

export type FetchResult =
  | { ok: true; html: string; fromCache: boolean }
  | { ok: false; error: string };

// (url, userAgent) -> raw HTML. Throws on HTTP/transport failure.
export type Transport = (url: string, userAgent: string) => Promise<string>;

// Default transport: curl with --fail (non-2xx -> non-zero exit -> throw). This
// is the path proven to work against SEC fair-access (WebFetch is 403'd).
const curlTransport: Transport = async (url, userAgent) => {
  const { stdout } = await execFileP(
    "curl",
    ["-sS", "--fail", "--max-time", "40", "-A", userAgent, url],
    { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
  );
  return stdout;
};

export interface FetchOpts {
  cacheDir: string;
  userAgent: string;
  transport?: Transport;
  throttleMs?: number;
}

function cacheKey(ref: FilingRef): string {
  return `${ref.accession}-${ref.filename}`.replace(/[^\w.-]/g, "_");
}

export async function fetchFiling(ref: FilingRef, opts: FetchOpts): Promise<FetchResult> {
  const cachePath = join(opts.cacheDir, cacheKey(ref));
  if (existsSync(cachePath)) {
    try {
      return { ok: true, html: await readFile(cachePath, "utf8"), fromCache: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const transport = opts.transport ?? curlTransport;
  try {
    const html = await transport(filingUrl(ref), opts.userAgent);
    await mkdir(opts.cacheDir, { recursive: true });
    const tmp = `${cachePath}.tmp`;
    await writeFile(tmp, html);
    await rename(tmp, cachePath);
    // Space out live SEC calls for fair-access; cache hits don't throttle.
    if (opts.throttleMs) await new Promise((res) => setTimeout(res, opts.throttleMs));
    return { ok: true, html, fromCache: false };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
