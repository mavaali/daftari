// Real-prose direction + symmetric-emission validation GATE (Task 0 of the
// derives_from-direction plan; §4 of the design spec).
//
// Two questions, both at temp 0 (the pinned production setting, spec §3.1):
//   1. Directional: on ~28 REAL-PROSE premise->conclusion pairs (from exp1's
//      draft_novel.json), does the foundational-ordering prompt recover direction
//      at >=85% accuracy with DOC1-bias in [40%,60%]? (each pair shown both orders)
//   2. Symmetric: on ~10 hand-built genuinely-mutual pairs (each claim conditions
//      the other), does the prompt return `symmetric` on a MAJORITY?
//
// Kill conditions (plan Task 0 Step 4):
//   - directional accuracy < 85%, OR DOC1-bias outside [40%,60%]  -> STOP
//   - symmetric emission not a majority of mutual pairs           -> STOP

import { readFileSync, writeFileSync } from "node:fs";

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY || !API_KEY.startsWith("sk-or-")) {
  console.error("FATAL: OPENROUTER_API_KEY missing/malformed.");
  process.exit(1);
}

const PAIRS_FILE = process.argv[2] || "scripts/pools/v2/direction-realprose-pairs.json";
const RESULTS_FILE = process.argv[3] || "scripts/pools/v2/direction-realprose.results.json";
const PAIRS = JSON.parse(readFileSync(PAIRS_FILE, "utf-8"));
const directional = PAIRS.directional;
const symmetric = PAIRS.symmetric;
console.log(`pairs: ${PAIRS_FILE}  (${directional.length} directional, ${symmetric.length} symmetric)`);

// The production prompt is the foundational-ordering one (spec §3.1 / Task 2).
const MODELS = ["anthropic/claude-haiku-4.5", "openai/gpt-4o", "google/gemini-2.5-flash"];
const FOUNDATIONAL =
  "You are given two related claims, DOC1 and DOC2. Which one is more FOUNDATIONAL — which would have to be established FIRST for the other to make sense? " +
  "That foundational claim is the PREMISE. If each claim depends on the other so that neither could be established first, answer symmetric. " +
  'Return ONLY JSON: {"premise":"DOC1"|"DOC2"|"symmetric","reason":"<one sentence>"}.';

function parsePremise(content) {
  if (typeof content !== "string") return null;
  const m = content.match(/\{[\s\S]*?"premise"[\s\S]*?\}/);
  for (const c of [m ? m[0] : null, content].filter(Boolean)) {
    try {
      const v = JSON.parse(c).premise;
      if (v === "DOC1" || v === "DOC2" || v === "symmetric") return v;
    } catch {}
  }
  return null;
}

async function ask(model, system, doc1, doc2) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 800,
          temperature: 0,
          messages: [
            { role: "system", content: system },
            { role: "user", content: `DOC1:\n${doc1}\n\nDOC2:\n${doc2}` },
          ],
        }),
      });
      if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 800 * 2 ** i)); continue; }
      if (!res.ok) return null;
      const j = await res.json();
      return parsePremise(j?.choices?.[0]?.message?.content);
    } catch { await new Promise((r) => setTimeout(r, 800 * 2 ** i)); }
  }
  return null;
}

const dirRows = [];
const symRows = [];
for (const model of MODELS) {
  const mshort = model.split("/")[1];

  // --- directional: both orders, foundational prompt ---
  let correct = 0, trials = 0, doc1picks = 0, consistent = 0, pairsScored = 0, errs = 0;
  for (const p of directional) {
    const a = await ask(model, FOUNDATIONAL, p.premise, p.conclusion); // premise@DOC1
    const b = await ask(model, FOUNDATIONAL, p.conclusion, p.premise); // premise@DOC2
    if (a === null || b === null) errs++;
    for (const [ans, correctPos] of [[a, "DOC1"], [b, "DOC2"]]) {
      if (ans === null) continue;
      trials++;
      if (ans === "DOC1") doc1picks++;
      if (ans === correctPos) correct++;
    }
    if (a && b && a !== "symmetric" && b !== "symmetric") {
      pairsScored++;
      if ((a === "DOC1") === (b === "DOC2")) consistent++;
    }
  }
  const acc = trials ? correct / trials : 0;
  const bias = trials ? doc1picks / trials : 0;
  const cons = pairsScored ? consistent / pairsScored : 0;
  dirRows.push({ model: mshort, acc, bias, cons, trials, errs });
  console.log(
    `[DIR] ${mshort.padEnd(20)} acc ${(acc * 100).toFixed(0)}%  order-consistency ${(cons * 100).toFixed(0)}%  DOC1-bias ${(bias * 100).toFixed(0)}%  (n=${trials}${errs ? ", errs " + errs : ""})`,
  );

  // --- symmetric: each mutual pair shown both orders; symmetric in EITHER order counts as caught ---
  let symCaught = 0, symTrials = 0, symErrs = 0;
  for (const p of symmetric) {
    const a = await ask(model, FOUNDATIONAL, p.a, p.b);
    const b = await ask(model, FOUNDATIONAL, p.b, p.a);
    if (a === null && b === null) { symErrs++; continue; }
    symTrials++;
    if (a === "symmetric" || b === "symmetric") symCaught++;
  }
  const symRate = symTrials ? symCaught / symTrials : 0;
  symRows.push({ model: mshort, symCaught, symTrials, symRate, symErrs });
  console.log(
    `[SYM] ${mshort.padEnd(20)} symmetric-emission ${symCaught}/${symTrials} (${(symRate * 100).toFixed(0)}%)${symErrs ? ", errs " + symErrs : ""}`,
  );
}

writeFileSync(
  RESULTS_FILE,
  JSON.stringify({ pairsFile: PAIRS_FILE, directionalPairs: directional.length, symmetricPairs: symmetric.length, dirRows, symRows }, null, 2),
);
console.log(`\nGate: directional acc>=85% & DOC1-bias in [40,60]; symmetric-emission majority of mutual pairs.`);
