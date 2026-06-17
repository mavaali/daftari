# Handoff — Chunk 6: hand-build the decorrelation fixture

**Written:** 2026-06-16. **Branch:** `feat/cortex-loop-stage2` (commits `c3962ee` → `6be1a53`, no PR yet). **Suite:** 1093 pass / 3 skip.

State in one line: the decorrelation report's **math + CLI surface is shipped** ([`6be1a53`](https://github.com/mavaali/daftari/commit/6be1a53)); the **fixture it scores against is not.** Without the fixture, the brief-item-8 kill condition cannot fire meaningfully and the v1 verification gate is decorative.

This handoff exists because **the fixture is intellectual work, not mechanical drudgery** — it needs careful, focused per-pair judgment, not a fatigued sweep. A serviceable-but-noisy fixture would silently re-introduce the failure mode we built the gate to prevent ("convenient measurable instead of right one").

---

## ▶ START HERE

**0. Read first, in this order:**
- `docs/superpowers/specs/2026-06-13-cortex-consolidation-loop.md` §10.3 (the three edge classes) + §4.0 (the verdict space).
- `docs/superpowers/drafts/2026-06-16-cortex-stage-2-component-a-brief.md` item 8 (the gate's kill condition).
- `src/consolidate/decorrelation.ts` — the math + the `DecorrelationFixtureEdge` shape the fixture must match.
- `test/consolidate/decorrelation.test.ts` — the toy fixture in `toyFixture()` shows the SHAPE; the real fixture differs only in scale + truth-labeling care.

**1. Target file:** `tests/fixtures/decorrelation-fixture.json`. JSON shape:

```json
{
  "version": 1,
  "edges": [
    {
      "id": "f-001",
      "fromPath": "<vault-relative path string, ok if it doesn't exist>",
      "toPath": "<vault-relative path string>",
      "fromContent": "<the doc body, plain text or markdown; trim long tails — the LLM gets ≤1500 chars>",
      "toContent": "<same>",
      "truth": "derives" | "depends" | "neither",
      "edgeClass": "forward-temporal" | "backward-causal" | "symmetric",
      "rationale": "<one or two sentences explaining WHY this is the truth label — the LLM does not see this, but a human auditor will>"
    },
    ...
  ]
}
```

`fromPath` / `toPath` don't have to be real files — the runner only uses them as identifiers in the prompt. `fromContent` / `toContent` ARE what the LLM sees; they're what determine whether the truth label is defensible.

**2. Once the fixture lands, run it (uses real LLM calls — paid):**

```
ANTHROPIC_API_KEY=… daftari consolidate \
  --report decorrelation --fixture tests/fixtures/decorrelation-fixture.json
```

Expected cost: ~50 edges × 3 axes = 150 Haiku calls ≈ $0.10-$0.20 per run. The report prints to stdout; exit 0 = PASS, exit 6 = FAIL (multi-model must land inside Stage 2).

---

## What "careful pair-building" actually means

The fixture's job is to surface whether the three prompt-framing axes (forward / reverse / contrast) genuinely decorrelate verdicts or just produce correlated noise. The fixture has to give the panel a real test — that means:

### Coverage targets (50 edges total)

| Truth label | Count | Why |
|---|---|---|
| `derives` | ~20 | The positive class. Half should be OBVIOUS (any axis catches it), half SUBTLE (single axes might miss; majority might catch). |
| `depends` | ~10 | The reverse direction. Tests whether axes can distinguish A→B from B→A. The "reverse" template specifically should outperform "forward" here — if it doesn't, that's a real finding. |
| `neither` | ~20 | **Hard negatives.** The brief calls these out specifically. Pairs that are embedding-near or topically related but **NOT** derivation — co-occurrence, shared vocabulary, citation without dependence. THIS is where the gate earns its keep: a promiscuous panel that says "derives" because the docs are related fails here. |

### Edge-class balance (across the 50)

The §10.3 classes:
- **forward-temporal**: A was written after B and explicitly builds on it (the easiest case; ~40% of `derives`).
- **backward-causal**: A states a conclusion; B is the unstated premise the conclusion rests on (harder; ~30%).
- **symmetric / re-examine**: A and B mutually condition each other; "derives" is contestable. (~30%; truth label is the LABELER'S call — the rationale field carries the load here.)

The hard negatives don't need an edge-class — they're not derivations.

### Pair-construction patterns to use

1. **Real claims from public sources.** Wikipedia, public papers, glossaries, Daftari's own docs. **Post-cutoff** content is best (matches Exp #1's contamination guard; the model can't have seen these pairs in training). Mihir's `experiments/exp1-info-vs-priors/draft_*_novel.json` is a usable source — the "novel" arm is post-cutoff Daftari content.
2. **Diverse domains.** Don't load all 50 from one topic. The decorrelation finding generalizes only if the fixture spans multiple domains (pricing, ML, biology, history — whatever's accessible).
3. **A few KNOWN-HARD-CASES.** Include ~5 pairs where reasonable labelers might disagree. Mark them in `rationale`. If the panel disagrees, that's data — not noise.

### Pair-construction patterns to AVOID

- **Pairs where the truth is "obvious from the path/title alone."** If the title `path/elasticity-affects-pricing.md` derives from `path/elasticity.md` is true by reading the filenames, the LLM doesn't have to think. Strip such hints.
- **Pairs that share unusual rare vocabulary the LLM can latch onto as a shortcut.** "Both docs mention 'epistemic deference' → must be related" — that's a co-occurrence proxy, not derivation.
- **Pairs scraped from a single source.** Editorial style consistency leaks signal.

### The labeling protocol

For each pair, write down in the rationale:
1. What is A's central claim, in your own words?
2. What is B's central claim?
3. Does A's claim STOP MAKING SENSE if B's claim is wrong? (the derivation test — if yes, "derives"; if it works the other way, "depends"; if both stand alone, "neither".)
4. Optional: edge class.

If you can't write step 3 cleanly in one sentence, the pair is ambiguous — either drop it or mark `rationale: "AMBIGUOUS — labeler unsure"` and use it as a known-hard-case.

---

## Why two-rater protocol matters here (and why we're not doing it yet)

Spec §7 mandates **two-rater + adjudication + Cohen's κ** for the recall set. The decorrelation fixture is structurally similar — it's labeled derivation pairs. Same two-rater question applies: **who is the second labeler?**

For chunk 6, single-rater (Mihir) is acceptable because:
- The decorrelation fixture is a calibration tool, not a paper-grade result.
- Its job is to *find out* whether the axis works, not to PROVE it does to readers.
- Surface in the fixture rationales which labels are confident vs hard-case.

When the second rater shows up (the named open dependency from `project_cortex_consolidation_loop.md` / spec §13), this fixture gets the same two-rater pass and a published κ. Until then: rationale fields are the audit trail.

---

## After the fixture lands

1. Run the report against it (paid LLM calls). Read the verdict.
2. **If PASS** (lift ≥ 0.05): commit the fixture + verdict text to a follow-up "Stage 2 verification" doc. Multi-model stays deferred to v1.5 per the brief.
3. **If FAIL** (lift < 0.05): add multi-model as the second axis (haiku + sonnet + opus across the panel, not just three prompt templates against haiku) and re-run. This is brief item 4's deferred refactor — it's the contingency the gate exists to detect.
4. Either way: this unblocks **chunk 7** (adversarial review + PR). The Stage 2 PR description carries the verdict.

---

## What's NOT in this handoff (deliberately)

- The chunk 7 PR opening. That comes AFTER the fixture verdict, because the PR description needs to surface the verdict + cost story.
- The §6.1 efficacy ablation experiment. Different experiment; uses the recall set (Stage 6), not this fixture.
- The Exp #4 (paper-grade axis-decorrelation) that the brief names. That's the larger labeled fixture with multiple model families — the same fixture *could* seed it, but Exp #4 needs the two-rater protocol and a formal report.

---

## Process notes

- Brief still says `factor src/llm/client.ts` (item 4); the build went YAGNI — uses `src/eval/llm.js` directly. The PR description in chunk 7 should call this out so the diff matches the brief; or amend the brief in a small follow-up commit before opening the PR.
- The branch has no PR yet (`feat/cortex-loop-stage2`, last commit `6be1a53`). The fixture commit + chunk 7 review are what justify opening it.
- Memory `project_cortex_consolidation_loop.md` is current as of `6be1a53`; update it after the fixture lands.
