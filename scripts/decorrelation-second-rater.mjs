// Blind cross-family second-rater for the decorrelation fixture.
//
// Integrity purpose: the fixture is Claude-built and will be Claude-judged
// (Haiku) by the real report. This script asks INDEPENDENT model families
// (OpenAI, Google) to judge each pair BLIND — they see only the two doc
// contents and the report's own directional question, never the hand-assigned
// truth label or rationale. Their verdict is directly comparable to ground
// truth. Disagreements flag pairs to scrutinize before scaling to 50.
//
// This does NOT touch Daftari's Anthropic-only client; it is a labeling aid,
// run out-of-band. Usage:
//   node scripts/decorrelation-second-rater.mjs [fixturePath]

import { readFileSync } from "node:fs";

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY || !API_KEY.startsWith("sk-or-")) {
  console.error(
    "FATAL: OPENROUTER_API_KEY missing or malformed (expected sk-or- prefix). " +
      "Set it in ~/.zshenv. Refusing to send an empty/invalid key to the API.",
  );
  process.exit(1);
}

const FIXTURE_PATH = process.argv[2] ?? "test/fixtures/decorrelation-fixture.json";
const RATERS = ["openai/gpt-4o", "google/gemini-2.5-flash"];

// Mirror the report's construct exactly (src/consolidate/decorrelation.ts
// SYSTEM_BASE + the forward template), so a rater verdict is comparable to the
// fixture truth label. Blind: no label, no rationale, no edgeClass.
const SYSTEM =
  "You evaluate whether one document's central claim derives from another's. " +
  "A 'derivation' means the first claim depends on the second as a load-bearing premise — " +
  "not a passing reference, not a citation, not a co-occurrence, not mere shared topic. " +
  "Be conservative: when the dependence is shallow, ambiguous, or the two claims merely " +
  "share a theme or contradict each other, return 'neither'.\n\n" +
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

async function rate(model, a, b) {
  let res;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
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
  } catch (e) {
    return { verdict: "error", reason: `network: ${e.message}` };
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { verdict: "error", reason: `http ${res.status}: ${txt.slice(0, 160)}` };
  }
  let json;
  try {
    json = await res.json();
  } catch (e) {
    return { verdict: "error", reason: `non-json response: ${e.message}` };
  }
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    return { verdict: "error", reason: `unexpected shape: ${JSON.stringify(json).slice(0, 160)}` };
  }
  // Extract the first balanced JSON object — tolerant of code fences,
  // surrounding prose, and an unterminated trailing fence (reasoning models
  // sometimes get cut mid-fence). Try fenced body first, then first {...}.
  const fence = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const brace = content.match(/\{[\s\S]*?"verdict"[\s\S]*?\}/);
  if (brace) candidates.push(brace[0]);
  candidates.push(content);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      const v = parsed.verdict;
      if (v === "derives" || v === "depends" || v === "neither") {
        return { verdict: v, reason: String(parsed.reason ?? "").slice(0, 200) };
      }
    } catch {
      // try next candidate
    }
  }
  return { verdict: "error", reason: `unparseable: ${content.slice(0, 160)}` };
}

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf-8"));
console.log(`second-rater: ${fixture.edges.length} edges × ${RATERS.length} families\n`);

let agree = 0;
let total = 0;
const disagreements = [];

for (const e of fixture.edges) {
  const votes = {};
  for (const model of RATERS) {
    votes[model] = await rate(model, e.fromContent, e.toContent);
  }
  const line = RATERS.map((m) => {
    const v = votes[m];
    const mark = v.verdict === e.truth ? "✓" : v.verdict === "error" ? "⚠" : "✗";
    return `${m.split("/")[1]}:${v.verdict}${mark}`;
  }).join("  ");
  console.log(`${e.id}  truth=${e.truth.padEnd(8)} ${line}`);
  for (const m of RATERS) {
    const v = votes[m];
    if (v.verdict === "error") {
      console.log(`     ⚠ ${m}: ${v.reason}`);
      continue;
    }
    total++;
    if (v.verdict === e.truth) agree++;
    else {
      disagreements.push({ id: e.id, truth: e.truth, model: m, got: v.verdict, reason: v.reason });
      console.log(`     ✗ ${m} said ${v.verdict}: ${v.reason}`);
    }
  }
}

console.log(`\n--- agreement: ${agree}/${total} rater-votes match ground truth ---`);
if (disagreements.length === 0) {
  console.log("No disagreements — every non-Claude family confirms every label.");
} else {
  console.log(`\n${disagreements.length} disagreement(s) to scrutinize:`);
  for (const d of disagreements) {
    console.log(`  ${d.id}: I labeled ${d.truth}, ${d.model.split("/")[1]} said ${d.got}`);
  }
}
