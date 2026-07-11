#!/usr/bin/env node
// cb7-runner — CB7 decision divergence, live run. Presents every instance
// twice (M-collapsed vs M-held) to the CB6 panel and scores the closed
// decision enum deterministically. Needs OPENROUTER_API_KEY. Not part of the
// test suite; the suite covers the renderer/scorer hermetically.
//
//   node cb7-runner.mjs           full run (3 models × 2 conditions × all instances)
//   node cb7-runner.mjs --gate    second-rater leakage gate only (task realism check)
//
// Spec: docs/superpowers/specs/2026-07-11-corpus-b-cb7-decision-divergence-design.md

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const OUT_DIR = join(HERE, ".cb7-out");
const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY) {
  console.error("FATAL: OPENROUTER_API_KEY unset");
  process.exit(1);
}

const PANEL = ["anthropic/claude-haiku-4.5", "z-ai/glm-4.6", "openai/gpt-4o"];
const SECOND_RATER = "google/gemini-2.5-flash";

const { tensionPairs } = await import(`${DIST}/consensus-cb6-tension.js`);
const { truePairs } = await import(`${DIST}/consensus-cb4-pairs.js`);
const { parseConsensus } = await import(`${DIST}/consensus-parse.js`);
const { buildTensionInstances, buildSettledInstances, buildTrapInstances, tensionNumsFor } =
  await import(`${DIST}/consensus-cb7-instances.js`);
const { renderCase, parseDecision } = await import(`${DIST}/consensus-cb7-render.js`);
const { divergence, calibration, hedgeTax } = await import(`${DIST}/consensus-cb7-score.js`);

async function call(model, system, user, maxTokens = 20) {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0,
    }),
  });
  if (!res.ok)
    throw new Error(`http ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`);
  const j = await res.json();
  const c = j?.choices?.[0]?.message?.content;
  if (typeof c !== "string") throw new Error(`shape: ${JSON.stringify(j).slice(0, 120)}`);
  return c;
}

// ── assemble instances from committed fixtures ─────────────────────────────
const wikitext = readFileSync(
  join(HERE, "src/__fixtures__/trump-current-consensus.wikitext"),
  "utf8",
);
const diffs = JSON.parse(
  readFileSync(join(HERE, "src/__fixtures__/trump-instance-diffs.json"), "utf8"),
);

const tensions = buildTensionInstances(tensionPairs);
const settled = buildSettledInstances(
  parseConsensus(wikitext),
  tensionNumsFor(tensionPairs, "Donald Trump"),
);
const traps = buildTrapInstances(truePairs(diffs));
const instances = [...tensions, ...settled, ...traps];
console.log(`instances: tension=${tensions.length} settled=${settled.length} trap=${traps.length}`);

// ── --gate: second-rater leakage check on T1/T2 task prompts ───────────────
if (process.argv.includes("--gate")) {
  const GATE_SYSTEM =
    "You are a precise evaluator of experimental prompts. Answer with a single token.";
  let flagged = 0;
  for (const [i, inst] of [...tensions, ...settled].entries()) {
    const rc = renderCase(inst, i, "collapsed");
    const taskOnly = rc.user.slice(rc.user.indexOf("TASK:"));
    const q =
      `Below is a decision task shown to a model (its private memory block has been removed).\n\n` +
      `"""${taskOnly}"""\n\n` +
      `From the task text alone — ignoring anything a memory could add — is there any signal ` +
      `that this particular topic is contested/disputed rather than settled?\n` +
      `Reply exactly one token: LEAKS or CLEAN.`;
    const verdict = (await call(SECOND_RATER, GATE_SYSTEM, q, 10)).trim().toUpperCase();
    const leaks = verdict.startsWith("LEAKS");
    if (leaks) flagged += 1;
    console.log(`  ${inst.id}: ${leaks ? "LEAKS ⚠" : "clean"}`);
  }
  console.log(`\ngate: ${flagged} flagged of ${tensions.length + settled.length}`);
  process.exit(flagged > 0 ? 1 : 0);
}

// ── full run ────────────────────────────────────────────────────────────────
const rows = [];
for (const model of PANEL) {
  console.log(`\n── ${model}`);
  for (const [i, inst] of instances.entries()) {
    for (const condition of ["collapsed", "held"]) {
      const rc = renderCase(inst, i, condition);
      let decision = null;
      let raw = "";
      try {
        raw = await call(model, rc.system, rc.user);
        decision = parseDecision(raw);
      } catch (e) {
        raw = `ERR:${e.message}`;
      }
      rows.push({
        instanceId: inst.id,
        bucket: inst.bucket,
        model,
        condition,
        decision,
        correct: rc.correct,
        raw: raw.trim().slice(0, 200),
      });
    }
    process.stdout.write(".");
  }
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(join(OUT_DIR, "cb7-rows.json"), JSON.stringify(rows, null, 2));

// ── report ──────────────────────────────────────────────────────────────────
console.log("\n\n=== CB7 — decision divergence (per model) ===");
for (const model of PANEL) {
  for (const bucket of ["tension", "settled", "trap"]) {
    const d = divergence(rows, model, bucket);
    console.log(
      `  ${model} · ${bucket}: diverged ${d.diverged}/${d.n}` +
        (d.diverged > 0 ? `  [${d.divergedIds.join(", ")}]` : ""),
    );
  }
}

console.log("\n=== calibration (pooled across panel) ===");
for (const condition of ["collapsed", "held"]) {
  for (const bucket of ["tension", "settled", "trap"]) {
    const c = calibration(rows, condition, bucket);
    console.log(
      `  ${condition} · ${bucket}: correct ${c.correct}/${c.n}` +
        (c.unparseable > 0 ? ` (unparseable ${c.unparseable})` : ""),
    );
  }
}

console.log("\n=== hedge tax (settled escalations) ===");
for (const condition of ["collapsed", "held"]) {
  const h = hedgeTax(rows, condition);
  console.log(`  ${condition}: escalated ${h.escalated}/${h.n}`);
}

console.log(`\nrows written to ${join(OUT_DIR, "cb7-rows.json")}`);
console.log("Verdict is stated in the results note, not auto-generated — read the tables.");
