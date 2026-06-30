// consensus-cb6-tension — the keystone, measured. The box's "no consensus" items are
// genuine tensions: the status quo holds BY DEFAULT, not by superseding the alternative
// on the merits (editor-labeled, e.g. #48 "...there is no consensus on specific wording,
// but the status quo is X"). Ground truth = NEITHER supersedes. A forced consolidation
// foil has no "tension" output, so any direction it asserts IS "a tension masquerading as
// a supersession" — the keystone violation daftari is built to prevent. daftari's path
// (the CB5 contradiction detector) flags the conflict and never asks direction → mints 0.
import type { FoilVerdict } from "./consensus-cb4-foil.js";

export interface TensionPair {
  article: string; // which article's Current-consensus box
  num: number; // consensus-box item number
  topic: string;
  statusQuo: string; // the wording held by default
  alternative: string; // the contested alternative (from the RfC)
  rfc: string; // editor-provided provenance (the 'no consensus' label source)
  gt: "neither"; // no consensus => neither supersedes
}

// The forced foil — the architectural anchor. A consolidation memory whose job is to emit
// a single current value has NO "neither/tension" slot, so it must pick a direction. This
// prompt removes the NEITHER escape to model that architecture; under it, every verdict on
// a genuine tension is a masquerade by construction. (The abstain-offered CB4 foil, which
// DOES offer NEITHER, measures the softer LLM-with-judgment condition alongside it.)
export function buildForcedFoilPrompt(textA: string, textB: string): string {
  return [
    "Two versions of a passage from a collaboratively edited article:",
    "",
    `A: ${textA}`,
    `B: ${textB}`,
    "",
    "One of these is the current consensus and supersedes the other. You must decide which.",
    "Reply with exactly 'A_SUPERSEDES_B' or 'B_SUPERSEDES_A'.",
  ].join("\n");
}

// A forced supersession verdict on a genuine tension is the masquerade; only NEITHER is
// faithful to "no consensus". (Mechanically classifyFoilControl, but the reason here is
// 'unresolved', not 'unrelated' — see the result note.)
export function masquerades(v: FoilVerdict): boolean {
  return v !== "neither";
}

// Currently-active "no consensus" tensions from the three articles that maintain a
// Talk:.../Current_consensus box with such items (surveyed 2026-06-29: of 12 candidate
// articles only Trump, Biden, COVID-19 have real boxes — it is a rare institution).
// (Trump #45 was later superseded by #48, #4 by #15 — those are resolved, not active.)
// Positions distilled from the linked RfCs; each is gated by the blind second-rater.
export const tensionPairs: TensionPair[] = [
  {
    article: "Donald Trump",
    num: 15,
    topic: "2016 election result phrasing in the lead",
    statusQuo:
      "Trump won the 2016 election by gaining a majority of the Electoral College, while Hillary Clinton received a larger share of the nationwide popular vote.",
    alternative:
      "Trump won the 2016 election by winning a majority of the Electoral College, while Hillary Clinton received over 2.5 million more votes nationwide.",
    rfc: "Talk:Donald Trump/Archive 37 (Dec 2016); box #15 supersedes #4 — no consensus to change the formulation.",
    gt: "neither",
  },
  {
    article: "Donald Trump",
    num: 48,
    topic: "COVID-19 response wording in the lead",
    statusQuo:
      "Trump reacted slowly to the COVID-19 pandemic; he minimized the threat, ignored or contradicted many recommendations from health officials, and promoted false information about unproven treatments.",
    alternative:
      "Trump downplayed the threat of the COVID-19 pandemic; under his administration the United States recorded more confirmed cases than any other country, and the crisis prompted the largest economic stimulus in U.S. history.",
    rfc: "Talk:Donald Trump/Archive 117 'RfC: Coronavirus in the lead' (Apr–May 2020); box #48 — no consensus on specific wording.",
    gt: "neither",
  },
  {
    article: "Donald Trump",
    num: 56,
    topic: "Russian bounties wording",
    statusQuo:
      "Trump never confronted Putin over Russia's alleged bounties for killing American soldiers in Afghanistan.",
    alternative:
      "Trump did not confront Putin over Russia's alleged bounties on American soldiers in Afghanistan — allegations later reported by the Biden administration to be held with only low-to-moderate confidence.",
    rfc: "Talk:Donald Trump/Archive 141 'RfC Russian Bounties claims' (Nov 2021); box #56 — no consensus on alternate wordings.",
    gt: "neither",
  },
  {
    article: "Donald Trump",
    num: 65,
    topic: "Abraham Accords framing",
    statusQuo:
      "The Abraham Accords were a significant diplomatic achievement of the Trump administration, under which Israel normalized relations with the UAE, Bahrain, Morocco, and Sudan.",
    alternative:
      "The Abraham Accords were largely ceremonial agreements between states already at de facto peace, with limited personal involvement from Trump, and are better covered in dedicated foreign-policy articles than emphasized here.",
    rfc: "Talk:Donald Trump/Archive 166 'RfC for inclusion of Abraham Accords' (2023–24); box #65 — included, no consensus on specific wordings.",
    gt: "neither",
  },
  {
    article: "Joe Biden",
    num: 2,
    topic: "gaffes subsection inclusion",
    statusQuo:
      "Joe Biden's biography does not include a dedicated subsection on his gaffes; the proposed section is undue weight for a standalone treatment.",
    alternative:
      "Joe Biden's biography should include a subsection on his gaffes; his speech mistakes are extensively covered across the political spectrum and he has called himself a 'gaffe machine'.",
    rfc: "Talk:Joe Biden/Archive 15 'RfC: Section on gaffes' (Mar 2021, closed No consensus); box #2 — no consensus on including a gaffes subsection.",
    gt: "neither",
  },
  {
    article: "COVID-19 pandemic",
    num: 7,
    topic: "lead infobox map prominence",
    statusQuo:
      "The lead infobox should feature the confirmed-cases-per-capita map most prominently, with the deaths-per-capita map secondary.",
    alternative:
      "The lead infobox should feature the deaths-per-capita map most prominently, since deaths are the most significant measure of the pandemic's impact.",
    rfc: "Talk:COVID-19 pandemic/Archive 33 'Should we switch the lead infobox map…' RfC; box #7 — no consensus on map prominence.",
    gt: "neither",
  },
];
