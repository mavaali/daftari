// consensus-cb6-tension — the keystone, measured. The box's "no consensus" items are
// genuine tensions: the status quo holds BY DEFAULT, not by superseding the alternative
// on the merits (editor-labeled, e.g. #48 "...there is no consensus on specific wording,
// but the status quo is X"). Ground truth = NEITHER supersedes. A forced consolidation
// foil has no "tension" output, so any direction it asserts IS "a tension masquerading as
// a supersession" — the keystone violation daftari is built to prevent. daftari's path
// (the CB5 contradiction detector) flags the conflict and never asks direction → mints 0.
import type { FoilVerdict } from "./consensus-cb4-foil.js";

export interface TensionPair {
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

// Four currently-active "no consensus" tensions from Talk:Donald_Trump/Current_consensus.
// (#45 was later superseded by #48, so it is resolved, not active; #4 by #15.) Positions
// distilled from the linked RfCs; each is gated by the blind second-rater before use.
export const tensionPairs: TensionPair[] = [
  {
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
    num: 65,
    topic: "Abraham Accords framing",
    statusQuo:
      "The Abraham Accords were a significant diplomatic achievement of the Trump administration, under which Israel normalized relations with the UAE, Bahrain, Morocco, and Sudan.",
    alternative:
      "The Abraham Accords were largely ceremonial agreements between states already at de facto peace, with limited personal involvement from Trump, and are better covered in dedicated foreign-policy articles than emphasized here.",
    rfc: "Talk:Donald Trump/Archive 166 'RfC for inclusion of Abraham Accords' (2023–24); box #65 — included, no consensus on specific wordings.",
    gt: "neither",
  },
];
