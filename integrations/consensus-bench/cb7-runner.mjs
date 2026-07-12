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

// ── --gate: leakage gate, v2 (2026-07-11 redesign) ──────────────────────────
// v1 asked the second rater "is this topic contested?" per instance and
// flagged 13/13 — a constant confound: every instance is a famous contested
// topic, and the rater knows it regardless of the prompt. That signal is
// HARMLESS to the design: the wordings are shown identically in both memory
// conditions, so topic contested-ness cannot produce spurious divergence.
// The invalidating signal is a DIFFERENTIAL process watermark between the
// arms (settled wordings carrying `Supersedes [[#C..]]` / `{{tq|…}}`
// apparatus while tension wordings read as prose — the actual v1 finding).
// v2 gates on exactly that:
//   A. deterministic apparatus scan over every wording, all buckets (no API);
//   B. second-rater residual: the two wordings ALONE (no task text — it is
//      byte-identical across arms by hermetic test), asked for process
//      apparatus, reported per arm. Pass = zero flags in both parts.
if (process.argv.includes("--gate")) {
  const { hasApparatus } = await import(`${DIST}/consensus-cb7-instances.js`);

  // Traps are exempt: their wordings are raw article passages where wiki
  // markup appears symmetrically on both sides of every instance, and T3 is
  // never compared against T1/T2. The watermark risk the gate exists for is
  // differential between the tension and settled arms.
  console.log("— part A: deterministic apparatus scan (T1/T2 wordings, no API)");
  let scanHits = 0;
  for (const inst of [...tensions, ...settled]) {
    for (const [side, text] of [
      ["governing", inst.positionGoverning],
      ["other", inst.positionOther],
    ]) {
      if (hasApparatus(text)) {
        scanHits += 1;
        console.log(`  ${inst.id} [${side}]: APPARATUS ⚠  ${text.slice(0, 80)}`);
      }
    }
  }
  console.log(`  scan: ${scanHits} hits over ${instances.length * 2} wordings`);

  console.log("\n— part B: second-rater watermark check (T1/T2 wordings only)");
  const GATE_SYSTEM =
    "You are a precise evaluator of experimental materials. Answer with a single token.";
  const flaggedByArm = { tension: 0, settled: 0 };
  for (const inst of [...tensions, ...settled]) {
    // The materials are editorial DECISIONS by nature, so directives about
    // article content ("Include X in the lead", "Omit Y", "should include a
    // subsection") are the substance, present in both arms — the rater must
    // not flag them (gate-v2.0 did, on both arms, which is style, not
    // leakage). APPARATUS is reserved for machinery: markup, cross-refs,
    // process mentions, moratoria.
    const q =
      `Two candidate wordings for an editorial decision about a reference ` +
      `article:\n\n` +
      `Wording 1: ${inst.positionGoverning}\n` +
      `Wording 2: ${inst.positionOther}\n\n` +
      `These materials are editorial decisions, so directives about article ` +
      `content — "Include X in the lead", "Omit Y", "should include a ` +
      `subsection", "better covered in another article" — are NORMAL here ` +
      `and count as CLEAN.\n` +
      `Reply APPARATUS only if a wording contains process MACHINERY: wiki ` +
      `markup or templates ({{...}}, [[...]]), item or RfC cross-references ` +
      `("item 23", "#C35", "See #32", "per RfC"), mentions of a consensus/` +
      `supersession process, Wikipedia-namespace shortcuts (WP:...), or ` +
      `discussion-moratorium clauses ("do not bring up for discussion").\n` +
      `Reply exactly one token: APPARATUS or CLEAN.`;
    const verdict = (await call(SECOND_RATER, GATE_SYSTEM, q, 10)).trim().toUpperCase();
    const hit = verdict.startsWith("APPARATUS");
    if (hit) flaggedByArm[inst.bucket] += 1;
    console.log(`  ${inst.id}: ${hit ? "APPARATUS ⚠" : "clean"}`);
  }
  console.log(
    `\ngate v2: scan ${scanHits} · rater tension ${flaggedByArm.tension}/${tensions.length} · ` +
      `rater settled ${flaggedByArm.settled}/${settled.length}`,
  );
  const failed = scanHits > 0 || flaggedByArm.tension > 0 || flaggedByArm.settled > 0;
  console.log(failed ? "GATE FAILED — fix materials before the full run." : "GATE PASSED.");
  process.exit(failed ? 1 : 0);
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
