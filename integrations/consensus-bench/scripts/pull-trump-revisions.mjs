// pull-trump-revisions.mjs — one-shot: pull article revision summaries via the
// Wikipedia API (unthrottled, no auth; descriptive User-Agent) and write the
// real fixture. Run manually: `node integrations/consensus-bench/scripts/pull-trump-revisions.mjs`
import { writeFileSync } from "node:fs";

const API = "https://en.wikipedia.org/w/api.php";
const UA = "daftari-research mihir.wagle@gmail.com";
const TITLE = "Donald Trump";
const MAX = 5000; // cap; paginate via rvcontinue

async function main() {
  const out = [];
  let cont = undefined;
  while (out.length < MAX) {
    const params = new URLSearchParams({
      action: "query", format: "json", prop: "revisions", titles: TITLE,
      rvprop: "ids|timestamp|user|comment", rvlimit: "500", rvdir: "older",
    });
    if (cont) params.set("rvcontinue", cont);
    const res = await fetch(`${API}?${params}`, { headers: { "User-Agent": UA } });
    const json = await res.json();
    const pages = json.query?.pages ?? {};
    const page = Object.values(pages)[0];
    for (const r of page?.revisions ?? []) {
      out.push({ revid: r.revid, parentid: r.parentid, timestamp: r.timestamp, user: r.user ?? "", comment: r.comment ?? "" });
    }
    cont = json.continue?.rvcontinue;
    if (!cont) break;
  }
  const path = new URL("../src/__fixtures__/trump-revisions.json", import.meta.url);
  writeFileSync(path, JSON.stringify(out, null, 0));
  console.log(`wrote ${out.length} revisions`);
}
main();
