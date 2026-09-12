// CB6 second-rater gate — negative controls (moderator correction plan M4(i)).
//
// The paper's §6 keystone measurement gated its 6 distilled tension pairs through a
// blind second-rater (google/gemini-2.5-flash via OpenRouter), which approved 6/6.
// A gate that has never rejected anything has no demonstrated discriminative
// validity. This script feeds the SAME gate — byte-identical prompt template,
// same client (temp 0, max_tokens 1024, no system message), same model, same
// verdict parse — 8 SETTLED supersessions drawn from the paper's 33 stale-trap
// pairs, distilled into the same "Position A / Position B" shape as the CB6
// tension pairs. Ground truth for every control: one position clearly won (the
// stale wording was reverted citing the numbered consensus item), so a
// discriminating gate must answer NO. It also re-runs the 6 original tension
// pairs in the same session as a drift check on the original 6/6.
//
// Prompt provenance: the original CB6 runner (_cb6-run.test.ts) was a deleted
// throwaway, never committed; its judge prompt was recovered verbatim from the
// session transcript that wrote it (session d3499c05, 2026-06-30T03:27Z and
// 03:43Z — identical in both the n=4 and n=6 versions):
//
//   const judgePrompt = [
//     "Two editors disagree about how an article should describe a point.",
//     `Position A: ${p.statusQuo}`,
//     `Position B: ${p.alternative}`,
//     "",
//     "Is this a genuine, unresolved editorial disagreement in which neither position has",
//     "clearly superseded or won out over the other? Reply 'YES_TENSION' or 'NO'.",
//   ].join("\n");
//   const judgeRaw = await safe(() => client.complete({ model: JUDGE_MODEL, user: judgePrompt }), "");
//   ... /yes_tension/i.test(judgeRaw) ? "tension" : "no"
//
// Control selection rule (mechanical, no cherry-picking): from the 33 scorable
// stale-trap pairs (truePairs over trump-instance-diffs.json), dedupe on
// governingNum (first scorable instance per item; 17 distinct items), rank by
// ascending token-set Jaccard(govText, staleText), take the first 8 — the pairs
// whose two wordings differ substantively enough to phrase as two distinct
// positions (near-identical reverts, median sim 0.938, cannot be distilled into
// distinguishable positions at all). Selected: #63, #37, #72, #27, #43, #54,
// #71, #40. Distillation of each delta into position statements is
// author-performed (same as the original CB6 alternative-side distillation) and
// each control records the revid + delta it was distilled from.
//
// Blind: the gate sees only the two positions — no labels, no provenance, no
// revert history (the same information condition as the original CB6 run).
// Which position occupies slot A is randomized per control item (seeded,
// recorded); the 6 tension re-checks keep the original orientation
// (A = statusQuo) so the drift comparison against the original run is clean.
//
// Usage:
//   OPENROUTER_API_KEY=... npx tsx scripts/cb6-gate-negative-controls.mjs
// (tsx, not node: the script imports the committed .ts fixtures/client so the
//  re-check uses the exact committed tension pairs and the exact CB6 client.)
//
// Output: scripts/pools/cb6-gate-negative-controls.results.json
// Cost: 14 gemini-2.5-flash calls, well under $0.10.

import { writeFileSync } from "node:fs";
import { tensionPairs } from "../integrations/consensus-bench/src/consensus-cb6-tension.ts";
import { openRouterClient } from "../integrations/consensus-bench/src/consensus-llm.ts";

const API_KEY = process.env.OPENROUTER_API_KEY;
if (!API_KEY || !API_KEY.startsWith("sk-or-")) {
  console.error(
    "FATAL: OPENROUTER_API_KEY missing or malformed (expected sk-or- prefix). " +
      "Set it in ~/.zshenv. Refusing to send an empty/invalid key to the API.",
  );
  process.exit(1);
}

const JUDGE_MODEL = "google/gemini-2.5-flash"; // exactly the CB6 second-rater
const RESULTS_PATH = "scripts/pools/cb6-gate-negative-controls.results.json";

// The 8 settled-supersession controls. posWinner = the position implemented by
// the governing (consensus-protected) wording — the side that WON (the stale
// variant implementing posLoser was reverted citing consensus item `num`).
// Ground truth for the gate: NO (one position clearly superseded the other).
const controls = [
  {
    num: 63,
    revid: 1319062064,
    sim: 0.7,
    topic: "infobox education entry (Fordham inclusion)",
    posWinner:
      "The infobox education entry should list only the University of Pennsylvania (BS), the institution that granted Trump's degree.",
    posLoser:
      "The infobox education entry should also list Fordham University (attended) before the University of Pennsylvania (BS), since Trump attended Fordham for two years.",
  },
  {
    num: 37,
    revid: 1340952005,
    sim: 0.705,
    topic: "February 2026 Iran attack — length and detail of the description",
    posWinner:
      "The February 2026 attack on Iran should be described in a single sentence: Trump launched a major attack on Iran with Israel with the stated goal of regime change.",
    posLoser:
      "The February 2026 attack on Iran should be described in full detail: Trump announced that the United States had launched a major attack alongside Israel, declaring the objective was to destroy Iran's missile and military capabilities, prevent Iran from obtaining nuclear weapons, and ultimately topple the regime, including his calls for the IRGC to lay down their arms in exchange for immunity and for the Iranian people to take over their government.",
  },
  {
    num: 72,
    revid: 1335748675,
    sim: 0.802,
    topic: "second-presidency lead paragraph (pardons sentence, links, lawsuit count)",
    posWinner:
      "The second-presidency lead paragraph should open with the mass layoffs of federal workers, describe the administration's actions in plain text (targeting of political opponents and civil society, persecution of transgender people, mass deportation of immigrants, extensive use of executive orders), and cite over 550 lawsuits challenging their legality.",
    posLoser:
      "The second-presidency lead paragraph should open with Trump pardoning around 1,500 January 6 rioters before the mass layoffs, link each administration action to its dedicated article, and cite over 300 lawsuits challenging their legality.",
  },
  {
    num: 27,
    revid: 1346635421,
    sim: 0.891,
    topic: "racism section — retention of the September 2016 birther sentence",
    posWinner:
      "The racism section should retain the sentence noting that in September 2016 Trump publicly acknowledged Obama's birthplace and falsely claimed the rumors had been started by Hillary Clinton during her 2008 campaign.",
    posLoser:
      "The racism section should drop the September 2016 birther-acknowledgment sentence and move directly from the Central Park jogger case to Trump's comments on the 2017 Unite the Right rally.",
  },
  {
    num: 43,
    revid: 1322975812,
    sim: 0.908,
    topic: "lead — democratic-backsliding sentence inclusion",
    posWinner:
      "The lead should move from the conspiracy-theories sentence directly to scholars and historians ranking Trump among the worst presidents, without a sentence on democratic backsliding.",
    posLoser:
      "The lead should state that Trump's actions, especially in his second term, have been described as authoritarian and contributing to democratic backsliding in the United States.",
  },
  {
    num: 54,
    revid: 1341340120,
    sim: 0.937,
    topic: "wikilink on 'scholars and historians ranked him'",
    posWinner:
      "The sentence 'scholars and historians ranked him as one of the worst presidents in American history' should be plain text, without a wikilink.",
    posLoser:
      "The phrase 'scholars and historians ranked him' should link to the scholar-survey summary of Historical rankings of presidents of the United States.",
  },
  {
    num: 71,
    revid: 1334447176,
    sim: 0.941,
    topic: "first-presidency foreign policy — Korean peace process mention",
    posWinner:
      "The first-presidency foreign-policy sentence should end with the trade war with China and not mention Korea.",
    posLoser:
      "The first-presidency foreign-policy sentence should additionally state that Trump engaged in a failed 2018-19 Korean peace process.",
  },
  {
    num: 40,
    revid: 1334531111,
    sim: 0.948,
    topic: "health section — 'battery theory' framing of Trump's exercise views",
    posWinner:
      "The health section should say Trump considers exercise a waste of energy because he believes the body is 'like a battery, with a finite amount of energy' which is depleted by exercise.",
    posLoser:
      "The health section should name this the 'battery theory' and describe it as a fringe belief that human beings are born with a finite amount of energy that is depleted by physical activity.",
  },
];

// Byte-identical CB6 judge prompt (recovered from the original run's transcript).
function buildJudgePrompt(positionA, positionB) {
  return [
    "Two editors disagree about how an article should describe a point.",
    `Position A: ${positionA}`,
    `Position B: ${positionB}`,
    "",
    "Is this a genuine, unresolved editorial disagreement in which neither position has",
    "clearly superseded or won out over the other? Reply 'YES_TENSION' or 'NO'.",
  ].join("\n");
}

// Identical verdict parse to the original run — but keep raw so an API error
// (empty string) cannot silently masquerade as a rejection.
function parseVerdict(raw) {
  return /yes_tension/i.test(raw) ? "tension" : "no";
}

// Deterministic PRNG for the per-item A/B orientation of controls (recorded).
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function judge(client, positionA, positionB) {
  let raw = "";
  let error = null;
  try {
    raw = await client.complete({ model: JUDGE_MODEL, user: buildJudgePrompt(positionA, positionB) });
  } catch (e) {
    error = String(e?.message ?? e);
  }
  return { verdict: parseVerdict(raw), raw, error };
}

const client = openRouterClient(API_KEY, fetch);
const rand = mulberry32(20260701); // seed = run date, fixed and recorded

console.log(`CB6 gate negative controls — ${JUDGE_MODEL}, temp 0 (client-fixed), one run`);
console.log(`controls: ${controls.length} settled supersessions; re-check: ${tensionPairs.length} original tensions\n`);

const controlRows = [];
for (const c of controls) {
  const winnerInA = rand() < 0.5;
  const positionA = winnerInA ? c.posWinner : c.posLoser;
  const positionB = winnerInA ? c.posLoser : c.posWinner;
  const r = await judge(client, positionA, positionB);
  const rejected = r.verdict === "no" && !r.error && r.raw !== "";
  controlRows.push({
    num: c.num,
    revid: c.revid,
    sim: c.sim,
    topic: c.topic,
    winnerInSlot: winnerInA ? "A" : "B",
    gt: "settled (governing superseded stale)",
    verdict: r.verdict,
    rejected,
    raw: r.raw,
    error: r.error,
  });
  console.log(
    `control #${String(c.num).padStart(2)}  winner-in=${winnerInA ? "A" : "B"}  gate=${r.verdict.padEnd(7)} ${
      rejected ? "REJECTED ✓ (discriminates)" : r.error || r.raw === "" ? "ERROR ⚠" : "PASSED ✗ (no discrimination)"
    }`,
  );
}

const tensionRows = [];
for (const p of tensionPairs) {
  // Original orientation (A = statusQuo), matching the CB6 run exactly.
  const r = await judge(client, p.statusQuo, p.alternative);
  tensionRows.push({
    article: p.article,
    num: p.num,
    topic: p.topic,
    gt: p.gt,
    verdict: r.verdict,
    raw: r.raw,
    error: r.error,
  });
  console.log(
    `tension ${p.article} #${p.num}  gate=${r.verdict.padEnd(7)} ${
      r.verdict === "tension" ? "still validated ✓" : r.error || r.raw === "" ? "ERROR ⚠" : "DRIFT ✗ (was tension in CB6)"
    }`,
  );
}

const errored = [...controlRows, ...tensionRows].filter((r) => r.error || r.raw === "").length;
const rejected = controlRows.filter((r) => r.rejected).length;
const revalidated = tensionRows.filter((r) => r.verdict === "tension").length;

console.log(`\n--- settled controls rejected: ${rejected}/${controlRows.length} ---`);
console.log(`--- original tensions re-validated: ${revalidated}/${tensionRows.length} (CB6 original: 6/6) ---`);
if (errored > 0) console.log(`⚠ ${errored} call(s) errored/empty — inspect raw in the results JSON before reading rates.`);

writeFileSync(
  RESULTS_PATH,
  JSON.stringify(
    {
      date: "2026-07-01",
      model: JUDGE_MODEL,
      temperature: 0,
      maxTokens: 1024,
      runs: 1,
      seed: 20260701,
      promptProvenance:
        "byte-identical to the CB6 throwaway runner's judgePrompt, recovered from session transcript d3499c05 (the runner itself was a deleted throwaway, never committed)",
      selectionRule:
        "33 scorable stale-trap pairs -> dedupe on governingNum (17 distinct) -> ascending token-set Jaccard(gov, stale) -> first 8",
      controlsRejected: `${rejected}/${controlRows.length}`,
      tensionsRevalidated: `${revalidated}/${tensionRows.length}`,
      erroredCalls: errored,
      controls: controlRows,
      tensions: tensionRows,
    },
    null,
    2,
  ) + "\n",
);
console.log(`\nwrote ${RESULTS_PATH}`);
