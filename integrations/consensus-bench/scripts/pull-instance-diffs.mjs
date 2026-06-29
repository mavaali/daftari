// pull-instance-diffs.mjs — one-shot: fetch the compare diff for each post-cutoff
// stale-trap instance (governingNum in [67,76]) and write the CO2 fixture. Run:
//   node integrations/consensus-bench/scripts/pull-instance-diffs.mjs
// The instance list (co2-instances.json) is emitted by the _co2list inspector
// (see the CO2 plan, Task 6 Step 2) from the committed CO1 fixtures.
import { readFileSync, writeFileSync } from "node:fs";

const API = "https://en.wikipedia.org/w/api.php";
const UA = "daftari-research mihir.wagle@gmail.com";

const instances = JSON.parse(readFileSync(new URL("./co2-instances.json", import.meta.url)));

async function diffOf(parentid, revid) {
  const params = new URLSearchParams({
    action: "compare", fromrev: String(parentid), torev: String(revid), format: "json", prop: "diff",
  });
  const res = await fetch(`${API}?${params}`, { headers: { "User-Agent": UA } });
  const json = await res.json();
  return json.compare?.["*"] ?? "";
}

async function main() {
  const out = [];
  for (const i of instances) {
    out.push({
      revid: i.revid, parentid: i.parentid, citedNum: i.citedNum, governingNum: i.governingNum,
      diffHtml: await diffOf(i.parentid, i.revid),
    });
  }
  writeFileSync(new URL("../src/__fixtures__/trump-instance-diffs.json", import.meta.url), JSON.stringify(out, null, 0));
  console.log(`wrote ${out.length} instance diffs`);
}
main();
