// pull-instance-diffs.mjs — one-shot: for each stale-trap instance fetch the
// compare diff (parentid -> revid) AND the revert revision's full content, from
// which it extracts the inline consensus-marker numbers (markerNums) used by Arm C
// for non-circular localization. Run:
//   node integrations/consensus-bench/scripts/pull-instance-diffs.mjs
// The instance list (co2-instances.json) is emitted by the _co2list inspector
// from the committed CO1 fixtures.
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

async function contentOf(revid) {
  const params = new URLSearchParams({
    action: "query", prop: "revisions", revids: String(revid), rvprop: "content", rvslots: "main", format: "json",
  });
  const res = await fetch(`${API}?${params}`, { headers: { "User-Agent": UA } });
  const json = await res.json();
  const page = Object.values(json.query?.pages ?? {})[0];
  return page?.revisions?.[0]?.slots?.main?.["*"] ?? "";
}

// Mirrors extractMarkerNums in src/consensus-marker.ts (source of truth). Markers
// live in consensus-mentioning HTML comments; formats: "#C70" / "consensus 70" /
// "...#Current consensus]], item 70".
const COMMENT_RE = /<!--([\s\S]*?)-->/g;
const NUM_RE = /#C(\d+)\b|consensus\s*#?\s*(\d+)\b|\bitem\s*(\d+)\b/gi;
function extractMarkerNums(content) {
  const nums = new Set();
  for (const c of content.matchAll(COMMENT_RE)) {
    if (!/consensus/i.test(c[1])) continue;
    for (const m of c[1].matchAll(NUM_RE)) nums.add(Number(m[1] ?? m[2] ?? m[3]));
  }
  return [...nums].sort((a, b) => a - b);
}

async function main() {
  const out = [];
  for (const i of instances) {
    const [diffHtml, content] = [await diffOf(i.parentid, i.revid), await contentOf(i.revid)];
    out.push({
      revid: i.revid, parentid: i.parentid, citedNum: i.citedNum, governingNum: i.governingNum,
      diffHtml, markerNums: extractMarkerNums(content),
    });
  }
  writeFileSync(new URL("../src/__fixtures__/trump-instance-diffs.json", import.meta.url), JSON.stringify(out, null, 0));
  console.log(`wrote ${out.length} instance diffs (+markerNums)`);
}
main();
