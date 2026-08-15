// Cross-family inclusion gate for decorrelation fixture candidates.
//
// Reads a candidate pool (same edge shape as the fixture, with a PROPOSED
// `truth`), asks two independent non-Claude families to judge each pair BLIND
// (3 samples each, majority vote), and reports which candidates pass the gate:
//   PASS  iff BOTH families' majority verdict == the proposed truth label.
//
// For derivation candidates, author them in FORWARD form (correct = 'derives')
// and let the gate confirm both families say 'derives' — this sidesteps the
// derives/depends token-confusion. The 'depends' fixture entries are then made
// by presenting validated derivations reversed (done at assembly, not here).
//
// Emits <pool>.results.json with per-candidate votes + pass flag, and prints a
// compact summary. Does NOT touch Daftari's Anthropic client.
//
// Usage: node scripts/decorrelation-validate-candidates.mjs <poolPath> [samples]

import { readFileSync, writeFileSync } from "node:fs";

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY || !API_KEY.startsWith("sk-or-")) {
  console.error("FATAL: OPENROUTER_API_KEY missing/malformed (expected sk-or- prefix). Set it in ~/.zshenv.");
  process.exit(1);
}

const POOL_PATH = process.argv[2];
if (!POOL_PATH) {
  console.error("usage: node scripts/decorrelation-validate-candidates.mjs <poolPath> [samples]");
  process.exit(1);
}
const SAMPLES = Number(process.argv[3] ?? 3);
const RATERS = ["openai/gpt-4o", "google/gemini-2.5-flash"];

const SYSTEM =
  "You evaluate whether one document's central claim derives from another's. " +
  "A 'derivation' means the first claim depends on the second as a load-bearing premise — " +
  "not a passing reference, not a citation, not a co-occurrence, not mere shared topic, " +
  "not a contradiction. Be conservative: when the dependence is shallow, ambiguous, or the " +
  "two claims merely share a theme, return 'neither'.\n\n" +
  "Verdict space (directional):\n" +
  "  'derives'  = DOC A's central claim depends on DOC B's as a load-bearing premise.\n" +
  "  'depends'  = the reverse: DOC B's central claim depends on DOC A's.\n" +
  "  'neither'  = no load-bearing derivation in either direction.\n" +
  'Return ONLY JSON: {"verdict":"derives|depends|neither","reason":"<one sentence>"}';

function userBody(a, b) {
  return (
    `DOC A:\n${a}\n\nDOC B:\n${b}\n\n` +
    "Does the central claim of DOC A derive from / depend on the central claim of DOC B " +
    "(or vice versa, or neither)? Return JSON."
  );
}

function parseVerdict(content) {
  if (typeof content !== "string") return null;
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const brace = content.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/);
  if (brace) candidates.push(brace[0]);
  candidates.push(content);
  for (const c of candidates) {
    try {
      const v = JSON.parse(c).verdict;
      if (v === "derives" || v === "depends" || v === "neither") return v;
    } catch {
      /* next */
    }
  }
  return null;
}

async function rateOnce(model, a, b) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userBody(a, b) },
        ],
        max_tokens: 900,
        temperature: 0,
      }),
    });
    if (!res.ok) return { verdict: null, err: `http ${res.status}` };
    const json = await res.json();
    const v = parseVerdict(json?.choices?.[0]?.message?.content);
    return { verdict: v, err: v ? null : "unparseable" };
  } catch (e) {
    return { verdict: null, err: `net: ${e.message}` };
  }
}

function majority(verdicts) {
  const counts = {};
  for (const v of verdicts) if (v) counts[v] = (counts[v] ?? 0) + 1;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return { verdict: "all-error", counts };
  if (entries.length > 1 && entries[0][1] === entries[1][1]) return { verdict: "tie", counts };
  return { verdict: entries[0][0], counts };
}

const pool = JSON.parse(readFileSync(POOL_PATH, "utf-8"));
const edges = Array.isArray(pool) ? pool : pool.edges;
console.log(`validating ${edges.length} candidates × ${RATERS.length} families × ${SAMPLES} samples\n`);

const results = [];
let passing = 0;
for (const e of edges) {
  const familyMaj = {};
  for (const model of RATERS) {
    const verdicts = [];
    for (let s = 0; s < SAMPLES; s++) {
      const r = await rateOnce(model, e.fromContent, e.toContent);
      verdicts.push(r.verdict);
    }
    familyMaj[model] = majority(verdicts);
  }
  const pass = RATERS.every((m) => familyMaj[m].verdict === e.truth);
  if (pass) passing++;
  const summary = RATERS.map((m) => {
    const mj = familyMaj[m];
    const mark = mj.verdict === e.truth ? "✓" : "✗";
    const detail = Object.entries(mj.counts).map(([k, n]) => `${k}:${n}`).join(",");
    return `${m.split("/")[1]}=${mj.verdict}${mark}(${detail})`;
  }).join("  ");
  console.log(`${pass ? "PASS" : "FAIL"} ${e.id}  proposed=${e.truth.padEnd(8)} ${summary}`);
  results.push({ id: e.id, proposed: e.truth, pass, familyMaj });
}

const outPath = POOL_PATH.replace(/\.json$/, "") + ".results.json";
writeFileSync(outPath, JSON.stringify({ pool: POOL_PATH, samples: SAMPLES, raters: RATERS, results }, null, 2));
console.log(`\n--- ${passing}/${edges.length} candidates PASS the both-families gate ---`);
console.log(`results written: ${outPath}`);
const survivors = edges.filter((e) => results.find((r) => r.id === e.id)?.pass);
console.log(`survivor ids: ${survivors.map((e) => e.id).join(", ") || "(none)"}`);
