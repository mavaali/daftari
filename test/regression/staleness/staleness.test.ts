// Tier 1 PR gate: supersession/staleness properties over the pinned CO2 corpus
// (docs/superpowers/results/2026-06-28-corpus-b-co2-pilot.md).
//
// Invariants fail unconditionally — a violation means the product promise
// ("never return a stale value as current") broke, regardless of history.
// Goldens diff against baselines/staleness.json — a flip means behavior
// changed and the PR must re-commit the baseline to prove it was intended.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { armC } from "../../../integrations/consensus-bench/src/consensus-arm-c.js";
import { loadDiffsFromFile } from "../../../integrations/consensus-bench/src/consensus-content.js";
import { parseConsensus } from "../../../integrations/consensus-bench/src/consensus-parse.js";
import { parsePassage } from "../../../integrations/consensus-bench/src/consensus-passage.js";
import { runPilot } from "../../../integrations/consensus-bench/src/consensus-pilot.js";
import { resolveCurrent } from "../../../integrations/consensus-bench/src/consensus-resolve.js";
import { type Baseline, diffBaseline } from "../helpers/baseline.js";

const FIXTURES = resolve("test/regression/fixtures/consensus");
const BASELINE = resolve("test/regression/baselines/staleness.json");

const box = parseConsensus(
  readFileSync(resolve(FIXTURES, "trump-current-consensus.wikitext"), "utf8"),
);
const diffs = loadDiffsFromFile(resolve(FIXTURES, "trump-instance-diffs.json"));

describe("staleness invariants (never baseline-diffed)", () => {
  it("corpus is intact: 14 pinned instances, non-empty consensus box", () => {
    expect(diffs).toHaveLength(14);
    expect(box.length).toBeGreaterThan(0);
  });

  it("never stale: Arm C's answer, when present, is the governing text — never the stale text", () => {
    for (const d of diffs) {
      const passage = parsePassage(d.diffHtml);
      const c = armC(box, d, passage, d.diffHtml);
      expect(["governing", "abstain", "unscorable"]).toContain(c.classification);
      if (c.answer !== undefined) {
        expect(c.answer).toBe(passage.governingText);
        expect(c.answer).not.toBe(passage.staleText);
      }
    }
  });

  it("abstain on dead-ends: every unresolvable box item abstains, even with a scorable passage", () => {
    const deadEnds = box.filter(
      (i) => i.status !== "active" && !resolveCurrent(box, i.num).resolved,
    );
    expect(deadEnds.length).toBeGreaterThan(0); // non-vacuous: corpus must contain dead-ends
    const scorableDiff = diffs.find((d) => parsePassage(d.diffHtml).scorable);
    if (scorableDiff === undefined) throw new Error("corpus has no scorable diff");
    const passage = parsePassage(scorableDiff.diffHtml);
    for (const item of deadEnds) {
      const c = armC(box, { citedNum: item.num }, passage, scorableDiff.diffHtml);
      expect(c.classification).toBe("abstain");
      expect(c.answer).toBeUndefined();
    }
  });
});

describe("staleness goldens (baseline-diffed)", () => {
  it("per-instance Arm C classification and scorability match baselines/staleness.json", () => {
    const { rows } = runPilot(box, diffs);
    const actual: Baseline = {};
    for (const r of rows) {
      actual[String(r.revid)] = {
        citedNum: r.citedNum,
        scorable: r.scorable,
        reason: r.reason ?? null,
        armC: r.armC,
      };
    }
    expect(diffBaseline(BASELINE, actual)).toEqual([]);
  });
});
