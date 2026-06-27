#!/usr/bin/env node
// Runner: discover EDGAR amendment chains for a broad query and emit a ranked
// candidate set + the unrecoverable-rate distribution. Imports the COMPILED
// build — run `npx tsc` first.
// Usage: node discover-edgar.mjs "Amendment to Credit Agreement" [topCiks] [maxUnrecoverable]
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { searchFullText } from "./dist/efts-search.js";
import { tallyCiks } from "./dist/cik-tally.js";
import { reconstructChains } from "./dist/reconstruct.js";
import { scoreChain } from "./dist/score.js";
import { rankCandidates } from "./dist/select.js";
import { fetchFiling } from "./dist/edgar-fetch.js";
import { htmlToText } from "./dist/html-to-text.js";
import { parseCitations } from "./dist/citation-parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const query = process.argv[2];
if (!query) { console.error('usage: node discover-edgar.mjs "<query>" [topCiks] [maxUnrecoverable]'); process.exit(1); }
const topCiks = Number(process.argv[3] ?? 15);
const maxUnrecoverable = Number(process.argv[4] ?? 0.2);
const ua = process.env.EDGAR_UA ?? "Daftari Research (mihir.wagle@gmail.com)";
const cacheDir = join(here, ".edgar-cache");
const outDir = join(here, ".discover-out");

// EFTS/Archives misbehave under sustained load in two ways: (a) sporadic 5xx,
// and (b) — the one that bit the first dense run — HTTP 200 with an EMPTY body
// (SEC's fair-access throttle serves blanks instead of 429/503). searchFullText/
// fetchFiling have no internal retry AND fetchFiling caches whatever the transport
// returns, so an empty 200 was written to .edgar-cache as a permanent valid 0-byte
// doc — poisoning every re-run (846/851 files came back empty, 0 chains scored).
// This injected transport (runner-only; uses the modules' designed `transport`
// seam, no src change) RETRIES on both: explicit transient signatures AND an
// empty/whitespace-only body. By throwing on an empty body instead of returning
// it, fetchFiling never caches the poison. A real 4xx (e.g. 404 missing filing)
// still fails fast so it isn't masked.
const execFileP = promisify(execFile);
const isTransient = (msg) => /\b(500|502|503|504)\b|Internal server error|reset by peer|Operation timed out|timed out|Could not resolve host|empty body|curl: \(56\)|curl: \(28\)|curl: \(52\)|curl: \(35\)/i.test(msg);
async function retryingTransport(url, userAgent) {
  const maxAttempts = 6;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { stdout } = await execFileP("curl", ["-sS", "--fail", "--max-time", "40", "-A", userAgent, url], { maxBuffer: 64 * 1024 * 1024, encoding: "utf8" });
      // Empty/whitespace-only 200 == SEC throttle blank. Treat as transient so it
      // is retried, never returned (so fetchFiling won't cache a 0-byte doc).
      if (stdout.trim().length === 0) throw new Error("empty body (SEC throttle blank 200)");
      return stdout;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (attempt === maxAttempts || !isTransient(msg)) throw e;
      const backoff = 800 * attempt; // 0.8s, 1.6s, 2.4s, 3.2s, 4s — back off harder on throttle
      console.error(`  [retry ${attempt}/${maxAttempts - 1}] transient EDGAR error, waiting ${backoff}ms: ${msg.split("\n")[0].slice(0, 120)}`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

const fetchOpts = { cacheDir, userAgent: ua, throttleMs: 300, transport: retryingTransport };

// 1. broad query -> tally CIKs
const broad = await searchFullText(query, { userAgent: ua, forms: "8-K", maxHits: 1000, throttleMs: 300, transport: retryingTransport });
if (!broad.ok) { console.error("broad search FAILED:", broad.error); process.exit(1); }
const ciks = tallyCiks(broad.hits).slice(0, topCiks);
console.log(`tallied ${tallyCiks(broad.hits).length} CIKs from ${broad.hits.length} hits; taking top ${ciks.length}`);

// 2. per CIK: fetch amendment exhibits -> reconstruct -> score
const scores = [];
const seedsById = new Map();
for (const { cik } of ciks) {
  const per = await searchFullText(query, { userAgent: ua, ciks: cik.padStart(10, "0"), maxHits: 200, throttleMs: 300, transport: retryingTransport });
  if (!per.ok) { console.error(`  ${cik}: search failed: ${per.error}`); continue; }
  // fetch each exhibit's text
  const discDocs = [];
  for (const h of per.hits) {
    const r = await fetchFiling({ cik, accession: h.accession, filename: h.filename }, fetchOpts);
    if (r.ok) discDocs.push({ ref: { cik, accession: h.accession, filename: h.filename }, text: htmlToText(r.html) });
  }
  for (const seed of reconstructChains(cik, discDocs)) {
    const sc = await scoreChain(seed, fetchOpts);
    if (sc.ok) { scores.push(sc.score); seedsById.set(seed.chainId, seed); }
  }
}

// 3. rank + write outputs
const { selected, distribution } = rankCandidates(scores, { minLength: 3, maxUnrecoverable });
await mkdir(join(outDir, "seeds"), { recursive: true });
await mkdir(join(outDir, "pairs"), { recursive: true });
const manifest = scores.map((s) => ({ ...s, selected: selected.some((x) => x.chainId === s.chainId) }));
await writeFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
await writeFile(join(outDir, "distribution.md"), renderDistribution(distribution, selected.length));
for (const s of selected) {
  const seed = seedsById.get(s.chainId);
  await writeFile(join(outDir, "seeds", `${s.chainId}.json`), JSON.stringify({ ...seed, unitType: s.unitType }, null, 2));
  // pairs dump: parseCitations annotations per amendment, from cache (no new network)
  const lines = [];
  for (const d of seed.docs) {
    if (d.order === 0) continue;
    const r = await fetchFiling({ cik: d.cik, accession: d.accession, filename: d.filename }, fetchOpts);
    if (r.ok) for (const c of parseCitations(htmlToText(r.html))) lines.push(`${d.role}\t${c.clause}\t${c.op}\t${c.recoverable}`);
  }
  await writeFile(join(outDir, "pairs", `${s.chainId}.md`), lines.join("\n") + "\n");
}
console.log(`\nscored ${scores.length} chains; selected ${selected.length} (rate<=${maxUnrecoverable}, length>=3)`);
console.log(`outputs in ${outDir}/ (manifest.json, distribution.md, seeds/, pairs/)`);
for (const s of selected) console.log(`  ${s.unrecoverableRate.toFixed(2)}\t${s.unitType}\tlen=${s.length}\t${s.chainId}`);

function renderDistribution(d, selectedCount) {
  const buckets = Object.keys(d.rateBuckets).sort();
  return [
    `# Unrecoverable-rate distribution (${d.total} chains scored, ${selectedCount} selected)`, "",
    "## Rate buckets", ...buckets.map((b) => `- ${b}: ${d.rateBuckets[b]}`), "",
    "## Unit types", ...Object.entries(d.unitTypeCounts).map(([k, v]) => `- ${k}: ${v}`), "",
  ].join("\n");
}
