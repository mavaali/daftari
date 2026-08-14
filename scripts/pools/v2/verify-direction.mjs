// Spot-check the surprising result: does gemini REALLY recover direction with the
// foundational prompt (it was "direction-blind" under the derives/depends token)?
// Print raw answers for 3 pairs, both orders, gemini + the broken 'direct' method
// for contrast.
import { readFileSync } from "node:fs";
const API_KEY = process.env.OPENROUTER_API_KEY;
const dependsPool = JSON.parse(readFileSync("scripts/pools/v2/depends-pool-v2.json", "utf-8"));
const pairs = dependsPool.slice(0, 3).map((c) => ({ id: c.id, premise: c.fromContent, conclusion: c.toContent }));

const FOUND =
  "Two related claims, DOC1 and DOC2. Which one is more FOUNDATIONAL — which would have to be established FIRST for the other to make sense? That foundational claim is the PREMISE. " +
  'Return ONLY JSON: {"premise":"DOC1"|"DOC2"|"symmetric","reason":"<one sentence>"}.';

async function ask(model, system, d1, d2) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 600, temperature: 0, messages: [
      { role: "system", content: system }, { role: "user", content: `DOC1:\n${d1}\n\nDOC2:\n${d2}` }] }),
  });
  const j = await res.json();
  return j?.choices?.[0]?.message?.content?.replace(/\s+/g, " ").slice(0, 180);
}

for (const p of pairs) {
  console.log(`\n=== ${p.id}  (TRUTH: premise = "${p.premise.slice(0, 45)}...")`);
  console.log(`  order A (DOC1=premise, DOC2=conclusion) -> correct = DOC1`);
  console.log(`    gemini foundational: ${await ask("google/gemini-2.5-flash", FOUND, p.premise, p.conclusion)}`);
  console.log(`  order B (DOC1=conclusion, DOC2=premise) -> correct = DOC2`);
  console.log(`    gemini foundational: ${await ask("google/gemini-2.5-flash", FOUND, p.conclusion, p.premise)}`);
}
