import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync("scripts/pools/v2/decorr-v2-pathonly.report.json", "utf-8"));
const axes = ["forward", "reverse", "contrast"];
for (const a of axes) {
  let dC = 0, dT = 0, nC = 0, nT = 0, saidNeitherOnDeriv = 0;
  for (const p of r.perEdge) {
    const v = p.votes.find((x) => x.axis === a);
    if (!v || v.verdict === "error") continue;
    if (p.truth === "derives") { dT++; if (v.verdict === "derives") dC++; if (v.verdict === "neither") saidNeitherOnDeriv++; }
    else { nT++; if (v.verdict === "neither") nC++; }
  }
  console.log(`${a.padEnd(9)}: derives-correct ${dC}/${dT} (said-neither ${saidNeitherOnDeriv}/${dT})   neither-correct ${nC}/${nT}`);
}
