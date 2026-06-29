#!/usr/bin/env node
// provenance-eval-runner — Experiment 1 for framing (A), Claim 3 (provenance):
// daftari surfaces, per clause, the governing source + the full ordered amendment
// history, DETERMINISTICALLY (resolveChain; spot-check-verified correct). Can an
// LLM reading the same raw amendments reproduce that provenance, or does it err?
// If the LLM matches, daftari's provenance is "just ask an LLM"; if it errs (history
// omissions, ordering, or the partial-edit-doesn't-govern subtlety), daftari's
// deterministic provenance is the distinguishing capability. Needs OPENROUTER_API_KEY.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const SEED = 20260627;
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODELS = ["openai/gpt-4o", "google/gemini-2.5-flash"];
if (!API_KEY) { console.error("FATAL: OPENROUTER_API_KEY unset"); process.exit(1); }

const { buildChainDocs } = await import(`${DIST}/chain-docs.js`);
const { assemble } = await import(`${DIST}/assemble.js`);
const { resolveChain } = await import(`${DIST}/clause-edge.js`);

const seed = { chainId: "ngs", unitType: "mixed", docs: [
  { id: "master", order: 0, role: "master", cik: "0001084991", accession: "0001084991-23-000019", filename: "exhibit101tcbamendedandres.htm" },
  { id: "amendment-1", order: 1, role: "amendment-1", cik: "0001084991", accession: "0001084991-23-000124", filename: "exhibit101firstamendmentto.htm" },
  { id: "amendment-2", order: 2, role: "amendment-2", cik: "0001084991", accession: "0001084991-24-000066", filename: "exhibit101_secondamendme.htm" },
  { id: "amendment-3", order: 3, role: "amendment-3", cik: "0001084991", accession: "0001084991-24-000080", filename: "exhibit101thirdamendment.htm" },
  { id: "amendment-4", order: 4, role: "amendment-4", cik: "0001084991", accession: "0001084991-25-000044", filename: "exhibit101_fourthxamendm.htm" },
] };

// non-trivial clauses (multi-touch history and/or partial-edit subtlety)
const CLAUSES = ["Commitment", "Loan Documents", "8.1", "Payment Conditions", "11.25", "2.10(a)"];

async function call(model, system, user) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 1500, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const j = await res.json();
  return j?.choices?.[0]?.message?.content ?? "";
}

const norm = (s) => String(s).toLowerCase().replace(/amendment\s*-?\s*/g, "amendment-").replace(/[^a-z0-9-]/g, "");
const histEq = (a, b) => a.length === b.length && a.every((x, i) => norm(x) === norm(b[i]));
const setEq = (a, b) => a.length === b.length && [...a].map(norm).sort().join("|") === [...b].map(norm).sort().join("|");

const built = await buildChainDocs(seed, { cacheDir: join(HERE, ".edgar-cache"), userAgent: "x" });
if (!built.ok) { console.error("build failed:", built.error); process.exit(1); }
const asm = assemble(built.docs, { seed: SEED });
const truth = new Map(resolveChain(asm.perturbedDocs).map((r) => [r.clause, { governing: r.governingDoc, history: r.history }]));

// Build the LLM context: the four perturbed amendments (the master/base is huge and
// is the origin for restate/partial; we tell the model master = the original agreement).
const amdText = asm.perturbedDocs.filter((d) => d.order > 0)
  .map((d) => `=== ${d.id} ===\n${d.text.slice(0, 22000)}`).join("\n\n");
const SYSTEM = "You are a contract provenance analyst. Use ONLY the provided amendment texts. The original agreement is 'master'.";
const user =
  `${amdText}\n\n` +
  `For each clause below, determine its provenance under these rules:\n` +
  `- "governing" = the document establishing the CURRENT authoritative full value. A clause that is only PARTIALLY edited (e.g. "the last paragraph of…", "the first sentence of…") is NOT fully established by that edit; if the most recent edit is partial, governing stays at the last document that gave a FULL value (often "master").\n` +
  `- "history" = every document that modified the clause, earliest to latest, INCLUDING "master" when the clause pre-existed (restate/partial presuppose it existed; an 'add' originates it).\n` +
  `Clauses: ${CLAUSES.map((c) => `"${c}"`).join(", ")}\n` +
  `Return ONLY JSON: {"<clause>": {"governing": "<doc>", "history": ["<doc>", ...]}, ...}`;

function parseJson(s) {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const body = fence ? fence[1] : (s.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
  try { return JSON.parse(body); } catch { return {}; }
}

console.log("=== provenance: LLM vs daftari (deterministic, = verified ground truth) ===\n");
const summary = {};
for (const model of MODELS) {
  let out = {};
  try { out = parseJson(await call(model, SYSTEM, user)); } catch (e) { console.log(`${model}: ERROR ${e.message}`); continue; }
  let govOK = 0, histOK = 0;
  console.log(`--- ${model} ---`);
  for (const c of CLAUSES) {
    const t = truth.get(c);
    const a = out[c] || {};
    const g = norm(a.governing || "") === norm(t.governing);
    const h = Array.isArray(a.history) && histEq(a.history, t.history);
    const hset = Array.isArray(a.history) && setEq(a.history, t.history);
    if (g) govOK++; if (h) histOK++;
    console.log(`  ${c.padEnd(20)} gov ${g ? "OK " : "XX "}(llm=${a.governing ?? "?"} vs ${t.governing}) | hist ${h ? "OK " : hset ? "SET(order off) " : "XX "}(llm=[${(a.history || []).join(",")}] vs [${t.history.join(",")}])`);
  }
  summary[model] = { govOK, histOK, n: CLAUSES.length };
  console.log("");
}
console.log("=== summary (daftari: gov 6/6, history 6/6 — deterministic, spot-check-verified) ===");
for (const m of MODELS) if (summary[m]) console.log(`   ${m}: governing ${summary[m].govOK}/${summary[m].n}, history ${summary[m].histOK}/${summary[m].n}`);
import("node:fs").then((fs) => fs.writeFileSync("/tmp/contract-bench/provenance.json", JSON.stringify({ truth: [...truth], summary }, null, 2)));
