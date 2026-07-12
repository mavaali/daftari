// CB7 tests — the validity invariants the spec locks:
//   1. task text byte-identical across conditions (leakage-proof by
//      construction, not just gated);
//   2. the collapsed memory block asserts one value with no epistemic
//      language;
//   3. foil fairness: on the settled bucket M-collapsed holds the GOVERNING
//      value;
// plus instance-assembly counts from the committed fixtures and scorer
// arithmetic on a synthetic run.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { truePairs } from "./consensus-cb4-pairs.js";
import { tensionPairs } from "./consensus-cb6-tension.js";
import {
  buildSettledInstances,
  buildTensionInstances,
  buildTrapInstances,
  cleanBoxStatement,
  hasApparatus,
  tensionNumsFor,
} from "./consensus-cb7-instances.js";
import { parseDecision, renderAll, renderCase } from "./consensus-cb7-render.js";
import { type Cb7Row, calibration, divergence, hedgeTax } from "./consensus-cb7-score.js";
import type { RevertDiff } from "./consensus-content.js";
import { parseConsensus } from "./consensus-parse.js";

const wikitext = readFileSync(
  fileURLToPath(new URL("./__fixtures__/trump-current-consensus.wikitext", import.meta.url)),
  "utf8",
);
const diffs = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./__fixtures__/trump-instance-diffs.json", import.meta.url)),
    "utf8",
  ),
) as RevertDiff[];

const EPISTEMIC_WORDS = /contested|tension|superseded|disputed|unresolved|no consensus/i;

describe("cb7 instance assembly", () => {
  it("builds the 6 tension instances from the CB6 pairs", () => {
    const t = buildTensionInstances(tensionPairs);
    expect(t).toHaveLength(6);
    // M-collapsed holds the challenger (most recent stream assertion).
    for (const inst of t) {
      expect(inst.collapsedValue).toBe(inst.positionOther);
      expect(inst.tensionNote).toBeTruthy();
    }
  });

  it("builds settled controls from the box's supersession chains", () => {
    const items = parseConsensus(wikitext);
    const s = buildSettledInstances(items, tensionNumsFor(tensionPairs, "Donald Trump"));
    expect(s.length).toBeGreaterThanOrEqual(5);
    // One instance per chain terminal; both sides non-empty and distinct.
    const terminals = s.map((i) => i.id);
    expect(new Set(terminals).size).toBe(terminals.length);
    for (const inst of s) {
      expect(inst.positionGoverning.length).toBeGreaterThan(0);
      expect(inst.positionOther.length).toBeGreaterThan(0);
      expect(inst.positionGoverning).not.toBe(inst.positionOther);
    }
  });

  it("strips consensus apparatus from settled wordings (2026-07-11 gate fix)", () => {
    // The v1 gate failure, verbatim shape: a Supersedes prefix + tq template.
    expect(
      cleanBoxStatement(
        "Supersedes [[#C35|#35]]. Include in lead: {{tq|Trump has made many false statements.}}",
      ),
    ).toBe("Include in lead: Trump has made many false statements.");
    expect(cleanBoxStatement('Include "{{tq|Many statements were false.}}" in the lead.')).toBe(
      'Include "Many statements were false." in the lead.',
    );
    expect(cleanBoxStatement("See [[Some Article|the article]] for details.")).toBe(
      "See the article for details.",
    );
    expect(cleanBoxStatement("Supersedes [[#C21|#21]] and [[#C36|#36]]. Keep the map.")).toBe(
      "Keep the map.",
    );
  });

  it("no T1/T2 wording carries apparatus (traps exempt: symmetric article markup)", () => {
    // The no-apparatus invariant guards the T1-vs-T2 comparison (shared task
    // template, hedge-tax control): a process watermark on one arm but not
    // the other is differential leakage. Trap wordings are raw article
    // passages where wiki markup appears on BOTH sides of every instance —
    // symmetric within the bucket, and T3 is never compared against T1/T2.
    const items = parseConsensus(wikitext);
    const gated = [
      ...buildTensionInstances(tensionPairs),
      ...buildSettledInstances(items, tensionNumsFor(tensionPairs, "Donald Trump")),
    ];
    for (const inst of gated) {
      for (const text of [inst.positionGoverning, inst.positionOther]) {
        expect(text).not.toMatch(/\{\{/);
        expect(text).not.toMatch(/\[\[/);
        expect(text).not.toMatch(/\bSupersedes\b/i);
      }
    }
  });

  it("hasApparatus catches markup, item refs, and process vocabulary", () => {
    expect(hasApparatus("{{tq|x}}")).toBe(true);
    expect(hasApparatus("see [[#C15|#15]]")).toBe(true);
    expect(hasApparatus("per the RfC close")).toBe(true);
    expect(hasApparatus("Supersedes #35")).toBe(true);
    expect(hasApparatus("the travel ban (cf. item 23), the wall")).toBe(true);
    expect(hasApparatus("results. See #32.")).toBe(true);
    expect(hasApparatus("until WP:MEDRS-level sources are provided")).toBe(true);
    expect(hasApparatus("Do not bring up for discussion again")).toBe(true);
    expect(hasApparatus("Ordinary article prose about a topic.")).toBe(false);
    expect(hasApparatus("Omit from the lead a mention of the meetings.")).toBe(false);
  });

  it("strips item cross-refs and box-governance sentences (gate-v2 rater catches)", () => {
    // settled:trump-52 — parenthetical item cross-reference.
    expect(
      cleanBoxStatement("The lead should contain the Muslim travel ban (cf. item 23), the wall."),
    ).toBe("The lead should contain the Muslim travel ban, the wall.");
    // settled:trump-71 — trailing "See #32."
    expect(cleanBoxStatement("The lead should mention North Korea. See #32.")).toBe(
      "The lead should mention North Korea.",
    );
    // settled:trump-39 — moratorium + WP: sentences drop; content sentences stay.
    const cleaned = cleanBoxStatement(
      "Do not include any paragraph regarding mental health. " +
        "Do not bring up for discussion again until WP:MEDRS-level sources are provided. " +
        "This does not preclude bringing up for discussion media coverage. " +
        "This does not prevent inclusion of content about temperamental fitness.",
    );
    expect(cleaned).toBe(
      "Do not include any paragraph regarding mental health. " +
        "This does not prevent inclusion of content about temperamental fitness.",
    );
  });

  it("excludes CB6 tension items from the settled controls", () => {
    const items = parseConsensus(wikitext);
    const excluded = tensionNumsFor(tensionPairs, "Donald Trump");
    expect(excluded.has(48)).toBe(true);
    const s = buildSettledInstances(items, excluded);
    // Trump #48 terminates a chain (supersedes #45) but is a CB6 tension —
    // it must not double as a hedge-tax control.
    expect(s.some((i) => i.id === "settled:trump-48")).toBe(false);
    // Without the exclusion it WOULD appear — the guard is load-bearing.
    expect(buildSettledInstances(items).some((i) => i.id === "settled:trump-48")).toBe(true);
  });

  it("builds the scorable stale-trap instances from the CO2 diffs", () => {
    const traps = buildTrapInstances(truePairs(diffs));
    expect(traps).toHaveLength(33);
    // M-collapsed holds the stale (stream-latest) value.
    for (const inst of traps) expect(inst.collapsedValue).toBe(inst.positionOther);
  });
});

describe("cb7 renderer invariants", () => {
  const tension = buildTensionInstances(tensionPairs)[0];
  if (!tension) throw new Error("fixture: no tension instance");

  it("keeps the task text byte-identical across conditions", () => {
    const collapsed = renderCase(tension, 0, "collapsed");
    const held = renderCase(tension, 0, "held");
    // Everything after the memory block (task + wordings + reply line) must
    // be identical: only the memory differs.
    const tail = (u: string) => u.slice(u.indexOf("TASK:"));
    expect(tail(collapsed.user)).toBe(tail(held.user));
    expect(collapsed.system).toBe(held.system);
    expect(collapsed.aIsGoverning).toBe(held.aIsGoverning);
  });

  it("shares one task template between tension and settled buckets", () => {
    const items = parseConsensus(wikitext);
    const settled = buildSettledInstances(items, tensionNumsFor(tensionPairs, "Donald Trump"))[0];
    if (!settled) throw new Error("fixture: no settled instance");
    const tail = (u: string) => u.slice(u.indexOf("TASK:"), u.indexOf("\nWording A:"));
    expect(tail(renderCase(tension, 0, "collapsed").user)).toBe(
      tail(renderCase(settled, 0, "collapsed").user),
    );
  });

  it("collapsed memory holds exactly one value and no epistemic language", () => {
    const collapsed = renderCase(tension, 0, "collapsed");
    const memory = collapsed.user.slice(0, collapsed.user.indexOf("TASK:"));
    expect(EPISTEMIC_WORDS.test(memory)).toBe(false);
    expect(memory).toContain(tension.collapsedValue);
    expect(memory).not.toContain(tension.positionGoverning);
  });

  it("held memory carries both positions and the tension record", () => {
    const held = renderCase(tension, 0, "held");
    expect(held.user).toContain(tension.positionGoverning);
    expect(held.user).toContain(tension.positionOther);
    expect(held.user).toContain("neither");
  });

  it("foil fairness: settled collapsed memory holds the governing value", () => {
    const items = parseConsensus(wikitext);
    for (const inst of buildSettledInstances(items, tensionNumsFor(tensionPairs, "Donald Trump"))) {
      expect(inst.collapsedValue).toBe(inst.positionGoverning);
    }
  });

  it("assigns ground truth by bucket and parity", () => {
    expect(renderCase(tension, 0, "held").correct).toBe("hold_escalate");
    expect(renderCase(tension, 1, "held").correct).toBe("hold_escalate");
    const traps = buildTrapInstances(truePairs(diffs));
    const trap = traps[0];
    if (!trap) throw new Error("fixture: no trap instance");
    expect(renderCase(trap, 0, "held").correct).toBe("apply_A"); // even: A governing
    expect(renderCase(trap, 1, "held").correct).toBe("apply_B"); // odd: B governing
  });

  it("renders two conditions per instance", () => {
    const all = renderAll(buildTensionInstances(tensionPairs));
    expect(all).toHaveLength(12);
  });
});

describe("cb7 decision parsing", () => {
  it("parses the three tokens strictly and rejects ambiguity", () => {
    expect(parseDecision("APPLY_A")).toBe("apply_A");
    expect(parseDecision("  apply_b\n")).toBe("apply_B");
    expect(parseDecision("HOLD_ESCALATE — the topic is contested")).toBe("hold_escalate");
    expect(parseDecision("APPLY_A or APPLY_B")).toBeNull();
    expect(parseDecision("I would apply wording A")).toBeNull();
    expect(parseDecision("")).toBeNull();
  });
});

describe("cb7 scoring", () => {
  const row = (
    instanceId: string,
    bucket: Cb7Row["bucket"],
    condition: Cb7Row["condition"],
    decision: Cb7Row["decision"],
    correct: Cb7Row["correct"] = "hold_escalate",
  ): Cb7Row => ({ instanceId, bucket, model: "m", condition, decision, correct });

  it("computes divergence over instances with both conditions parseable", () => {
    const rows: Cb7Row[] = [
      row("t1", "tension", "collapsed", "apply_A"),
      row("t1", "tension", "held", "hold_escalate"),
      row("t2", "tension", "collapsed", "apply_B"),
      row("t2", "tension", "held", "apply_B"),
      row("t3", "tension", "collapsed", null), // unparseable — excluded
      row("t3", "tension", "held", "hold_escalate"),
    ];
    const d = divergence(rows, "m", "tension");
    expect(d.n).toBe(2);
    expect(d.diverged).toBe(1);
    expect(d.divergedIds).toEqual(["t1"]);
  });

  it("computes calibration and counts unparseable separately", () => {
    const rows: Cb7Row[] = [
      row("t1", "tension", "held", "hold_escalate"),
      row("t2", "tension", "held", "apply_A"),
      row("t3", "tension", "held", null),
    ];
    const c = calibration(rows, "held", "tension");
    expect(c.n).toBe(2);
    expect(c.correct).toBe(1);
    expect(c.unparseable).toBe(1);
  });

  it("charges the hedge tax on settled escalations", () => {
    const rows: Cb7Row[] = [
      row("s1", "settled", "held", "hold_escalate", "apply_A"),
      row("s2", "settled", "held", "apply_A", "apply_A"),
      row("s3", "settled", "collapsed", "apply_A", "apply_A"),
    ];
    expect(hedgeTax(rows, "held")).toEqual({ condition: "held", n: 2, escalated: 1 });
    expect(hedgeTax(rows, "collapsed")).toEqual({ condition: "collapsed", n: 1, escalated: 0 });
  });
});
