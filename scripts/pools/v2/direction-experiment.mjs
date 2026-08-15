// Direction-elicitation viability experiment (the gate for the direction design).
//
// Question: does ANY elicitation give UNBIASED, above-chance direction signal?
// If no — pure-LLM accrue-and-verify can't work (accumulation amplifies bias),
// and direction must come from structure (or stay manual).
//
// Method: 30 pairs with known premise->conclusion direction, each shown in BOTH
// orders. A content-reliable method picks the same real-world premise regardless
// of order; a biased method flips with position. Three methods x three models,
// temp 0 (we are hunting systematic bias, not noise).

import { readFileSync, writeFileSync } from "node:fs";

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY || !API_KEY.startsWith("sk-or-")) {
  console.error("FATAL: OPENROUTER_API_KEY missing/malformed.");
  process.exit(1);
}

// --- build directional pairs with known {premise, conclusion} ---
const derivPool = JSON.parse(readFileSync("scripts/pools/v2/deriv-pool-v2.json", "utf-8"));
const derivRes = JSON.parse(readFileSync("scripts/pools/v2/deriv-pool-v2.results.json", "utf-8"));
const dependsPool = JSON.parse(readFileSync("scripts/pools/v2/depends-pool-v2.json", "utf-8"));

const pairs = [];
// derives: from=conclusion, to=premise (A derives from B). Use existence-survivors.
for (const c of derivPool) {
  const r = derivRes.results.find((x) => x.id === c.id);
  if (!r || !r.pass) continue;
  pairs.push({ id: c.id, premise: c.toContent, conclusion: c.fromContent });
}
// native depends: from=premise, to=conclusion (B/to derives from A/from).
for (const c of dependsPool) {
  pairs.push({ id: c.id, premise: c.fromContent, conclusion: c.toContent });
}

const MODELS = ["anthropic/claude-haiku-4.5", "openai/gpt-4o", "google/gemini-2.5-flash"];
const METHODS = {
  counterfactual:
    "You are given two related claims, DOC1 and DOC2. One is a load-bearing PREMISE; the other is a CONCLUSION that depends on it. " +
    "Apply this test: if DOC1 were false, would DOC2 still stand? If DOC2 were false, would DOC1 still stand? " +
    "The claim that would COLLAPSE if the other were removed is the dependent conclusion; the claim that still stands on its own is the premise. " +
    'Identify the PREMISE. Return ONLY JSON: {"premise":"DOC1"|"DOC2"|"symmetric","reason":"<one sentence>"}.',
  foundational:
    "You are given two related claims, DOC1 and DOC2. Which one is more FOUNDATIONAL — which would have to be established FIRST for the other to make sense? " +
    "That foundational claim is the PREMISE. " +
    'Return ONLY JSON: {"premise":"DOC1"|"DOC2"|"symmetric","reason":"<one sentence>"}.',
  direct:
    "You are given two related claims, DOC1 and DOC2. If DOC1 derives from DOC2, then DOC2 is the premise. If DOC2 derives from DOC1, then DOC1 is the premise. If neither derives from the other, answer symmetric. " +
    'Return ONLY JSON: {"premise":"DOC1"|"DOC2"|"symmetric","reason":"<one sentence>"}.',
};

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

const rows = [];
for (const model of MODELS) {
  for (const [mname, system] of Object.entries(METHODS)) {
    let correct = 0, trials = 0, doc1picks = 0, consistent = 0, pairsScored = 0, errs = 0;
    for (const p of pairs) {
      // Order A: DOC1=premise, DOC2=conclusion -> correct premise is DOC1.
      const a = await ask(model, system, p.premise, p.conclusion);
      // Order B: DOC1=conclusion, DOC2=premise -> correct premise is DOC2.
      const b = await ask(model, system, p.conclusion, p.premise);
      if (a === null || b === null) { errs++; }
      for (const [ans, correctPos] of [[a, "DOC1"], [b, "DOC2"]]) {
        if (ans === null) continue;
        trials++;
        if (ans === "DOC1") doc1picks++;
        if (ans === correctPos) correct++;
      }
      // order-consistency: did both orders select the SAME real-world claim as premise?
      // Order A premise@DOC1, Order B premise@DOC2. Consistent if a picks the premise-claim AND b picks the premise-claim.
      if (a && b && a !== "symmetric" && b !== "symmetric") {
        pairsScored++;
        const aPickedPremise = a === "DOC1";
        const bPickedPremise = b === "DOC2";
        if (aPickedPremise === bPickedPremise) consistent++;
      }
    }
    const acc = trials ? correct / trials : 0;
    const bias = trials ? doc1picks / trials : 0;
    const cons = pairsScored ? consistent / pairsScored : 0;
    rows.push({ model: model.split("/")[1], method: mname, acc, bias, cons, trials, errs });
    console.log(
      `${model.split("/")[1].padEnd(20)} ${mname.padEnd(14)} acc ${(acc * 100).toFixed(0)}%  order-consistency ${(cons * 100).toFixed(0)}%  DOC1-bias ${(bias * 100).toFixed(0)}%  (n=${trials}${errs ? ", errs " + errs : ""})`,
    );
  }
}

writeFileSync("scripts/pools/v2/direction-experiment.results.json", JSON.stringify({ pairs: pairs.length, rows }, null, 2));
console.log(`\n${pairs.length} pairs x 2 orders x 3 methods x 3 models. Unbiased+reliable target: acc high, consistency high, DOC1-bias ~50%.`);
