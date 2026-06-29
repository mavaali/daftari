#!/usr/bin/env node
// Runner: pull a seed's chain from EDGAR (curl + cache) and print a ChainDoc
// summary. Imports the COMPILED build, so run `npx tsc` first.
// Usage: node pull-edgar.mjs seeds/ngs.json
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildChainDocs } from "./dist/chain-docs.js";

const here = dirname(fileURLToPath(import.meta.url));
const seedArg = process.argv[2];
if (!seedArg) {
  console.error("usage: node pull-edgar.mjs <seed.json>");
  process.exit(1);
}
const ua = process.env.EDGAR_UA ?? "Daftari Research (mihir.wagle@gmail.com)";
const seed = JSON.parse(await readFile(resolve(seedArg), "utf8"));

// Seed sanity-check — a hand-edited seed with no docs or duplicate `order`
// values silently corrupts the downstream master/amendment chain resolution.
// Fail loudly here instead.
if (!Array.isArray(seed.docs) || seed.docs.length === 0) {
  console.error("seed error: docs[] is empty");
  process.exit(1);
}
const orders = seed.docs.map((d) => d.order);
if (new Set(orders).size !== orders.length) {
  console.error(`seed error: duplicate order values in ${seed.chainId}`);
  process.exit(1);
}

const r = await buildChainDocs(seed, {
  cacheDir: join(here, ".edgar-cache"),
  userAgent: ua,
  throttleMs: 300,
});
if (!r.ok) {
  console.error("FAILED:", r.error);
  process.exit(1);
}
console.log(`chain ${seed.chainId} — ${r.docs.length} docs`);
for (const d of r.docs) console.log(`  ${d.order}\t${d.id}\t${d.text.length} chars`);
