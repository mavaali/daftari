# RESULTS — planted vs detected

Every number below is machine-generated: `fixtures/extraction-report.json`,
`fixtures/distances.json`, `detect-report.json`, `tension-report.json`.
No eyeball verification anywhere in this file.

## Setup

20 planted facts across 4 simulated agent sessions (pricing, ops, support,
docs; `created_at` shifted 90/60/30/7 days), plus ~30 benign filler facts.
LangMem 0.0.30 extraction + consolidation ran first (gpt-5.2 via OpenRouter,
their documented `instructions` parameter used for org-memory extraction,
their consolidation directives kept verbatim). Daftari imported the
post-LangMem store read-only and an agent pass (same model, same
one-pair-at-a-time scope) judged related notes and logged tensions.

## Fixture honesty gate (embedding distance, text-embedding-3-small)

| group | cosine range | requirement |
|---|---|---|
| near-dup pairs (5) | 0.807 – 0.925 | the HIGH group |
| contradiction + temporal pairs (9) | 0.479 – 0.706 | clearly below near-dup min |

Gap between groups: 0.10. The n-way pairs are the most distant (0.479–0.657):
vector similarity alone cannot pair them.

## LangMem consolidation (the control + the indictment)

| check | result |
|---|---|
| near-duplicates merged (V1, its job) | **4/5** (ND1 left duplicated in both runs) |
| contradictions caught (any variant, any run) | **0/14** |
| contradictions SILENTLY DESTROYED (V2 shared namespace) | run 1: **3** (us-east-1, platform-team on-call, the 500 rps Pro guarantee) · run 2: **1** (platform-team on-call) |
| destruction mechanism | recency wins; no flag, no tombstone, no audit trail |
| n-way set after V2 (run 1) | B and C rewritten into one harmonized policy nobody stated; A deleted; 4-way inconsistency gone |
| fabrication kept | extraction invented "Priya Shen (Acme Corp CTO)" — she is Meridian's CTO; consolidation kept it |
| V3 global single-context pass | 43 in → 43 out; changed nothing |

V1 (per-agent namespaces, their documented pattern) preserved all 14
contradiction plants — because namespace-scoped consolidation structurally
cannot see them. Blind or destructive; nothing in between.

## Daftari over the same store

Consolidate loop, run unchanged (49 births, 1,960 LLM calls, $2.62): logged
**zero tensions — correctly.** It builds a derivation graph; detection is
agent work. The instrumented agent pass: 49 `vault_search_related` calls,
**194 pairwise judgments**, one pair per call.

| planted category | detected | notes |
|---|---|---|
| pairwise contradictions (3) | **3/3** | regions, log retention, on-call ownership |
| n-way capacity set (4 nodes) | **4/4 in ONE connected component** | assembled from 3 pairwise tensions (A–B, B–C, A–D) no single call saw together |
| temporal traps (2) | **2/2**, kind=temporal | logged unresolved — not auto-collapsed by recency |
| benign filler (~30 notes) | **0-1 borderline flags per run** (0/9 first run, 1/10 repro run) | the one flag links filler "EU residency is on the roadmap" with the eu-west-2 trust-page plant — an arguably real tension the fixture created by accident; recorded, not suppressed |

Every tension node traces to a store row: `sources:
langgraph-store:<namespace>/<memory-id>` in the note frontmatter.

## The one-line result

Same model, same retrieval scope. LangMem resolved conflicts by deleting
evidence; daftari's ledger let three narrow judgments compose into a 4-way
organizational disagreement visible in one graph. **0/14 caught vs 14/14
preserved-and-surfaced. Dedup is not epistemics.**

## Costs (approximate, full pipeline)

| stage | calls | cost |
|---|---|---|
| LangMem extract+consolidate (×2 full runs) | ~50 gpt-5.2 invocations | ~$4 |
| daftari consolidate (finding: not a detector) | 1,960 haiku-4.5 calls | $2.62 |
| agent detection pass | 194 gpt-5.2 judgments | ~$2 |

## Honest caveats

- Extraction is nondeterministic; plant-survival numbers vary per run (V2
  destroyed 3 plants in run 1, 1 in run 2). Both runs destroyed at least one.
- LangMem's default (user-profile) instructions refused to store
  assistant-stated org facts at all; the org-memory `instructions` override
  was required before their pipeline even saw the facts. Their supported
  customization point, but prompt surgery nonetheless.
- ND1 (API timeout) was never merged by LangMem in either run; we report 4/5,
  not 5/5.
- The detection judge flagged one plant-adjacent pair (hard-cap vs re-shard,
  both derived from the same ops statement) — counted as plant-touching, not
  filler noise, and visible in tension-report.json.
- Detection is also run-variant: 9 tensions in the first pass, 10 in the
  reproducibility rerun (the extra: filler EU-residency-roadmap vs the
  eu-west-2 trust-page plant — see the table note). Tension KIND labels vary
  between runs (factual vs temporal); the assertions never depend on kind
  except for the temporal traps, which flagged as temporal in both runs.
- All required assertions passed in BOTH detection runs: 3/3 pairwise, n-way
  as one component, 2/2 temporal traps.
