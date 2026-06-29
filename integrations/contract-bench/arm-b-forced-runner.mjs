#!/usr/bin/env node
// arm-b-forced-runner — Experiment 2 for framing (A): sharpen the Arm B (minting
// foil) result. Two conditions on the same partial/unrecoverable clauses:
//   ABSTAIN  — the model MAY decline ("NOT FULLY RECOVERABLE") [the conservative test]
//   FORCED   — the model MUST state the current clause [the real consolidation shape]
// Larger N (all partial clauses across NGS + PetroQuest), 2 cross-family foils,
// and a BLIND CROSS-JUDGE (each foil's forced answer judged by the OTHER foil) to
// classify asserted-complete-clause (fabrication) vs flagged-partial. daftari = 0
// fabrication by design (resolveChain leaves a partial clause clean:false, points
// to source). Needs OPENROUTER_API_KEY.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const SEED = 20260627;
const cacheDir = join(HERE, ".edgar-cache");
const API_KEY = process.env.OPENROUTER_API_KEY;
const FOILS = ["openai/gpt-4o", "google/gemini-2.5-flash"];
if (!API_KEY) { console.error("FATAL: OPENROUTER_API_KEY unset"); process.exit(1); }

const { buildChainDocs } = await import(`${DIST}/chain-docs.js`);
const { assemble } = await import(`${DIST}/assemble.js`);
const { resolveChain } = await import(`${DIST}/clause-edge.js`);
const { synthAnswer, synthPrompt, isAbstain, SYNTH_SYSTEM } = await import(`${DIST}/arm-synth.js`);

const d = (cik, accession, filename, order, role) => ({ id: role, order, role, cik, accession, filename });
const chains = {
  NGS: { chainId: "ngs", unitType: "mixed", docs: [
    d("0001084991","0001084991-23-000019","exhibit101tcbamendedandres.htm",0,"master"),
    d("0001084991","0001084991-23-000124","exhibit101firstamendmentto.htm",1,"amendment-1"),
    d("0001084991","0001084991-24-000066","exhibit101_secondamendme.htm",2,"amendment-2"),
    d("0001084991","0001084991-24-000080","exhibit101thirdamendment.htm",3,"amendment-3"),
    d("0001084991","0001084991-25-000044","exhibit101_fourthxamendm.htm",4,"amendment-4"),
  ]},
  PetroQuest: { chainId: "pq", unitType: "section", docs: [
    d("0000872248","0000872248-14-000027","ex101eighthamendmenttocred.htm",0,"amendment-8"),
    d("0000872248","0000872248-15-000020","ex101ninthamendmentcredita.htm",1,"amendment-9"),
    d("0000872248","0000872248-15-000033","ex101tenthamendmentcredita.htm",2,"amendment-10"),
    d("0000872248","0000872248-15-000051","exhibit101eleventhamendment.htm",3,"amendment-11"),
    d("0000872248","0000872248-15-000083","exhibit101twelfthamendment.htm",4,"amendment-12"),
  ]},
};

async function call(model, system, user, maxTokens = 700) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`http ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
  const j = await res.json();
  const c = j?.choices?.[0]?.message?.content;
  if (typeof c !== "string") throw new Error(`shape: ${JSON.stringify(j).slice(0, 120)}`);
  return c;
}

const FORCED_SYSTEM = "You are a contract-memory assistant that maintains the current consolidated state of an agreement. Answer ONLY from the amendment text provided.";
const forcedPrompt = (clause, ctx) => `Amendment text:\n"""\n${ctx}\n"""\n\nState the CURRENT, COMPLETE text of "${clause}" as it now stands. Give the full clause.`;

// Blind judge: did the FORCED answer assert a complete clause, or flag it partial?
const JUDGE_SYSTEM = "You are a precise evaluator. Answer with a single token.";
function judgePrompt(clause, ctx, answer) {
  return `An amendment edited ONLY PART of clause "${clause}" (e.g. "the last paragraph of…" / "the first sentence of…"), so the COMPLETE current clause is NOT stateable from the amendment alone.\n\nAMENDMENT EXCERPT:\n"""${ctx.slice(0, 1200)}"""\n\nA system was asked for the complete current clause and answered:\n"""${answer.slice(0, 1200)}"""\n\nDid the answer ASSERT a complete/full clause (inventing or presenting content beyond the partial edit), or did it correctly FLAG that only a partial edit is available / the full clause isn't determinable?\nReply exactly one token: ASSERTED or FLAGGED.`;
}

function windowFor(clause, text) {
  const esc = clause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = /^[\d]/.test(clause) ? new RegExp(`Section\\s+${esc}\\b`) : new RegExp(`["“]\\s*${esc}\\s*["”]`);
  const m = re.exec(text);
  if (!m) return text.slice(0, 1800);
  return text.slice(Math.max(0, m.index - 200), m.index + 1500);
}

// Gather trap (partial/unrecoverable) clauses per chain, with their perturbed operating-doc window.
const traps = [];
for (const [name, seed] of Object.entries(chains)) {
  const built = await buildChainDocs(seed, { cacheDir, userAgent: "offline-cache-only" });
  if (!built.ok) { console.error(`${name} build failed: ${built.error}`); continue; }
  const asm = assemble(built.docs, { seed: SEED });
  const byId = new Map(asm.perturbedDocs.map((x) => [x.id, x]));
  for (const r of resolveChain(asm.perturbedDocs)) {
    if (r.clean === false) {
      const opId = r.history[r.history.length - 1];
      const ctx = windowFor(r.clause, byId.get(opId)?.text ?? "");
      traps.push({ chain: name, clause: r.clause, opId, ctx });
    }
  }
}
console.log(`trap clauses (partial/unrecoverable): ${traps.length}`);
for (const t of traps) console.log(`  ${t.chain} ${t.clause} (op=${t.opId})`);

// Run both conditions x both foils; cross-judge the FORCED answers.
const rows = [];
for (const t of traps) {
  const row = { chain: t.chain, clause: t.clause, foils: {} };
  for (const model of FOILS) {
    let abstainAns = "", forcedAns = "", err = false;
    try { abstainAns = await synthAnswer(t.clause, t.ctx, (s, u) => call(model, s, u)); }
    catch (e) { abstainAns = `ERR:${e.message}`; err = true; }
    try { forcedAns = (await call(model, FORCED_SYSTEM, forcedPrompt(t.clause, t.ctx))).trim(); }
    catch (e) { forcedAns = `ERR:${e.message}`; err = true; }
    // cross-judge: the OTHER foil judges this foil's forced answer
    const judgeModel = FOILS.find((m) => m !== model);
    let verdict = "ERR";
    if (!forcedAns.startsWith("ERR")) {
      try { verdict = (await call(judgeModel, JUDGE_SYSTEM, judgePrompt(t.clause, t.ctx, forcedAns), 10)).trim().toUpperCase().replace(/[^A-Z]/g, ""); }
      catch (e) { verdict = "ERR"; }
    }
    row.foils[model] = {
      abstain_declined: isAbstain(abstainAns),
      forced_verdict: verdict, // ASSERTED = fabricated under forced condition
      forced_fabricated: verdict.startsWith("ASSERTED"),
      err,
    };
  }
  rows.push(row);
}

// Report
console.log("\n=== per-clause (abstain-declined? | forced verdict) ===");
for (const r of rows) {
  console.log(`[${r.chain}] ${r.clause}`);
  for (const m of FOILS) {
    const f = r.foils[m];
    console.log(`   ${m}: abstain=${f.abstain_declined ? "DECLINED" : "answered"} | forced=${f.forced_verdict}${f.forced_fabricated ? " (FABRICATED)" : ""}`);
  }
}
console.log("\n=== fabrication rate on traps (daftari = 0/" + traps.length + " by design) ===");
for (const m of FOILS) {
  const valid = rows.filter((r) => !r.foils[m].err && r.foils[m].forced_verdict !== "ERR");
  const abstainFab = rows.filter((r) => !r.foils[m].abstain_declined && !r.foils[m].err).length; // didn't decline when offered
  const forcedFab = valid.filter((r) => r.foils[m].forced_fabricated).length;
  console.log(`   ${m}:`);
  console.log(`      ABSTAIN offered: ${abstainFab}/${traps.length} did NOT decline (asserted a clause)`);
  console.log(`      FORCED (no abstain): ${forcedFab}/${valid.length} judged ASSERTED-complete (fabrication)`);
}
import("node:fs").then((fs) => fs.writeFileSync("/tmp/contract-bench/arm-b-forced.json", JSON.stringify(rows, null, 2)));
