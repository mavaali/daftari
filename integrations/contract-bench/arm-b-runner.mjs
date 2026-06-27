#!/usr/bin/env node
// arm-b-runner — E4/CB4 probe: Arm B (LLM value-MINTING foil) vs daftari's
// no-mint behavior, on the REAL NGS chain's clauses. Two probe classes:
//   TRAPS    — partial/unrecoverable clauses (11.25, 2.10(a)): the most-recent
//              amendment only edits PART of the clause ("the last paragraph of
//              …"), so the complete current clause is NOT stateable from it. A
//              minting system fabricates the rest; daftari points to the source.
//   CONTROLS — recoverable full-restate clauses (8.1, Commitment): the value IS
//              present, so a faithful minter answers correctly (sanity that the
//              foil isn't just always abstaining).
// Foils are neutral cross-family OpenRouter models (NOT daftari's own Claude).
// Context = a focused window of the PERTURBED operating doc (perturbation defeats
// the model recalling these public contracts from training). Needs OPENROUTER_API_KEY.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const SEED = 20260627;
const cacheDir = join(HERE, ".edgar-cache");
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODELS = ["openai/gpt-4o", "google/gemini-2.5-flash"];
if (!API_KEY) { console.error("FATAL: OPENROUTER_API_KEY unset"); process.exit(1); }

const { buildChainDocs } = await import(`${DIST}/chain-docs.js`);
const { assemble } = await import(`${DIST}/assemble.js`);
const { resolveChain } = await import(`${DIST}/clause-edge.js`);
const { synthAnswer, isAbstain, isFabrication } = await import(`${DIST}/arm-synth.js`);

const seed = {
  chainId: "0001084991-amended-and-restated-credit-agreement-february-28-2023",
  unitType: "mixed",
  docs: [
    { id: "master", order: 0, role: "master", cik: "0001084991", accession: "0001084991-23-000019", filename: "exhibit101tcbamendedandres.htm" },
    { id: "amendment-1", order: 1, role: "amendment-1", cik: "0001084991", accession: "0001084991-23-000124", filename: "exhibit101firstamendmentto.htm" },
    { id: "amendment-2", order: 2, role: "amendment-2", cik: "0001084991", accession: "0001084991-24-000066", filename: "exhibit101_secondamendme.htm" },
    { id: "amendment-3", order: 3, role: "amendment-3", cik: "0001084991", accession: "0001084991-24-000080", filename: "exhibit101thirdamendment.htm" },
    { id: "amendment-4", order: 4, role: "amendment-4", cik: "0001084991", accession: "0001084991-25-000044", filename: "exhibit101_fourthxamendm.htm" },
  ],
};

const TRAPS = ["11.25", "2.10(a)"];
const CONTROLS = ["8.1", "Commitment"];

async function openrouterLLM(model, system, user) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 700, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`http ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`unexpected shape: ${JSON.stringify(json).slice(0, 160)}`);
  return content;
}

// A focused retrieval window in the perturbed operating doc, centred on the
// clause's operative mention (what a chunk-retrieval snapshot system surfaces).
function windowFor(clause, docText) {
  const isTerm = !/^[\d]/.test(clause);
  const needle = isTerm ? new RegExp(`["“]\\s*${clause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*["”]`) : new RegExp(`Section\\s+${clause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const m = needle.exec(docText);
  if (!m) return docText.slice(0, 2000);
  const start = Math.max(0, m.index - 200);
  return docText.slice(start, m.index + 1400);
}

const built = await buildChainDocs(seed, { cacheDir, userAgent: "offline-cache-only" });
if (!built.ok) { console.error("buildChainDocs failed:", built.error); process.exit(1); }
const asm = assemble(built.docs, { seed: SEED });
const resolutions = resolveChain(asm.perturbedDocs);
const byId = new Map(asm.perturbedDocs.map((d) => [d.id, d]));
const resByClause = new Map(resolutions.map((r) => [r.clause, r]));

const rows = [];
for (const [kind, clauses] of [["trap", TRAPS], ["control", CONTROLS]]) {
  for (const clause of clauses) {
    const res = resByClause.get(clause);
    const operatingId = res ? res.history[res.history.length - 1] : "amendment-2";
    const ctx = windowFor(clause, byId.get(operatingId)?.text ?? "");
    const perModel = {};
    for (const model of MODELS) {
      let ans;
      try { ans = await synthAnswer(clause, ctx, (s, u) => openrouterLLM(model, s, u)); }
      catch (e) { ans = `ERROR: ${e.message}`; }
      perModel[model] = { answer: ans, abstain: isAbstain(ans), fabricated: kind === "trap" ? isFabrication(ans) : null, error: ans.startsWith("ERROR") };
    }
    rows.push({ kind, clause, operatingDoc: operatingId, clean: res?.clean, daftari: { mints: false, behavior: res?.clean === false ? "points to governing source; clause tainted/partial — no full clause minted" : "returns governing source value" }, armB: perModel });
  }
}

console.log("=== Arm B (minting foil) vs daftari (no-mint), real NGS clauses ===\n");
for (const r of rows) {
  console.log(`[${r.kind}] ${r.clause}  (operating=${r.operatingDoc}, clean=${r.clean})`);
  console.log(`   daftari: NO MINT — ${r.daftari.behavior}`);
  for (const m of MODELS) {
    const v = r.armB[m];
    const tag = r.kind === "trap" ? (v.error ? "ERROR" : v.fabricated ? "FABRICATED full clause" : "abstained (faithful)") : (v.error ? "ERROR" : v.abstain ? "abstained" : "answered");
    console.log(`   ArmB[${m}]: ${tag}\n      -> ${String(v.answer).replace(/\s+/g, " ").slice(0, 140)}`);
  }
  console.log("");
}

const trapRows = rows.filter((r) => r.kind === "trap");
console.log("=== fabrication on TRAPS (full clause asserted where only a partial edit was provided) ===");
for (const m of MODELS) {
  const fab = trapRows.filter((r) => r.armB[m].fabricated === true).length;
  const err = trapRows.filter((r) => r.armB[m].error).length;
  console.log(`   ArmB[${m}]: ${fab}/${trapRows.length - err} fabricated  (daftari: 0/${trapRows.length})`);
}
import("node:fs").then((fs) => fs.writeFileSync("/tmp/contract-bench/arm-b.json", JSON.stringify(rows, null, 2)));
