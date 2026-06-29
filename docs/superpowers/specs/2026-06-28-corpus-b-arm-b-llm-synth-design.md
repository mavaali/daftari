# Corpus (B) Arm B — LLM-synth foil + blind judge (Design)

**Date:** 2026-06-28
**Status:** Design — pending spec review + user approval, then writing-plans
**Author:** brainstorming session (Claude + Mihir)
**Parent specs:** `2026-06-27-corpus-b-consensus-bench-design.md`, `2026-06-28-corpus-b-co2-arm-a-pilot-design.md`
**Depends on:** CO2 (shipped) — `consensus-content` (`RevertDiff`, the 37-instance diff fixture), `consensus-passage` (`parsePassage` → stale/governing text), `consensus-resolve`, the A/B/C comparison harness shape.

---

## Context

CO2 settled Arm A (recency) and Arm C (daftari): on real data recency fails 33/33
at the ingestion point and daftari is never stale. Arm B answers the obvious
reviewer — **"why not just have an LLM consolidate the stream instead of daftari's
edge-resolution?"** (the ContextForge-with-an-LLM / accumulation-plus-reasoning
position). It is the "beat LLM-consolidation" bar.

The discriminating property under test is not raw accuracy but **never-stale AND
never-minting**: daftari (Arm C) returns the governing source or abstains, and
structurally cannot invent a value. An LLM consolidator can be recency-trapped
(stale), can recover the governing value (LLM beats naive recency — an honest
finding that would narrow daftari's edge to determinism + no-mint), or can
**fabricate** a value. Arm B quantifies where it lands.

## Goal

Measure, on the same stale-trap instances, whether an LLM consolidating the raw
stream (a) is recency-trapped, (b) recovers governing, or (c) **fabricates** — and
whether it mints on a no-evidence probe where daftari abstains. Produce the A/B/C
comparison that pre-empts the LLM-consolidation reviewer.

## Non-goals

- Not a frontier-model benchmark. Arm B = a cheap, reasonable LLM (Haiku). A
  stronger-model spot-check is optional and only if the margin is close.
- No change to Arm A / Arm C / the pilot. New modules only.
- No daftari-client coupling: the bench calls OpenRouter directly (the daftari LLM
  client is Anthropic-only; see [[reference_openrouter_second_rater]]).
- Not the CB4 acquired-edge arm (separate, the publishable contribution).

## Fairness rule (load-bearing)

Arm B sees the **same raw material a stream-memory has** but may reason over it.
Per instance it gets the passage's two recent versions in chronological order —
`[governing (older), stale (latest)]`, extracted by `parsePassage` from the CO2
revert diff — and **nothing else**: no consensus box (that is daftari's oracle
edge), no revert (that is the answer), no edit summaries. This mirrors Arm A's
input exactly, so the contrast is **recency (latest wins) vs LLM reasoning over
the same two versions**.

## Mechanism

**Arm B (per instance):** prompt the LLM with the two versions (chronological,
stale last) and: *"What is the current consensus version of this passage? Reply
with the exact text, or `CANNOT DETERMINE` if you cannot tell."* Temperature 0.
Charitable cannot-determine offered (so a fabrication despite the option is a
strong finding).

**Blind cross-family judge:** given Arm B's free-text answer plus the two
reference texts as **randomized, unlabeled candidates** ("Option 1 / Option 2"),
a non-Anthropic model returns which option the answer expresses, or `neither`, or
`refusal`. Mapped back via the known order → **{governing | stale | abstain |
other}**. The judge never learns which option is "correct" and is not told it is
grading an LLM — that is the blindness. Different family from Arm B so it is an
independent check (the cross-family-agreement discipline).

**Fabrication signal (free):** an answer the judge maps to **`other`** (neither
governing nor stale) is a **minted** value. Arm C structurally never produces
`other`. So `other`-rate is Arm B's fabrication rate on the head-to-head set.

**No-mint probe (sharper):** feed Arm B passage P's versions but ask *"current
consensus on **topic Y**?"* where Y is a real consensus item **not present in P**.
Correct = `CANNOT DETERMINE`. Asserting a Y value = fabricating from priors —
exactly the minting daftari refuses. ~10–15 probes. Judged assert-vs-refuse.

## Architecture (offline-testable; LLM behind a seam)

- `consensus-llm.ts` — `LlmClient { complete(model, system, user): Promise<string> }`
  over OpenRouter (`OPENROUTER_API_KEY`, temp 0, small retry). Tests inject a stub;
  only the real-run script hits the network.
- `consensus-arm-b.ts` — `buildArmBPrompt(versions)` (pure) + `armB(client, versions)`.
- `consensus-judge.ts` — `buildJudgePrompt(answer, candA, candB)` (pure) +
  `parseJudge(resp)` → `{option1|option2|neither|refusal}` + `classify(verdict, order)`
  → governing/stale/abstain/other. Candidate order is a parameter (seedable):
  deterministic in tests, randomized in the run.
- `consensus-armb-run` — script: per instance `armB`→`judge`→`classify`, aggregate
  the A/B/C table. **Network + cost; NOT in the test suite.**

**Models:** Arm B = `anthropic/claude-haiku-4.5`; judge = a cheap non-Anthropic
family (default `google/gemini-2.x-flash`), configurable.

```
CO2 diffs ─► parsePassage ─► [governing, stale] ─► armB(Haiku) ─► free-text answer
                                                          │
                  randomized {governing, stale} candidates ▼
                                              judge(non-Anthropic, blind) ─► verdict
                                                          ▼
                                       classify ─► {governing|stale|abstain|other}
                                                          ▼
                                       A/B/C table + fabrication rate
```

## Metrics

The A/B/C comparison over the scorable stale-trap instances:

| | stale | governing | abstain | other / fabricate |
|---|---|---|---|---|
| Arm A (recency) | 33/33 | 0 | 0 | 0 |
| Arm C (daftari) | 0 | 16/33 | rest | 0 |
| **Arm B (LLM, Haiku)** | ? | ? | ? | ? |

Plus the no-mint probe: Arm B fabricate-rate vs abstain-rate on the absent-topic-Y
probes. Report Arm B's stale-rate (recency-trapped), governing-rate (beats naive
recency), and the two fabrication measures (`other` on traps; assert-Y on probes).

## Outcomes (characterization, stated straight — no contrived kill)

daftari's distinctive claim is being the **only** arm that is both never-stale and
never-minting. Arm B will land in one of:
- **Recency-trapped** (high stale) → daftari's edge over LLM-consolidation is strong.
- **Recovers governing** (high governing, low stale) → LLM beats naive recency; an
  honest finding that narrows daftari's edge to **determinism + no-mint**.
- **Fabricates** (`other` / asserts-Y > 0) → the no-mint differentiator fires.
- **Never-stale AND never-fabricating** on this easy 2-version task → honest partial:
  daftari's edge here is determinism/cost, not correctness. Reported straight; may
  motivate the optional stronger-model or harder-probe spot-check.

## Cost

~45 Haiku + ~45 Gemini-Flash calls, temp 0 ≈ well under $1, one run. Optional
stronger-model spot-check only if the margin is close. (Cost lesson:
[[reference_consolidate_budget_cost]] — bound the run to the fixture set, no loops.)

## Testing (hermetic)

- `buildArmBPrompt` / `buildJudgePrompt` — deterministic string assertions.
- `parseJudge` — parses "Option 1" / "Option 2" / "neither" / "refusal" and
  near-miss phrasings; rejects ambiguous → treated as `neither`.
- `classify` — verdict + candidate order → correct {governing|stale|abstain|other},
  including swapped order (no position bias leak).
- `armB` / judge call paths — via an injected stub `LlmClient` (no network).
- The real run is the script; **no network/LLM in the suite**. Results → a results
  note + the A/B/C table.

## Definition of done

- `consensus-llm`, `consensus-arm-b`, `consensus-judge` implemented + unit-tested
  (hermetic, stubbed client); full `integrations/consensus-bench` suite green, tsc
  clean.
- Real run executed via script over the 33 scorable stale-traps + the no-mint
  probes; A/B/C table + fabrication rates + cost recorded.
- Results note in `docs/superpowers/results/` with the comparison stated straight
  (including the honest-partial outcome if Arm B neither goes stale nor fabricates),
  feeding [[project_corpus_b_consensus_bench]] and [[project_daftari_paper]].

**Next (separate):** pre-cutoff perturbation; the CB4 acquired-edge arm (the
publishable contribution); fuller Arm C localization for no-inline-marker items.
